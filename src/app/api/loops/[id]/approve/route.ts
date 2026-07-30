import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ApprovalAction = "approve" | "rework";

type PlanOperation = {
  type: "append_step";
  title: string;
  notes: string | null;
};

type DecisionLedgerEntry = {
  decision_id?: unknown;
  decision_type?: unknown;
  request?: unknown;
  response?: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDecisionId(value: unknown) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function parsePlanOperations(value: unknown): PlanOperation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const operations: PlanOperation[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const operation = candidate as Record<string, unknown>;
    if (operation.type !== "append_step") return null;
    const title = typeof operation.title === "string" ? operation.title.trim() : "";
    if (!title) return null;
    if (operation.notes !== undefined && operation.notes !== null && typeof operation.notes !== "string") return null;
    const notes = typeof operation.notes === "string" && operation.notes.trim() ? operation.notes.trim() : null;
    operations.push({ type: "append_step", title, notes });
  }
  return operations;
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

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  if (body?.action !== "approve" && body?.action !== "rework") {
    return NextResponse.json({ error: "Invalid approval action" }, { status: 400 });
  }
  if (typeof body?.queue !== "boolean") {
    return NextResponse.json({ error: "queue_must_be_boolean" }, { status: 400 });
  }
  const decisionId = parseDecisionId(body?.decision_id);
  if (!decisionId) {
    return NextResponse.json({ error: "decision_id_must_be_uuid" }, { status: 400 });
  }

  const action: ApprovalAction = body.action;
  const queue = body.queue;
  const requestedPlanRevisionId = parseDecisionId(body?.plan_revision_id);
  const requestedPlanHash = typeof body?.plan_hash === "string" && /^[0-9a-f]{64}$/.test(body.plan_hash)
    ? body.plan_hash
    : null;
  if (action === "rework" && queue) {
    return NextResponse.json({ error: "rework_cannot_be_queued" }, { status: 400 });
  }
  const comment = typeof body?.comment === "string" && body.comment.trim() ? body.comment.trim() : null;
  const planOperations = action === "rework" ? parsePlanOperations(body?.plan_operations) : [];
  if (action === "rework" && !planOperations) {
    // Rework is a structured write contract. Never move the Loop to planning
    // based on prose that a later worker may or may not be able to interpret.
    return NextResponse.json({ error: "unsupported_plan_operations" }, { status: 400 });
  }
  if (action === "approve" && body?.plan_operations !== undefined && body?.plan_operations !== null) {
    return NextResponse.json({ error: "plan_operations_only_supported_for_rework" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const nextStatus = action === "rework" ? "planning" : queue ? "queued" : "approved";
  const baseDecisionRequest = {
    decision_type: "plan_approval",
    loop_id: id,
    action,
    queue,
    comment,
    plan_operations: planOperations || [],
    acted_by: actorIdentity,
  };

  // Supabase REST cannot atomically update the Loop and append its audit event.
  if (!useLocalMode) {
    return NextResponse.json({ error: "cloud_loop_approval_writes_not_supported" }, { status: 503 });
  }

  const result = await withTransaction(async (client) => {
    type LoopDecisionRow = {
      id: string;
      status: string;
      workflow_version: number;
      current_plan_revision_id: string | null;
      approval_scope: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
      last_approved_at: string | Date | null;
    };
    const loopRows = await client.query<LoopDecisionRow>(
      `select id, status, workflow_version, current_plan_revision_id, approval_scope, metadata, last_approved_at
         from loops
        where id = $1
        limit 1
        for update`,
      [id],
    );
    const loop = loopRows.rows[0];
    if (!loop) return { kind: "missing" as const };
    const decisionRequest = loop.workflow_version === 2
      ? { ...baseDecisionRequest, plan_revision_id: requestedPlanRevisionId, plan_hash: requestedPlanHash }
      : baseDecisionRequest;

    const loopMetadata = loop.metadata || {};
    const decisionLedger = asDecisionLedger(loopMetadata);
    const persisted = decisionLedger.find((entry) => entry.decision_id === decisionId);
    if (persisted) {
      if (persisted.decision_type !== "plan_approval" || !samePayload(persisted.request, decisionRequest)) {
        return { kind: "idempotency_conflict" as const };
      }
      return { kind: "replay" as const, response: persisted.response as Record<string, unknown> };
    }

    if (loop.workflow_version === 2) {
      // The serial V2 runtime has no plan revision editor yet. Return without a
      // write so rework can never leave a half-mutated revision/Loop pair.
      if (action === "rework") return { kind: "v2_rework_unsupported" as const };
      if (!queue) return { kind: "v2_queue_required" as const };
      if (loop.status !== "needs_approval" || !loop.current_plan_revision_id) {
        return { kind: "transition_conflict" as const, status: loop.status };
      }
      if (!requestedPlanRevisionId || !requestedPlanHash) return { kind: "v2_exact_plan_required" as const };
      if (requestedPlanRevisionId !== loop.current_plan_revision_id) {
        return { kind: "v2_revision_conflict" as const, status: "stale_revision" };
      }
      const revisionResult = await client.query<{
        id: string; status: string; content_hash: string | null; plan_snapshot: Record<string, unknown> | null;
      }>(
        `select id,status,content_hash,plan_snapshot from loop_plan_revisions
          where id=$1 and loop_id=$2
          limit 1 for update`,
        [loop.current_plan_revision_id, id],
      );
      const revision = revisionResult.rows[0];
      if (!revision || revision.status !== "pending_approval") {
        return { kind: "v2_revision_conflict" as const, status: revision?.status || "missing" };
      }
      if (!revision.plan_snapshot || revision.content_hash !== requestedPlanHash
        || sha256(revision.plan_snapshot) !== revision.content_hash) {
        return { kind: "v2_plan_integrity_conflict" as const };
      }
      const graphRows = await client.query<{
        stage_key: string; stage_title: string; stage_description: string | null; stage_position: number;
        task_key: string; task_title: string; task_description: string | null; task_position: number;
        assignee_agent: string | null; task_metadata: Record<string, unknown> | null;
        dependencies: Array<{ key: string; type: string }>;
      }>(
        `select s.key stage_key,s.title stage_title,s.description stage_description,s.position stage_position,
                t.key task_key,t.title task_title,t.description task_description,t.position task_position,t.assignee_agent,
                t.metadata task_metadata,
                coalesce(jsonb_agg(jsonb_build_object('key',dt.key,'type',d.dependency_type)
                  order by dt.key,d.dependency_type) filter (where d.task_id is not null),'[]'::jsonb) dependencies
           from loop_stages s join loop_tasks t on t.stage_id=s.id
           left join loop_task_dependencies d on d.task_id=t.id
           left join loop_tasks dt on dt.id=d.depends_on_task_id
          where s.plan_revision_id=$1
          group by s.id,t.id order by s.position,s.id,t.position,t.id`,
        [revision.id],
      );
      const snapshot = asRecord(revision.plan_snapshot);
      const snapshotStages = Array.isArray(snapshot.stages) ? snapshot.stages.map(asRecord) : [];
      const stages: Array<Record<string, unknown>> = [];
      for (const row of graphRows.rows) {
        let stage = stages.find((candidate) => candidate.key === row.stage_key) as Record<string, unknown> | undefined;
        if (!stage) {
          stage = { key: row.stage_key, title: row.stage_title, description: row.stage_description,
            position: row.stage_position, tasks: [] };
          stages.push(stage);
        }
        const task: Record<string, unknown> = { key: row.task_key, title: row.task_title,
          description: row.task_description, assignee_agent: row.assignee_agent, position: row.task_position,
          dependencies: row.dependencies };
        const snapshotStage = snapshotStages.find((candidate) => candidate.key === row.stage_key);
        const snapshotTask = (Array.isArray(snapshotStage?.tasks) ? snapshotStage.tasks : []).map(asRecord)
          .find((candidate) => candidate.key === row.task_key);
        const taskMetadata = asRecord(row.task_metadata);
        if ((snapshotTask && Object.hasOwn(snapshotTask, "qa_policy")) || Object.hasOwn(taskMetadata, "qa_policy")) {
          task.qa_policy = taskMetadata.qa_policy;
        }
        (stage.tasks as Array<unknown>).push(task);
      }
      if (!samePayload(stages, snapshot.stages)) {
        return { kind: "v2_plan_integrity_conflict" as const };
      }
      const approvedPolicy = asRecord(asRecord(revision.plan_snapshot).approval_policy);
      const approvalScope = {
        ...approvedPolicy, approved: true, approved_by: actorIdentity,
        approved_at: now, can_execute_unattended: true,
        approved_plan_revision_id: revision.id, approved_plan_hash: revision.content_hash,
      };
      const response = { ok: true, id, status: "queued", decision_id: decisionId,
        plan_revision_id: revision.id, plan_hash: revision.content_hash };
      const decisionIdentity = {
        decision_id: decisionId, action, queue: true, comment, plan_operations: [],
        acted_at: now, acted_by: actorIdentity, from_status: loop.status,
        to_status: "queued", plan_revision_id: revision.id, plan_hash: revision.content_hash,
      };
      const metadata = {
        ...loopMetadata,
        last_plan_decision: decisionIdentity,
        decision_ledger: [...decisionLedger, {
          decision_id: decisionId, decision_type: "plan_approval", request: decisionRequest,
          response, created_at: now,
        }],
      };
      await client.query(
        `update loop_plan_revisions
            set status='approved', approved_by=$1, approved_at=$2, updated_at=$2
          where id=$3 and loop_id=$4 and status='pending_approval'`,
        [actorIdentity, now, revision.id, id],
      );
      await client.query(
        `update loops
            set status='queued', approval_scope=$1::jsonb, metadata=$2::jsonb,
                last_approved_at=$3, updated_at=$3, row_version=row_version+1
          where id=$4 and status='needs_approval' and current_plan_revision_id=$5`,
        [JSON.stringify(approvalScope), JSON.stringify(metadata), now, id, revision.id],
      );
      await client.query(
        `insert into loop_events (loop_id,event_type,from_status,to_status,actor,payload,created_at)
         values ($1,'loop.queued','needs_approval','queued',$2,$3::jsonb,$4)`,
        [id, actorIdentity, JSON.stringify({ mode: "manual", workflow_version: 2, ...decisionIdentity }), now],
      );
      return { kind: "success" as const, response };
    }

    const allowed = action === "rework"
      ? ["needs_approval", "approved", "queued"].includes(loop.status)
      : loop.status === "needs_approval" || (queue && loop.status === "approved");
    if (!allowed) return { kind: "transition_conflict" as const, status: loop.status };

    const isInitialApproval = action === "approve" && loop.status === "needs_approval";
    const approvalScope = action === "rework"
      ? { ...(loop.approval_scope || {}), approved: false, approved_by: null, approved_at: null, can_execute_unattended: false }
      : isInitialApproval
        ? { ...(loop.approval_scope || {}), approved: true, approved_by: actorIdentity, approved_at: now, can_execute_unattended: true }
        : loop.approval_scope || {};
    const decisionIdentity = {
      decision_id: decisionId,
      action,
      queue,
      comment,
      plan_operations: planOperations || [],
      acted_at: now,
      acted_by: actorIdentity,
      from_status: loop.status,
      to_status: nextStatus,
    };
    const response = { ok: true, id, status: nextStatus, decision_id: decisionId };
    const metadata = {
      ...loopMetadata,
      ...(action === "rework" ? {
        plan_rework_context: {
          status: "pending",
          feedback: comment,
          plan_operations: planOperations,
          requested_at: now,
          requested_by: actorIdentity,
          source_status: loop.status,
          decision_id: decisionId,
        },
      } : {}),
      last_plan_decision: decisionIdentity,
      decision_ledger: [
        ...decisionLedger,
        {
          decision_id: decisionId,
          decision_type: "plan_approval",
          request: decisionRequest,
          response,
          created_at: now,
        },
      ],
    };
    const lastApprovedAt = isInitialApproval ? now : loop.last_approved_at;

    await client.query(
      `update loops
          set status = $1,
              approval_scope = $2::jsonb,
              metadata = $3::jsonb,
              last_approved_at = $4,
              updated_at = $5
        where id = $6`,
      [nextStatus, JSON.stringify(approvalScope), JSON.stringify(metadata), lastApprovedAt, now, id],
    );
    await client.query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        action === "rework" ? "loop.plan_rework_requested" : queue ? "loop.queued" : "loop.approved",
        loop.status,
        nextStatus,
        actorIdentity,
        JSON.stringify({ mode: "manual", ...decisionIdentity }),
        now,
      ],
    );
    return { kind: "success" as const, response };
  });

  if (result.kind === "missing") return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  if (result.kind === "idempotency_conflict") {
    return NextResponse.json({ error: "decision_id_payload_conflict" }, { status: 409 });
  }
  if (result.kind === "v2_rework_unsupported") {
    return NextResponse.json({ error: "v2_plan_rework_not_implemented" }, { status: 501 });
  }
  if (result.kind === "v2_queue_required") {
    return NextResponse.json({ error: "v2_approval_must_queue" }, { status: 400 });
  }
  if (result.kind === "v2_exact_plan_required") {
    return NextResponse.json({ error: "v2_exact_plan_revision_and_hash_required" }, { status: 400 });
  }
  if (result.kind === "v2_plan_integrity_conflict") {
    return NextResponse.json({ error: "v2_plan_snapshot_integrity_conflict" }, { status: 409 });
  }
  if (result.kind === "v2_revision_conflict") {
    return NextResponse.json({ error: "v2_plan_revision_approval_conflict", revisionStatus: result.status }, { status: 409 });
  }
  if (result.kind === "transition_conflict") {
    return NextResponse.json({ error: "approval_transition_conflict", currentStatus: result.status }, { status: 409 });
  }
  return NextResponse.json(result.response);
}
