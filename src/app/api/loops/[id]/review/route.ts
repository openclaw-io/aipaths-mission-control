import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  getPrimaryExecutionWorkItem,
  isPrimaryExecutionOpen,
  reconcileLoopStatusWithPrimaryExecution,
} from "@/lib/loops/lifecycle";
import {
  getPrimaryExecutionWorkItemLocal,
  reconcileLoopStatusWithPrimaryExecutionLocal,
} from "@/lib/loops/lifecycle-local";

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
    const loopRes = await query<{
      id: string;
      status: string;
      name: string | null;
      summary: string | null;
      description: string | null;
      plan: unknown[] | null;
      metadata: Record<string, unknown> | null;
      owner_agent: string | null;
    }>(`select id, status, name, summary, description, plan, metadata, owner_agent from loops where id = $1 limit 1`, [id]);
    const loop = loopRes.rows[0];
    if (!loop) return NextResponse.json({ error: "Loop not found" }, { status: 404 });

    if (transition.nextStatus === "completed") {
      const primaryExecution = await getPrimaryExecutionWorkItemLocal(id);
      if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
        await reconcileLoopStatusWithPrimaryExecutionLocal(query, {
          loopId: id,
          loopStatus: loop.status,
          primaryExecution,
          actor: actorIdentity,
          reason: "review_completion_blocked_by_open_primary_execution",
          now,
        });
        return NextResponse.json(
          { error: "primary_execution_still_open", workItemId: primaryExecution.workItemId, workItemStatus: primaryExecution.status },
          { status: 409 },
        );
      }
    }

    const metadata = {
      ...((loop.metadata || {}) as Record<string, unknown>),
      review_history: [
        ...((((loop.metadata || {}) as Record<string, unknown>).review_history as unknown[]) || []),
        { action, feedback: feedback || null, acted_at: now, acted_by: actorIdentity },
      ],
    };

    await query(
      `update loops
          set status = $1,
              metadata = $2::jsonb,
              updated_at = $3
        where id = $4`,
      [transition.nextStatus, JSON.stringify(metadata), now, id],
    );
    await query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, transition.eventType, loop.status, transition.nextStatus, actorIdentity, JSON.stringify({ action, feedback: feedback || null }), now],
    );

    if (action === "request_changes") {
      const linksRes = await query<{ work_item_id: string }>(
        `select work_item_id from loop_work_items where loop_id = $1 and relation_type = 'primary_execution' limit 1`,
        [id],
      );
      const workItemId = linksRes.rows[0]?.work_item_id;
      if (workItemId) {
        const existingPayload = (((loop.metadata || {}) as Record<string, unknown>).latest_deliverable_feedback_history as unknown[]) || [];
        const reviewInstruction = [
          `Loop: ${loop.name || id}`,
          loop.summary ? `Summary: ${loop.summary}` : null,
          loop.description ? `Description: ${loop.description}` : null,
          Array.isArray(loop.plan) && loop.plan.length
            ? `Current plan:\n${loop.plan.map((step: unknown, index: number) => {
                const planStep = step && typeof step === "object" && !Array.isArray(step) ? step as { title?: unknown } : {};
                return `- ${index + 1}. ${typeof planStep.title === "string" && planStep.title.trim() ? planStep.title : "Untitled step"}`;
              }).join("\n")}`
            : null,
          "",
          "Review requested changes:",
          feedback || "No explicit feedback provided. Rework the deliverable based on review comments and produce an updated final output.",
          "",
          "Important: produce a fresh updated deliverable, and persist the final answer in payload.result/output/summary when completing the work item.",
        ].filter(Boolean).join("\n");

        await query(
          `update work_items
              set status = 'ready', updated_at = $1, completed_at = null, instruction = $2, payload = $3::jsonb
            where id = $4`,
          [
            now,
            reviewInstruction,
            JSON.stringify({
              review_feedback: feedback || null,
              rework_requested_at: now,
              rework_requested_by: actorIdentity,
              prior_review_feedback: existingPayload,
            }),
            workItemId,
          ],
        );

        try {
          await fetch("http://127.0.0.1:3001/api/work-items/notify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
            },
            body: JSON.stringify({ workItemId, agent: loop.owner_agent, action: "unblocked" }),
          });
        } catch (error) {
          console.error("[loop-review] notify on request_changes failed:", error);
        }
      }
    }

    return NextResponse.json({ ok: true, id, status: transition.nextStatus });
  }

  const supabase = createServiceClient();
  const { data: loop, error: loadError } = await supabase
    .from("loops")
    .select("id, status, name, summary, description, plan, metadata, owner_agent")
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
      const existingPayload = (((loop.metadata || {}) as Record<string, unknown>).latest_deliverable_feedback_history as unknown[]) || [];
      const reviewInstruction = [
        `Loop: ${loop.name || id}`,
        loop.summary ? `Summary: ${loop.summary}` : null,
        loop.description ? `Description: ${loop.description}` : null,
        Array.isArray(loop.plan) && loop.plan.length
          ? `Current plan:\n${loop.plan.map((step: unknown, index: number) => {
              const planStep = step && typeof step === "object" && !Array.isArray(step) ? step as { title?: unknown } : {};
              return `- ${index + 1}. ${typeof planStep.title === "string" && planStep.title.trim() ? planStep.title : "Untitled step"}`;
            }).join("\n")}`
          : null,
        "",
        "Review requested changes:",
        feedback || "No explicit feedback provided. Rework the deliverable based on review comments and produce an updated final output.",
        "",
        "Important: produce a fresh updated deliverable, and persist the final answer in payload.result/output/summary when completing the work item.",
      ].filter(Boolean).join("\n");

      await supabase
        .from("work_items")
        .update({
          status: "ready",
          updated_at: now,
          completed_at: null,
          instruction: reviewInstruction,
          payload: {
            review_feedback: feedback || null,
            rework_requested_at: now,
            rework_requested_by: actorIdentity,
            prior_review_feedback: existingPayload,
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
