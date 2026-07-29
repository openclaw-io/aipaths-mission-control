import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";

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
  const action = body?.action === "rework" ? "rework" : "approve";
  const queue = action === "approve" && body?.queue !== false;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const now = new Date().toISOString();
  const nextStatus = action === "rework" ? "planning" : queue ? "queued" : "approved";

  // Approval writes must keep the Loop state and its event in one transaction.
  // Supabase REST cannot provide that atomic boundary, so cloud mode fails
  // closed rather than risking a state transition without coherent history.
  if (!useLocalMode) {
    return NextResponse.json({ error: "cloud_loop_approval_writes_not_supported" }, { status: 503 });
  }

  if (useLocalMode) {
    const result = await withTransaction(async (client) => {
      const loopRows = await client.query<{ id: string; status: string; approval_scope: Record<string, unknown> | null; metadata: Record<string, unknown> | null }>(
        `select id, status, approval_scope, metadata from loops where id = $1 limit 1 for update`, [id],
      );
      const loop = loopRows.rows[0];
      if (!loop) return { kind: "missing" as const };
      if (loop.status === nextStatus) return { kind: "replay" as const };
      const allowed = action === "rework"
        ? ["needs_approval", "approved", "queued"].includes(loop.status)
        : loop.status === "needs_approval" || (queue && loop.status === "approved");
      if (!allowed) return { kind: "invalid" as const, status: loop.status };

      const approvalScope = action === "rework"
        ? { ...(loop.approval_scope || {}), approved: false, approved_by: null, approved_at: null }
        : { ...(loop.approval_scope || {}), approved: true, approved_by: actorIdentity, approved_at: now, can_execute_unattended: true };
      const metadata = action === "rework"
        ? {
            ...(loop.metadata || {}),
            plan_rework_context: {
              status: "pending",
              feedback: comment || null,
              requested_at: now,
              requested_by: actorIdentity,
              source_status: loop.status,
            },
          }
        : loop.metadata || {};
      await client.query(
        `update loops set status = $1, approval_scope = $2::jsonb, metadata = $3::jsonb, last_approved_at = $4, updated_at = $4 where id = $5`,
        [nextStatus, JSON.stringify(approvalScope), JSON.stringify(metadata), now, id],
      );
      await client.query(
        `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, action === 'rework' ? 'loop.plan_rework_requested' : queue ? 'loop.queued' : 'loop.approved', loop.status, nextStatus, actorIdentity, JSON.stringify({ mode: 'manual', queue, comment: comment || null, action, dedupe_key: `${loop.status}:${action}:${nextStatus}` }), now],
      );
      return { kind: "success" as const };
    });
    if (result.kind === "missing") return NextResponse.json({ error: "Loop not found" }, { status: 404 });
    if (result.kind === "invalid") return NextResponse.json({ error: `Action not allowed from ${result.status}` }, { status: 400 });
    return NextResponse.json({ ok: true, id, status: nextStatus });
  }

  // Defensive fallback if the local-mode predicate ever becomes unstable.
  return NextResponse.json({ error: "cloud_loop_approval_writes_not_supported" }, { status: 503 });
}
