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
      approved?: boolean;
      can_execute_unattended?: boolean;
      approved_plan_revision_id?: string | null;
      approved_plan_hash?: string | null;
      allowed_actions?: string[] | null;
      forbidden_actions?: string[] | null;
      notes?: string | null;
    } | null;
    owner_agent: string | null;
    workflow_version: number;
    current_plan_revision_id: string | null;
  };
  type LocalPrimaryExecution = {
    work_item_id: string;
    status: string | null;
    payload: Record<string, unknown> | null;
  };

  const localResult = await withTransaction(async (client) => {
    const loopRes = await client.query<LocalLoop>(
      `select id, status, name, summary, description, target_outcome, acceptance_criteria, plan, metadata, approval_scope, owner_agent,
              workflow_version, current_plan_revision_id
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

    if (loop.workflow_version === 2) {
      if (action === "request_changes") return { kind: "v2_changes_unsupported" as const };
      if (loop.status !== "in_review" || !loop.current_plan_revision_id) {
        return { kind: "invalid_transition" as const, error: "invalid_review_state" };
      }
      const revisionResult = await client.query<{ status: string; content_hash: string | null; plan_snapshot: unknown }>(
        "select status,content_hash,plan_snapshot from loop_plan_revisions where id=$1 and loop_id=$2 for update",
        [loop.current_plan_revision_id, id],
      );
      const revision = revisionResult.rows[0];
      const scope = loop.approval_scope || {};
      if (revision?.status !== "approved" || !revision.content_hash || !revision.plan_snapshot
        || scope.approved !== true || scope.can_execute_unattended !== true
        || scope.approved_plan_revision_id !== loop.current_plan_revision_id
        || scope.approved_plan_hash !== revision.content_hash) {
        return { kind: "invalid_transition" as const, error: "v2_approved_revision_mismatch" };
      }
      await client.query(
        `select t.id from loop_tasks t join loop_stages s on s.id=t.stage_id
          where s.plan_revision_id=$1 order by s.position,s.id,t.position,t.id for update of t,s`,
        [loop.current_plan_revision_id],
      );
      await client.query(
        `select r.id from loop_task_runs r join loop_tasks t on t.id=r.task_id
          join loop_stages s on s.id=t.stage_id where s.plan_revision_id=$1 order by t.id,r.id for update of r`,
        [loop.current_plan_revision_id],
      );
      await client.query(
        `select wi.id from work_items wi join loop_task_runs r on r.work_item_id=wi.id
          join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
          where s.plan_revision_id=$1 order by t.id,r.id,wi.id for update of wi`,
        [loop.current_plan_revision_id],
      );
      await client.query(
        `select review.id from loop_task_reviews review join loop_tasks t on t.id=review.task_id
          join loop_stages s on s.id=t.stage_id where s.plan_revision_id=$1 order by t.id,review.id for update of review`,
        [loop.current_plan_revision_id],
      );
      const taskRows = await client.query<{
        id: string; task_status: string; stage_status: string; latest_cycle: number | null; valid: boolean;
      }>(
        `select t.id,t.status task_status,s.status stage_status,impl.quality_cycle latest_cycle,
                (impl.id is not null and impl.status='succeeded' and impl.artifact_sha is not null
                 and impl.server_session_id is not null and wi.status='done'
                 and wi.payload->>'execution_attempt_id' IS NOT DISTINCT FROM impl.execution_attempt_id::text
                 and wi.payload->>'runtime_contract' IS NOT DISTINCT FROM 'fresh_review_v1'
                 and wi.payload->>'run_role' IS NOT DISTINCT FROM 'implementation'
                 and wi.payload->>'plan_revision_id' IS NOT DISTINCT FROM $1::text
                 and wi.payload->>'plan_hash' IS NOT DISTINCT FROM $2
                 and review.status='approved' and review.reviewed_sha IS NOT DISTINCT FROM impl.artifact_sha
                 and review.reviewer_session_id is not null
                 and review.reviewer_session_id is distinct from impl.server_session_id
                 and rr.status='succeeded' and rr.run_role='review'
                 and rr.quality_cycle IS NOT DISTINCT FROM impl.quality_cycle and rr.target_run_id IS NOT DISTINCT FROM impl.id
                 and rr.target_sha IS NOT DISTINCT FROM impl.artifact_sha and rr.server_session_id IS NOT DISTINCT FROM review.reviewer_session_id
                 and rwi.status='done'
                 and (not (t.metadata ? 'qa_policy') or (public.qa_policy_is_valid(t.metadata->'qa_policy') and (
                   t.metadata->'qa_policy'->'required'='false'::jsonb or exists (
                   select 1 from loop_task_runs qr join qa_executions qe on qe.qa_run_id=qr.id and qe.task_id=t.id
                   join work_items qwi on qwi.id=qr.work_item_id
                   where qr.run_role='qa' and qr.quality_cycle IS NOT DISTINCT FROM impl.quality_cycle
                     and qr.target_run_id IS NOT DISTINCT FROM impl.id
                     and qr.target_sha IS NOT DISTINCT FROM impl.artifact_sha and qr.status='succeeded' and qwi.status='done'
                     and qe.status='succeeded' and qe.target_run_id IS NOT DISTINCT FROM impl.id
                     and qe.target_sha IS NOT DISTINCT FROM impl.artifact_sha
                     and jsonb_typeof(qe.result->'verdict')='string' and qe.result->>'verdict' IS NOT DISTINCT FROM 'pass'
                     and jsonb_typeof(qe.result->'tested_sha')='string' and qe.result->>'tested_sha' IS NOT DISTINCT FROM impl.artifact_sha
                     and qe.policy_hash IS NOT DISTINCT FROM qwi.payload->>'policy_hash'
                     and qwi.payload->'qa_policy' IS NOT DISTINCT FROM t.metadata->'qa_policy'
                     and public.qa_result_is_valid(qe.result,qe.target_sha,qwi.payload->'qa_policy')
                     and qe.result_hash IS NOT DISTINCT FROM public.qa_jsonb_sha256(qe.result)))))) valid
           from loop_tasks t join loop_stages s on s.id=t.stage_id
           left join lateral (
             select candidate.* from loop_task_runs candidate where candidate.task_id=t.id and candidate.run_role='implementation'
             order by candidate.quality_cycle desc,candidate.created_at desc,candidate.id desc limit 1
           ) impl on true
           left join work_items wi on wi.id=impl.work_item_id
           left join loop_task_reviews review on review.task_run_id=impl.id and review.quality_cycle=impl.quality_cycle
           left join loop_task_runs rr on rr.id=review.review_run_id and rr.task_id=t.id
           left join work_items rwi on rwi.id=rr.work_item_id
          where s.plan_revision_id=$1::uuid order by t.id`,
        [loop.current_plan_revision_id, revision.content_hash],
      );
      const mapIntegrity = await client.query<{ active_runs: number; active_items: number; extra_count: number; missing_count: number }>(
        `select
          (select count(*)::int from loop_task_runs r join loop_tasks t on t.id=r.task_id
            join loop_stages s on s.id=t.stage_id where s.plan_revision_id=$1 and r.status in ('queued','running')) active_runs,
          (select count(*)::int from work_items wi where wi.loop_id=$2 and wi.payload->>'runtime_contract'='fresh_review_v1'
            and wi.status in ('ready','in_progress')) active_items,
          (select count(*)::int from loop_work_items lwi where lwi.loop_id=$2 and lwi.relation_type='task_execution'
            and not exists (select 1 from loop_task_runs r join loop_tasks t on t.id=r.task_id
              join loop_stages s on s.id=t.stage_id where r.work_item_id=lwi.work_item_id and s.plan_revision_id=$1)) extra_count,
          (select count(*)::int from loop_task_runs r join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
            where s.plan_revision_id=$1 and (r.work_item_id is null or not exists (
              select 1 from loop_work_items lwi where lwi.loop_id=$2 and lwi.work_item_id=r.work_item_id and lwi.relation_type='task_execution'))) missing_count`,
        [loop.current_plan_revision_id, id],
      );
      const integrity = mapIntegrity.rows[0];
      const consistent = taskRows.rows.length > 0
        && taskRows.rows.every((task) => task.task_status === "completed" && task.stage_status === "completed"
          && task.latest_cycle !== null && task.valid === true)
        && integrity?.active_runs === 0 && integrity.active_items === 0
        && integrity.extra_count === 0 && integrity.missing_count === 0;
      if (!consistent) return { kind: "invalid_transition" as const, error: "v2_task_runs_inconsistent" };

      const response = { ok: true, id, status: "completed", decision_id: decisionId };
      const reviewHistory = Array.isArray(loopMetadata.review_history) ? loopMetadata.review_history : [];
      const metadata = {
        ...loopMetadata,
        review_history: [...reviewHistory, { decision_id: decisionId, action, feedback: feedback || null, acted_at: now, acted_by: actorIdentity }],
        decision_ledger: [...decisionLedger, {
          decision_id: decisionId, decision_type: "deliverable_review", request: decisionRequest,
          response, created_at: now,
        }],
      };
      await client.query(
        `update loops set status='completed',metadata=$1::jsonb,
                updated_at=$2,row_version=row_version+1
          where id=$3 and status='in_review' and current_plan_revision_id=$4`,
        [JSON.stringify(metadata), now, id, loop.current_plan_revision_id],
      );
      await client.query(
        `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
         values ($1,'loop.review_approved','in_review','completed',$2,$3::jsonb,$4)`,
        [id, actorIdentity, JSON.stringify({ decision_id: decisionId, action, feedback: feedback || null, workflow_version: 2 }), now],
      );
      return { kind: "success" as const, response };
    }

    // Explicit V1 branch retains primary_execution deliverable semantics.
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
  if (localResult.kind === "v2_changes_unsupported") {
    return NextResponse.json({ error: "v2_deliverable_changes_not_implemented" }, { status: 501 });
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
