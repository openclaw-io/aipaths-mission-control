import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { status } = body;

  const validStatuses = ["new", "in_progress", "done", "blocked", "failed", "pending_approval"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { status };
  if (status === "done") {
    updates.completed_at = new Date().toISOString();
  }
  if (status === "in_progress") {
    updates.started_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("agent_tasks")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // After marking done, check if any dependent tasks were unblocked by the trigger
  if (status === "done") {
    const { data: unblocked } = await supabase
      .from("agent_tasks")
      .select("id, title, agent, status")
      .contains("depends_on", [id])
      .in("status", ["new", "pending_approval"]);

    // Notify unblocked agents (Discord + gateway wake)
    if (unblocked && unblocked.length > 0) {
      for (const task of unblocked) {
        const action = task.status === "pending_approval" ? "approved" : "unblocked";
        try {
          await fetch("http://localhost:3001/api/tasks/notify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.AGENT_API_KEY}`,
            },
            body: JSON.stringify({
              taskId: task.id,
              agent: task.agent,
              title: task.title,
              action,
            }),
          });
        } catch (err) {
          console.error("[status] Failed to notify:", err);
        }
      }
    }
  }

  return NextResponse.json(data);
}
