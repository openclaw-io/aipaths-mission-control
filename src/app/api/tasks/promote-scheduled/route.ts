import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/promote-scheduled
 * Promotes scheduled tasks whose scheduled_for has passed:
 * - If not blocked by dependency → status = "new" (Ready)
 * - If blocked by dependency → stays blocked (cascade will handle it)
 */
export async function POST() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date().toISOString();

  // Find scheduled tasks that are past due and still in initial states
  const { data: tasks, error } = await supabase
    .from("agent_tasks")
    .select("id, depends_on, status")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", now)
    .in("status", ["blocked", "new"])
    .not("status", "eq", "done");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!tasks || tasks.length === 0) return NextResponse.json({ promoted: 0 });

  let promoted = 0;

  for (const task of tasks) {
    // If has dependency, check if it's done
    if (task.depends_on) {
      const { data: dep } = await supabase
        .from("agent_tasks")
        .select("status")
        .eq("id", task.depends_on)
        .single();

      if (dep && dep.status !== "done") continue; // Still blocked
    }

    // Promote to ready
    if (task.status !== "new") {
      await supabase.from("agent_tasks").update({ status: "new" }).eq("id", task.id);
      promoted++;
    }
  }

  return NextResponse.json({ promoted });
}
