import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { buildLoopReworkInstruction } from "@/lib/loops/execution-instruction";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DecisionLedgerEntry = {
  decision_id?: unknown;
  decision_type?: unknown;
  request?: unknown;
  response?: unknown;
};

function parseDecisionId(value: unknown) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function asDecisionLedger(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.decision_ledger)
    ? metadata.decision_ledger.filter((entry): entry is DecisionLedgerEntry => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function samePayload(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function reopenV1PlanWithoutDeliverableMapping(
  plan: Array<{ title?: string | null; status?: string | null; notes?: string | null }> | null,
) {
  if (!Array.isArray(plan)) return [];
  return plan.map((step) => (
    typeof step?.title === "string" && step.title.trim()
      ? { ...step, status: "pending" }
      : step
  ));
}

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
    approve_deliverable: { nextStatus: "completed", eventType: "loop.review_approved" },
    request_changes: { nextStatus: "in_progress", eventType: "loop.review_changes_requested" },
  };

  const transition = transitions[action || ""];
  if (!transition) {
    return NextResponse.json({ error: "Invalid review action" }, { status: 400 });
  }
  const decisionId = parseDecisionId(body?.decision_id);
  if (!decisionId) {
    return NextResponse.json({ error: "decision_id_must_be_uuid" }, { status: 400 });
  }

  const decisionRequest = {
    decision_type: "deliverable_review",
    loop_id: id,
    action,
    feedback: feedback || null,
    acted_by: actorIdentity,
  };

  // A Loop review transition can update the Loop, event history and primary
  // execution together. Supabase REST calls cannot make those writes atomic,
  // so cloud mode is deliberately unavailable instead of claiming partial
  // success. Local Postgres below is the sole supported write architecture.
  if (!useLocalMode) {
    return NextResponse.json({ error: "cloud_loop_review_writes_not_supported" }, { status: 503 });
  }

  const now = new Date().toISOString();
  type LocalLoop = {
    id: string;
    status: string;
    name: string | null;
    summary: string | null;
    description: string | null;
    target_outcome: string | null;
    acceptance_criteria: string[] | null;
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
      `select id, status, name, summary, description, target_outcome, acceptance_criteria, plan, metadata, approval_scope, owner_agent
         from loops
        where id = $1
        limit 1
        for update`,
      [id],
    );
    const loop = loopRes.rows[0];
    if (!loop) return { kind: "not_found" as const };

    const loopMetadata = (loop.metadata || {}) as Record<string, unknown>;
    const decisionLedger = asDecisionLedger(loopMetadata);
    const persisted = decisionLedger.find((entry) => entry.decision_id === decisionId);
    if (persisted) {
      if (persisted.decision_type !== "deliverable_review" || !samePayload(persisted.request, decisionRequest)) {
        return { kind: "idempotency_conflict" as const };
      }
      return {
        kind: "replay" as const,
        response: persisted.response as Record<string, unknown>,
      };
    }

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

    const reviewHistory = Array.isArray(loopMetadata.review_history)
      ? loopMetadata.review_history
      : [];
    const reopenedPlan = action === "request_changes"
      ? reopenV1PlanWithoutDeliverableMapping(loop.plan)
      : null;
    const reopenedPlanSteps = reopenedPlan
      ? reopenedPlan.filter((step, index) => step?.status === "pending" && loop.plan?.[index]?.status !== "pending").length
      : 0;

    const workItemId = action === "request_changes" ? primaryExecution.work_item_id : null;
    const response = { ok: true, id, status: transition.nextStatus, decision_id: decisionId };
    const metadata = {
      ...loopMetadata,
      review_history: [
        ...reviewHistory,
        { decision_id: decisionId, action, feedback: feedback || null, acted_at: now, acted_by: actorIdentity },
      ],
      decision_ledger: [
        ...decisionLedger,
        {
          decision_id: decisionId,
          decision_type: "deliverable_review",
          request: decisionRequest,
          response,
          created_at: now,
        },
      ],
    };

    if (reopenedPlan) {
      await client.query(
        `update loops set status = $1, metadata = $2::jsonb, plan = $3::jsonb, updated_at = $4 where id = $5`,
        [transition.nextStatus, JSON.stringify(metadata), JSON.stringify(reopenedPlan), now, id],
      );
    } else {
      await client.query(
        `update loops set status = $1, metadata = $2::jsonb, updated_at = $3 where id = $4`,
        [transition.nextStatus, JSON.stringify(metadata), now, id],
      );
    }
    await client.query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, transition.eventType, loop.status, transition.nextStatus, actorIdentity, JSON.stringify({
        decision_id: decisionId,
        action,
        feedback: feedback || null,
        ...(action === "request_changes" ? {
          plan_reopen_policy: "all_non_empty_steps_v1_no_mapping",
          reopened_plan_steps: reopenedPlanSteps,
        } : {}),
      }), now],
    );

    if (action === "request_changes") {
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
        rework_decision_id: decisionId,
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

    return { kind: "success" as const, response };
  });

  if (localResult.kind === "not_found") {
    return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  }
  if (localResult.kind === "idempotency_conflict") {
    return NextResponse.json({ error: "decision_id_payload_conflict" }, { status: 409 });
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

  return NextResponse.json(localResult.response);
}
