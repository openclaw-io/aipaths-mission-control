import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// DELETE a task
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Remove this task from all dependents' depends_on arrays and unblock if no deps left
  const { data: dependents } = await supabase
    .from("agent_tasks")
    .select("id, depends_on, status")
    .contains("depends_on", [id]);

  if (dependents) {
    for (const dep of dependents) {
      const newDeps = (dep.depends_on || []).filter((d: string) => d !== id);
      const updates: Record<string, unknown> = { depends_on: newDeps.length ? newDeps : [] };
      // If no more dependencies and task was blocked, promote to new
      if (newDeps.length === 0 && dep.status === "blocked") {
        updates.status = "new";
      }
      await supabase.from("agent_tasks").update(updates).eq("id", dep.id);
    }
  }

  const { error } = await supabase.from("agent_tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// PATCH — update task fields
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Only allow updating safe fields
  const allowed = ["title", "instruction", "agent", "scheduled_for", "tags", "priority", "assignee"];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("agent_tasks")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
