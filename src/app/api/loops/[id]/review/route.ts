import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { buildLoopReworkInstruction } from "@/lib/loops/execution-instruction";
import {
  getPrimaryExecutionWorkItem,
  isPrimaryExecutionOpen,
  reconcileLoopStatusWithPrimaryExecution,
} from "@/lib/loops/lifecycle";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await authClient!.auth.getUser();
    user = authResult.data.user;
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actorIdentity = String(user.email || user.id || "local@mission-control");
  const body = await request.json().catch(() => ({}));
  const action = body?.action;
  const feedback = typeof body?.feedback === "string" ? body.feedback.trim() : "";

  const transitions: Record<string, { nextStatus: string; eventType: string }> = {
    request_review: { nextStatus: "in_review", eventType: "loop.review_requested" },
    approve_deliverable: { nextStatus: "completed", eventType: "loop.review_approved" },
    request_changes: { nextStatus: "in_progress", eventType: "loop.review_changes_requested" },
  };

  const transition = transitions[action || ""];
  if (!transition) {
    return NextResponse.json({ error: "Invalid review action" }, { status: 400 });
  }

  const now = new Date().toISOString();

  if (useLocalMode) {
    type LocalLoop = {
      id: string;
      status: string;
      name: string | null;
      summary: string | null;
      description: string | null;
      target_outcome: string | null;
      plan: Array<{ title?: string | null; status?: string | null; notes?: string | null }> | null;
      metadata: Record<string, unknown> | null;
      approval_scope: {
        allowed_actions?: string[] | null;
        forbidden_actions?: string[] | null;
        notes?: string | null;
      } | null;
      owner_agent: string | null;
    };
    type LocalPrimaryExecution = {
      work_item_id: string;
      status: string | null;
      payload: Record<string, unknown> | null;
    };

    const localResult = await withTransaction(async (client) => {
      const loopRes = await client.query<LocalLoop>(
        `select id, status, name, summary, description, target_outcome, plan, metadata, approval_scope, owner_agent
           from loops
          where id = $1
          limit 1
          for update`,
        [id],
      );
      const loop = loopRes.rows[0];
      if (!loop) return { kind: "not_found" as const };

      const primaryRes = await client.query<LocalPrimaryExecution>(
        `select lwi.work_item_id, wi.status, wi.payload
           from loop_work_items lwi
           join work_items wi on wi.id = lwi.work_item_id
          where lwi.loop_id = $1
            and lwi.relation_type = 'primary_execution'
          order by wi.updated_at desc nulls last, wi.created_at desc
          limit 1
          for update of wi`,
        [id],
      );
      const primaryExecution = primaryRes.rows[0] || null;

      if (transition.nextStatus === "completed" && primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
        if (loop.status !== "in_progress") {
          await client.query(
            `update loops set status = 'in_progress', updated_at = $1 where id = $2`,
            [now, id],
          );
          await client.query(
            `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
             values ($1, 'loop.lifecycle_reconciled', $2, 'in_progress', $3, $4::jsonb, $5)`,
            [
              id,
              loop.status,
              actorIdentity,
              JSON.stringify({
                reason: "review_completion_blocked_by_open_primary_execution",
                relation_type: "primary_execution",
                work_item_id: primaryExecution.work_item_id,
                work_item_status: primaryExecution.status,
              }),
              now,
            ],
          );
        }
        return {
          kind: "primary_open" as const,
          workItemId: primaryExecution.work_item_id,
          workItemStatus: primaryExecution.status,
        };
      }

      const loopMetadata = (loop.metadata || {}) as Record<string, unknown>;
      const reviewHistory = Array.isArray(loopMetadata.review_history)
        ? loopMetadata.review_history
        : [];
      const latestReview = reviewHistory.at(-1);
      const latestReviewRecord = latestReview && typeof latestReview === "object" && !Array.isArray(latestReview)
        ? latestReview as Record<string, unknown>
        : null;
      const isReplay = loop.status === transition.nextStatus
        && latestReviewRecord !== null
        && latestReviewRecord.action === action
        && latestReviewRecord.feedback === (feedback || null)
        && latestReviewRecord.acted_by === actorIdentity;

      if (isReplay) {
        return { kind: "success" as const, workItemId: null, ownerAgent: loop.owner_agent };
      }

      const metadata = {
        ...loopMetadata,
        review_history: [
          ...reviewHistory,
          { action, feedback: feedback || null, acted_at: now, acted_by: actorIdentity },
        ],
      };

      await client.query(
        `update loops set status = $1, metadata = $2::jsonb, updated_at = $3 where id = $4`,
        [transition.nextStatus, JSON.stringify(metadata), now, id],
      );
      await client.query(
        `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, transition.eventType, loop.status, transition.nextStatus, actorIdentity, JSON.stringify({ action, feedback: feedback || null }), now],
      );

      let workItemId: string | null = null;
      if (action === "request_changes" && primaryExecution) {
        workItemId = primaryExecution.work_item_id;
        const reviewInstruction = buildLoopReworkInstruction(loop, feedback, id);
        const existingWorkPayload = (primaryExecution.payload || {}) as Record<string, unknown>;
        const loopFeedbackHistory = Array.isArray(loopMetadata.latest_deliverable_feedback_history)
          ? loopMetadata.latest_deliverable_feedback_history
          : [];
        const priorReviewFeedback = Array.isArray(existingWorkPayload.prior_review_feedback)
          ? existingWorkPayload.prior_review_feedback
          : loopFeedbackHistory;
        const workPayload = {
          ...existingWorkPayload,
          review_feedback: feedback || null,
          rework_requested_at: now,
          rework_requested_by: actorIdentity,
          prior_review_feedback: priorReviewFeedback,
        };

        await client.query(
          `update work_items
              set status = 'ready', updated_at = $1, completed_at = null, instruction = $2, payload = $3::jsonb
            where id = $4`,
          [now, reviewInstruction, JSON.stringify(workPayload), workItemId],
        );
      }

      return { kind: "success" as const, workItemId, ownerAgent: loop.owner_agent };
    });

    if (localResult.kind === "not_found") {
      return NextResponse.json({ error: "Loop not found" }, { status: 404 });
    }
    if (localResult.kind === "primary_open") {
      return NextResponse.json(
        { error: "primary_execution_still_open", workItemId: localResult.workItemId, workItemStatus: localResult.workItemStatus },
        { status: 409 },
      );
    }

    if (localResult.workItemId) {
      try {
        const notification = await fetch("http://127.0.0.1:3001/api/work-items/notify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
          },
          body: JSON.stringify({ workItemId: localResult.workItemId, agent: localResult.ownerAgent, action: "unblocked" }),
        });
        if (!notification.ok) {
          console.error(`[loop-review] notify on request_changes failed with HTTP ${notification.status}`);
        }
      } catch (error) {
        console.error("[loop-review] notify on request_changes failed:", error);
      }
    }

    return NextResponse.json({ ok: true, id, status: transition.nextStatus });
  }

  const supabase = createServiceClient();
  const { data: loop, error: loadError } = await supabase
    .from("loops")
    .select("id, status, name, summary, description, target_outcome, plan, metadata, approval_scope, owner_agent")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!loop) {
    return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  }

  if (transition.nextStatus === "completed") {
    const primaryExecution = await getPrimaryExecutionWorkItem(supabase, id);

    if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
      await reconcileLoopStatusWithPrimaryExecution(supabase, {
        loopId: id,
        loopStatus: loop.status,
        primaryExecution,
        actor: actorIdentity,
        reason: "review_completion_blocked_by_open_primary_execution",
        now,
      });

      return NextResponse.json(
        {
          error: "primary_execution_still_open",
          workItemId: primaryExecution.workItemId,
          workItemStatus: primaryExecution.status,
        },
        { status: 409 }
      );
    }
  }

  const metadata = {
    ...((loop.metadata || {}) as Record<string, unknown>),
    review_history: [
      ...((((loop.metadata || {}) as Record<string, unknown>).review_history as unknown[]) || []),
      {
        action,
        feedback: feedback || null,
        acted_at: now,
        acted_by: actorIdentity,
      },
    ],
  };

  const updates: Record<string, unknown> = {
    status: transition.nextStatus,
    metadata,
    updated_at: now,
  };

  if (transition.nextStatus === "completed") {
    updates.last_completed_at = now;
  }

  const { error: updateError } = await supabase
    .from("loops")
    .update(updates)
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("loop_events").insert({
    loop_id: id,
    event_type: transition.eventType,
    from_status: loop.status,
    to_status: transition.nextStatus,
    actor: actorIdentity,
    payload: {
      action,
      feedback: feedback || null,
    },
  });

  if (eventError) {
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  if (action === "request_changes") {
    const { data: links } = await supabase
      .from("loop_work_items")
      .select("work_item_id")
      .eq("loop_id", id)
      .eq("relation_type", "primary_execution")
      .limit(1);

    const workItemId = links?.[0]?.work_item_id;
    if (workItemId) {
      const { data: existingWorkItem } = await supabase
        .from("work_items")
        .select("payload")
        .eq("id", workItemId)
        .maybeSingle();
      const existingWorkPayload = (existingWorkItem?.payload || {}) as Record<string, unknown>;
      const existingFeedback = (((loop.metadata || {}) as Record<string, unknown>).latest_deliverable_feedback_history as unknown[]) || [];
      const reviewInstruction = buildLoopReworkInstruction(loop, feedback, id);

      await supabase
        .from("work_items")
        .update({
          status: "ready",
          updated_at: now,
          completed_at: null,
          instruction: reviewInstruction,
          payload: {
            ...existingWorkPayload,
            review_feedback: feedback || null,
            rework_requested_at: now,
            rework_requested_by: actorIdentity,
            prior_review_feedback: Array.isArray(existingWorkPayload.prior_review_feedback)
              ? existingWorkPayload.prior_review_feedback
              : existingFeedback,
          },
        })
        .eq("id", workItemId);

      try {
        await fetch("http://127.0.0.1:3001/api/work-items/notify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
          },
          body: JSON.stringify({
            workItemId,
            agent: loop.owner_agent,
            action: "unblocked",
          }),
        });
      } catch (error) {
        console.error("[loop-review] notify on request_changes failed:", error);
      }
    }
  }

  return NextResponse.json({ ok: true, id, status: transition.nextStatus });
}
