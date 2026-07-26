import { NextResponse } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
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
  const now = new Date().toISOString();

  if (useLocalMode) {
    const loopRows = await query<{ id: string; status: string }>(`select id, status from loops where id = $1 limit 1`, [id]);
    const loop = loopRows.rows[0];
    if (!loop) return NextResponse.json({ error: "Loop not found" }, { status: 404 });
    if (loop.status !== "planning") {
      return NextResponse.json({ error: "Loop is not in planning" }, { status: 400 });
    }

    await query(`update loops set status = 'needs_approval', updated_at = $1 where id = $2 and status = 'planning'`, [now, id]);
    await query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, 'loop.ready_for_approval', 'planning', 'needs_approval', $2, $3::jsonb, $4)`,
      [id, actorIdentity, JSON.stringify({ source: 'human_trigger' }), now],
    );
    return NextResponse.json({ ok: true, id, status: "needs_approval" });
  }

  const supabase = createServiceClient();
  const { data: loop, error: loadError } = await supabase
    .from("loops")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!loop) {
    return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  }

  if (loop.status !== "planning") {
    return NextResponse.json({ error: "Loop is not in planning" }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("loops")
    .update({ status: "needs_approval", updated_at: now })
    .eq("id", id)
    .eq("status", "planning");

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  await supabase.from("loop_events").insert({
    loop_id: id,
    event_type: "loop.ready_for_approval",
    from_status: "planning",
    to_status: "needs_approval",
    actor: actorIdentity,
    payload: { source: "human_trigger" },
  });

  return NextResponse.json({ ok: true, id, status: "needs_approval" });
}
