import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const now = new Date().toISOString();
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
    actor: user.email || user.id,
    payload: { source: "human_trigger" },
  });

  return NextResponse.json({ ok: true, id, status: "needs_approval" });
}
