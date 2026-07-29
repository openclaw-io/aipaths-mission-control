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
  const decisionRequest = {
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
      approval_scope: Record<string, unknown> | null;
      metadata: Record<string, unknown> | null;
      last_approved_at: string | Date | null;
    };
    const loopRows = await client.query<LoopDecisionRow>(
      `select id, status, approval_scope, metadata, last_approved_at
         from loops
        where id = $1
        limit 1
        for update`,
      [id],
    );
    const loop = loopRows.rows[0];
    if (!loop) return { kind: "missing" as const };

    const loopMetadata = loop.metadata || {};
    const decisionLedger = asDecisionLedger(loopMetadata);
    const persisted = decisionLedger.find((entry) => entry.decision_id === decisionId);
    if (persisted) {
      if (persisted.decision_type !== "plan_approval" || !samePayload(persisted.request, decisionRequest)) {
        return { kind: "idempotency_conflict" as const };
      }
      return { kind: "replay" as const, response: persisted.response as Record<string, unknown> };
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
  if (result.kind === "transition_conflict") {
    return NextResponse.json({ error: "approval_transition_conflict", currentStatus: result.status }, { status: 409 });
  }
  return NextResponse.json(result.response);
}
