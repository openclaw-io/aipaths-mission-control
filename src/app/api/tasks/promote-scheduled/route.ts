import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/promote-scheduled
 * Promotes scheduled tasks whose scheduled_for has passed:
 * - If not blocked by dependency → status = "new" (Ready)
 * - If blocked by dependency → stays blocked (cascade will handle it)
 */
export async function POST() {
  // Use service client — this is called on page load, cookies may not be available
  const { createServiceClient } = await import("@/lib/supabase/admin");
  const supabase = createServiceClient();

  const now = new Date().toISOString();

  // Find scheduled tasks that are past due and still in initial states
  const { data: tasks, error } = await supabase
    .from("agent_tasks")
    .select("id, depends_on, status, agent, title")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", now)
    .in("status", ["blocked", "new"])
    .not("status", "eq", "done");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!tasks || tasks.length === 0) return NextResponse.json({ promoted: 0 });

  let promoted = 0;

  for (const task of tasks) {
    // If has dependency, check if it's done
    if (task.depends_on?.length) {
      const { data: deps } = await supabase
        .from("agent_tasks")
        .select("status")
        .in("id", task.depends_on);
      const allDone = deps?.every((d: any) => d.status === "done") ?? false;
      if (!allDone) continue; // Still blocked
    }

    // Update status to "new" if blocked, and clear scheduled_for to mark as activated
    const updates: Record<string, unknown> = { scheduled_for: null };
    if (task.status === "blocked") updates.status = "new";

    await supabase.from("agent_tasks").update(updates).eq("id", task.id);
    promoted++;

    // Notify the assigned agent (Discord + gateway wake)
    if (task.agent && task.agent !== "gonza") {
      try {
        const notifyRes = await fetch(`http://127.0.0.1:3001/api/tasks/notify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.AGENT_API_KEY}`,
          },
          body: JSON.stringify({
            taskId: task.id,
            agent: task.agent,
            title: task.title,
            action: "promoted",
          }),
        });
        console.log(`[promote] notify ${task.agent}: HTTP ${notifyRes.status}`);
      } catch (err: any) {
        console.error(`[promote] notify ${task.agent} failed:`, err.message);
      }
    }
  }

  return NextResponse.json({ promoted });
}
