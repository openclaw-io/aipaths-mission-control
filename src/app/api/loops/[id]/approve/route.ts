import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ApprovalAction = "approve" | "rework";

type PersistedDecision = {
  action?: unknown;
  queue?: unknown;
  comment?: unknown;
  acted_by?: unknown;
  from_status?: unknown;
  to_status?: unknown;
};

function isExactReplay(
  persisted: PersistedDecision | null,
  request: { action: ApprovalAction; queue: boolean; comment: string | null; actor: string; toStatus: string },
) {
  return persisted?.action === request.action
    && persisted.queue === request.queue
    && persisted.comment === request.comment
    && persisted.acted_by === request.actor
    && persisted.to_status === request.toStatus;
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

  const action: ApprovalAction = body.action;
  const queue = body.queue;
  if (action === "rework" && queue) {
    return NextResponse.json({ error: "rework_cannot_be_queued" }, { status: 400 });
  }
  const comment = typeof body?.comment === "string" && body.comment.trim() ? body.comment.trim() : null;
  const now = new Date().toISOString();
  const nextStatus = action === "rework" ? "planning" : queue ? "queued" : "approved";

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
    const persistedDecision = loopMetadata.last_plan_decision;
    const persistedRecord = persistedDecision && typeof persistedDecision === "object" && !Array.isArray(persistedDecision)
      ? persistedDecision as PersistedDecision
      : null;
    if (loop.status === nextStatus) {
      return isExactReplay(persistedRecord, {
        action,
        queue,
        comment,
        actor: actorIdentity,
        toStatus: nextStatus,
      })
        ? { kind: "replay" as const }
        : { kind: "conflict" as const, status: loop.status };
    }

    const allowed = action === "rework"
      ? ["needs_approval", "approved", "queued"].includes(loop.status)
      : loop.status === "needs_approval" || (queue && loop.status === "approved");
    if (!allowed) return { kind: "conflict" as const, status: loop.status };

    const isInitialApproval = action === "approve" && loop.status === "needs_approval";
    const approvalScope = action === "rework"
      ? { ...(loop.approval_scope || {}), approved: false, approved_by: null, approved_at: null, can_execute_unattended: false }
      : isInitialApproval
        ? { ...(loop.approval_scope || {}), approved: true, approved_by: actorIdentity, approved_at: now, can_execute_unattended: true }
        : loop.approval_scope || {};
    const decisionIdentity = {
      action,
      queue,
      comment,
      acted_at: now,
      acted_by: actorIdentity,
      from_status: loop.status,
      to_status: nextStatus,
    };
    const metadata = {
      ...loopMetadata,
      ...(action === "rework" ? {
        plan_rework_context: {
          status: "pending",
          feedback: comment,
          requested_at: now,
          requested_by: actorIdentity,
          source_status: loop.status,
        },
      } : {}),
      last_plan_decision: decisionIdentity,
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
    return { kind: "success" as const };
  });

  if (result.kind === "missing") return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  if (result.kind === "conflict") {
    return NextResponse.json({ error: "approval_transition_conflict", currentStatus: result.status }, { status: 409 });
  }
  return NextResponse.json({ ok: true, id, status: nextStatus, replay: result.kind === "replay" });
}
