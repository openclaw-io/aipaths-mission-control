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
    .select("id, depends_on, status, agent, title")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", now)
    .in("status", ["blocked", "new"])
    .not("status", "eq", "done");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!tasks || tasks.length === 0) return NextResponse.json({ promoted: 0 });

  let promoted = 0;
  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;

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

    // Update status to "new" if blocked, and clear scheduled_for to mark as activated
    const updates: Record<string, unknown> = { scheduled_for: null };
    if (task.status === "blocked") updates.status = "new";

    await supabase.from("agent_tasks").update(updates).eq("id", task.id);
    promoted++;

    // Notify the assigned agent
    if (task.agent && task.agent !== "gonza" && webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `📅 Scheduled task now ready → @${task.agent}: "${task.title}"`,
        }),
      }).catch(() => {});
    }
  }

  return NextResponse.json({ promoted });
}
