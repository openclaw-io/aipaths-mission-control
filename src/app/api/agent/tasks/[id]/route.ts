import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

/**
 * PATCH /api/agent/tasks/:id
 * Update task status, result, error.
 * Agents use this to claim (in_progress), complete (done), or fail tasks.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { status, result, error: taskError, description } = body;

  const validStatuses = ["new", "in_progress", "done", "blocked", "failed", "pending_approval", "draft"];
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const updates: Record<string, unknown> = {};
  if (status) updates.status = status;
  if (result !== undefined) updates.result = result;
  if (taskError !== undefined) updates.error = taskError;
  if (description !== undefined) updates.description = description;
  if (status === "in_progress") updates.started_at = new Date().toISOString();
  if (status === "done") updates.completed_at = new Date().toISOString();
  if (status === "failed") updates.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("agent_tasks")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify the task creator when done or failed
  if ((status === "done" || status === "failed") && data.created_by && data.created_by !== data.agent) {
    const action = status === "done" ? "completed" : "failed";
    const detail = status === "done" ? data.result : data.error;
    fetch("http://localhost:3001/api/tasks/notify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AGENT_API_KEY}`,
      },
      body: JSON.stringify({
        taskId: id,
        agent: data.created_by,
        title: data.title,
        action,
      }),
    }).catch(() => {});
  }

  return NextResponse.json(data);
}
