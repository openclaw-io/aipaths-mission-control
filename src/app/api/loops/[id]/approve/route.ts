import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

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

  if (useLocalMode) {
    const loopRows = await query<{ id: string; status: string; approval_scope: Record<string, unknown> | null }>(
      `select id, status, approval_scope from loops where id = $1 limit 1`,
      [id],
    );
    const loop = loopRows.rows[0];
    if (!loop) return NextResponse.json({ error: "Loop not found" }, { status: 404 });

    const approvalScope = action === "rework"
      ? { ...(loop.approval_scope || {}), approved: false, approved_by: null, approved_at: null }
      : { ...(loop.approval_scope || {}), approved: true, approved_by: actorIdentity, approved_at: now, can_execute_unattended: true };

    await query(
      `update loops set status = $1, approval_scope = $2::jsonb, last_approved_at = $3, updated_at = $3 where id = $4`,
      [nextStatus, JSON.stringify(approvalScope), now, id],
    );
    await query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [id, action === 'rework' ? 'loop.plan_rework_requested' : queue ? 'loop.queued' : 'loop.approved', loop.status, nextStatus, actorIdentity, JSON.stringify({ mode: 'manual', queue, comment: comment || null, action }), now],
    );
    return NextResponse.json({ ok: true, id, status: nextStatus });
  }

  const supabase = createServiceClient();

  const { data: loop, error: loadError } = await supabase
    .from("loops")
    .select("id, status, approval_scope")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!loop) {
    return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  }

  const approvalScope = action === "rework"
    ? {
        ...(loop.approval_scope || {}),
        approved: false,
        approved_by: null,
        approved_at: null,
      }
    : {
        ...(loop.approval_scope || {}),
        approved: true,
        approved_by: actorIdentity,
        approved_at: now,
        can_execute_unattended: true,
      };

  const { error: updateError } = await supabase
    .from("loops")
    .update({
      status: nextStatus,
      approval_scope: approvalScope,
      last_approved_at: now,
      updated_at: now,
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("loop_events").insert({
    loop_id: id,
    event_type: action === "rework" ? "loop.plan_rework_requested" : queue ? "loop.queued" : "loop.approved",
    from_status: loop.status,
    to_status: nextStatus,
    actor: actorIdentity,
    payload: {
      mode: "manual",
      queue,
      comment: comment || null,
      action,
    },
  });

  if (eventError) {
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id, status: nextStatus });
}
