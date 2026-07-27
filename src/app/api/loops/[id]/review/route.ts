import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { buildLoopReworkInstruction } from "@/lib/loops/execution-instruction";

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

  // A Loop review transition can update the Loop, event history and primary
  // execution together. Supabase REST calls cannot make those writes atomic,
  // so cloud mode is deliberately unavailable instead of claiming partial
  // success. Local Postgres below is the sole supported write architecture.
  if (!useLocalMode) {
    return NextResponse.json({ error: "cloud_loop_review_writes_not_supported" }, { status: 503 });
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

      // Exact review replays are valid after the first request has already
      // changed both source rows. Any genuinely new action must still satisfy
      // the source-state matrix below.
      if (action === "approve_deliverable" || action === "request_changes") {
        if (loop.status !== "in_review") {
          return { kind: "invalid_transition" as const, error: "invalid_review_state" };
        }
        if (!primaryExecution) {
          return { kind: "invalid_transition" as const, error: "primary_execution_missing" };
        }
        if (primaryExecution.status !== "done") {
          return {
            kind: "invalid_transition" as const,
            error: "primary_execution_not_done",
            workItemId: primaryExecution.work_item_id,
            workItemStatus: primaryExecution.status,
          };
        }
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
        const workPayload: Record<string, unknown> = { ...existingWorkPayload };
        for (const key of [
          "dispatch_session_id",
          "dispatch_session_key",
          "dispatch_session_started_at",
          "dispatch_wake_mode",
          "dispatch_cron_job_id",
          "dispatch_cron_run_id",
          "dispatch_completed_at",
          "dispatch_failure_reason",
          "dispatch_retry_scheduled_for",
          "dispatch_escalation",
          "claimed_at",
          "claimed_by",
          "error",
        ]) {
          delete workPayload[key];
        }
        const currentGeneration = Number(existingWorkPayload.execution_generation);
        Object.assign(workPayload, {
          review_feedback: feedback || null,
          rework_requested_at: now,
          rework_requested_by: actorIdentity,
          prior_review_feedback: priorReviewFeedback,
          execution_attempt_id: randomUUID(),
          execution_generation: Number.isInteger(currentGeneration) && currentGeneration >= 0
            ? currentGeneration + 1
            : 1,
          dispatch_state: "ready_for_rework",
          dispatch_attempts: 0,
          wake_failure_count: 0,
        });

        await client.query(
          `update work_items
              set status = 'ready', updated_at = $1, started_at = null, completed_at = null, instruction = $2, payload = $3::jsonb
            where id = $4`,
          [now, reviewInstruction, JSON.stringify(workPayload), workItemId],
        );
      }

      return { kind: "success" as const, workItemId, ownerAgent: loop.owner_agent };
    });

    if (localResult.kind === "not_found") {
      return NextResponse.json({ error: "Loop not found" }, { status: 404 });
    }
    if (localResult.kind === "invalid_transition") {
      return NextResponse.json(
        {
          error: localResult.error,
          ...("workItemId" in localResult
            ? { workItemId: localResult.workItemId, workItemStatus: localResult.workItemStatus }
            : {}),
        },
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

  // Unreachable because cloud mode returned fail-closed above. Keep a final
  // defensive response if the local-mode predicate ever stops being stable.
  return NextResponse.json({ error: "cloud_loop_review_writes_not_supported" }, { status: 503 });
}
