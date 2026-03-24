import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/activate
 * Activate an epic or project:
 * - Sets the epic status to "new"
 * - Promotes its draft sub-tasks:
 *   - Tasks with unmet depends_on → "blocked"
 *   - Tasks with no deps (or all deps done) → "new" (ready for scheduler)
 * 
 * POST /api/projects/:id/activate?all=true
 * Activate ALL draft epics under a project.
 * 
 * POST /api/projects/:id/activate?pause=true
 * Pause: set epic + its non-done tasks back to "draft"
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth check
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServiceClient();
  const activateAll = req.nextUrl.searchParams.get("all") === "true";
  const pause = req.nextUrl.searchParams.get("pause") === "true";

  if (pause) {
    // Pause: set this epic + its non-done tasks to draft
    await supabase.from("agent_tasks").update({ status: "draft" }).eq("id", id).neq("status", "done");
    const { data: children } = await supabase
      .from("agent_tasks")
      .select("id")
      .eq("parent_id", id)
      .not("status", "in", "(done,in_progress)");
    if (children) {
      for (const child of children) {
        await supabase.from("agent_tasks").update({ status: "draft" }).eq("id", child.id);
      }
    }
    return NextResponse.json({ ok: true, action: "paused" });
  }

  // Get the target(s) to activate
  let epicIds: string[] = [];

  if (activateAll) {
    // Activate all draft epics under this project
    const { data: epics } = await supabase
      .from("agent_tasks")
      .select("id")
      .eq("parent_id", id)
      .eq("status", "draft")
      .contains("tags", ["epic"]);
    epicIds = (epics || []).map((e) => e.id);
    // Also activate the project itself
    await supabase.from("agent_tasks").update({ status: "new" }).eq("id", id).eq("status", "draft");
  } else {
    epicIds = [id];
  }

  let activated = 0;

  for (const epicId of epicIds) {
    // Set the epic to "new"
    await supabase.from("agent_tasks").update({ status: "new" }).eq("id", epicId).eq("status", "draft");

    // Get all draft sub-tasks of this epic
    const { data: tasks } = await supabase
      .from("agent_tasks")
      .select("id, depends_on, status")
      .eq("parent_id", epicId)
      .eq("status", "draft");

    if (!tasks) continue;

    for (const task of tasks) {
      const deps = task.depends_on || [];

      if (deps.length === 0) {
        // No dependencies → ready
        await supabase.from("agent_tasks").update({ status: "new" }).eq("id", task.id);
      } else {
        // Check if all deps are done
        const { data: depTasks } = await supabase
          .from("agent_tasks")
          .select("status")
          .in("id", deps);
        const allDone = depTasks?.every((d) => d.status === "done") ?? false;

        if (allDone) {
          await supabase.from("agent_tasks").update({ status: "new" }).eq("id", task.id);
        } else {
          await supabase.from("agent_tasks").update({ status: "blocked" }).eq("id", task.id);
        }
      }
      activated++;
    }
  }

  return NextResponse.json({ ok: true, epicsActivated: epicIds.length, tasksProcessed: activated });
}
