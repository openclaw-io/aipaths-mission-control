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
    const projectRows = await query<{ id: string; status: string }>(`select id, status from projects where id = $1 limit 1`, [id]);
    const project = projectRows.rows[0];
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.status !== "planning") {
      return NextResponse.json({ error: "Project is not in planning" }, { status: 400 });
    }

    await query(`update projects set status = 'needs_approval', updated_at = $1 where id = $2 and status = 'planning'`, [now, id]);
    await query(
      `insert into project_events (project_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, 'project.ready_for_approval', 'planning', 'needs_approval', $2, $3::jsonb, $4)`,
      [id, actorIdentity, JSON.stringify({ source: 'human_trigger' }), now],
    );
    return NextResponse.json({ ok: true, id, status: "needs_approval" });
  }

  const supabase = createServiceClient();
  const { data: project, error: loadError } = await supabase
    .from("projects")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (project.status !== "planning") {
    return NextResponse.json({ error: "Project is not in planning" }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("projects")
    .update({ status: "needs_approval", updated_at: now })
    .eq("id", id)
    .eq("status", "planning");

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  await supabase.from("project_events").insert({
    project_id: id,
    event_type: "project.ready_for_approval",
    from_status: "planning",
    to_status: "needs_approval",
    actor: actorIdentity,
    payload: { source: "human_trigger" },
  });

  return NextResponse.json({ ok: true, id, status: "needs_approval" });
}
