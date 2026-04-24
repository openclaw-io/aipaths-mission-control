import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
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

  const body = await request.json().catch(() => ({}));
  const action = body?.action === "rework" ? "rework" : "approve";
  const queue = action === "approve" && body?.queue !== false;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";

  const supabase = createServiceClient();

  const { data: project, error: loadError } = await supabase
    .from("projects")
    .select("id, status, approval_scope")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const nextStatus = action === "rework" ? "planning" : queue ? "queued" : "approved";
  const approvalScope = action === "rework"
    ? {
        ...(project.approval_scope || {}),
        approved: false,
        approved_by: null,
        approved_at: null,
      }
    : {
        ...(project.approval_scope || {}),
        approved: true,
        approved_by: user.email || user.id,
        approved_at: now,
        can_execute_unattended: true,
      };

  const { error: updateError } = await supabase
    .from("projects")
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

  const { error: eventError } = await supabase.from("project_events").insert({
    project_id: id,
    event_type: action === "rework" ? "project.plan_rework_requested" : queue ? "project.queued" : "project.approved",
    from_status: project.status,
    to_status: nextStatus,
    actor: user.email || user.id,
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
