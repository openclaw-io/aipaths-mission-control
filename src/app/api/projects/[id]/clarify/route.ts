import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import type { ClarificationQuestion } from "@/lib/projects/read-model";

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
  const responseText = typeof body?.response === "string" ? body.response.trim() : "";

  if (!responseText) {
    return NextResponse.json({ error: "Clarification response is required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: project, error: loadError } = await supabase
    .from("projects")
    .select("id, status, clarification_questions, metadata")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const questions = ((project.clarification_questions || []) as ClarificationQuestion[]).map((q) =>
    q.status === "open" ? { ...q, status: "answered" } : q
  );

  const metadata = {
    ...((project.metadata || {}) as Record<string, unknown>),
    clarification_history: [
      ...((((project.metadata || {}) as Record<string, unknown>).clarification_history as unknown[]) || []),
      {
        responded_at: now,
        responded_by: user.email || user.id,
        response: responseText,
      },
    ],
  };

  const nextStatus = "needs_approval";

  const { error: updateError } = await supabase
    .from("projects")
    .update({
      status: nextStatus,
      clarification_questions: questions,
      metadata,
      updated_at: now,
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("project_events").insert({
    project_id: id,
    event_type: "project.ready_for_approval",
    from_status: project.status,
    to_status: nextStatus,
    actor: user.email || user.id,
    payload: {
      source: "clarification_answered",
      response: responseText,
    },
  });

  if (eventError) {
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id, status: nextStatus });
}
