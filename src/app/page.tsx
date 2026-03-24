import { supabaseAdmin } from "@/lib/supabase/admin";
import { OverviewClient } from "@/components/overview/OverviewClient";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Parallel queries
  const [
    todayCostRes,
    tasksDoneTodayRes,
    activeAgentsRes,
    activeProjectsRes,
    allProjectTasksRes,
    failedTasksRes,
    cronHealthRes,
    activityRes,
    schedulerConfigRes,
  ] = await Promise.all([
    // 1. Today cost
    supabaseAdmin
      .from("usage_logs")
      .select("cost_usd")
      .eq("date", today),
    // 2. Tasks completed today
    supabaseAdmin
      .from("agent_tasks")
      .select("*", { count: "exact", head: true })
      .eq("status", "done")
      .gte("completed_at", `${today}T00:00:00`),
    // 3. Active agents (distinct agents with in_progress tasks)
    supabaseAdmin
      .from("agent_tasks")
      .select("agent")
      .eq("status", "in_progress")
      .not("tags", "cs", '{"epic"}'),
    // 4. Active projects
    supabaseAdmin
      .from("agent_tasks")
      .select("id, title, status, tags")
      .contains("tags", ["project"])
      .neq("status", "done"),
    // 5. All tasks for project progress
    supabaseAdmin
      .from("agent_tasks")
      .select("id, status, parent_id, tags, title")
      .not("tags", "cs", '{"epic"}')
      .not("tags", "cs", '{"project"}'),
    // 6. Failed tasks (last 24h)
    supabaseAdmin
      .from("agent_tasks")
      .select("id, title, agent, completed_at, error")
      .eq("status", "failed")
      .gte("completed_at", yesterday)
      .order("completed_at", { ascending: false })
      .limit(5),
    // 7. Cron health
    supabaseAdmin
      .from("cron_health")
      .select("cron_name, last_status, last_error, last_run_at, enabled"),
    // 8. Activity feed
    supabaseAdmin
      .from("activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30),
    // 9. Scheduler config (for budget)
    supabaseAdmin
      .from("cron_health")
      .select("config")
      .eq("cron_name", "task-scheduler")
      .single(),
  ]);

  // Process data
  const todayCost = (todayCostRes.data || []).reduce((s, r) => s + Number(r.cost_usd), 0);
  const tasksDoneToday = tasksDoneTodayRes.count || 0;
  const activeAgents = [...new Set((activeAgentsRes.data || []).map((r) => r.agent))];

  // Project progress
  const allLeafTasks = allProjectTasksRes.data || [];
  const projectProgress = (activeProjectsRes.data || []).map((project) => {
    // Find epics under this project
    const epicIds = allLeafTasks
      .filter((t) => t.parent_id === project.id && t.tags?.includes("epic"))
      .map((t) => t.id);
    // Find leaf tasks under those epics
    const leafTasks = allLeafTasks.filter((t) => t.parent_id && epicIds.includes(t.parent_id) && !t.title.startsWith("AI: Plan"));
    const done = leafTasks.filter((t) => t.status === "done").length;
    const total = leafTasks.length || epicIds.length; // fallback to epic count
    return { id: project.id, title: project.title, done, total };
  });

  // Cron summary
  const crons = cronHealthRes.data || [];
  const cronOk = crons.filter((c) => c.last_status === "ok" && c.enabled).length;
  const cronError = crons.filter((c) => c.last_status === "error" && c.enabled).length;
  const cronTotal = crons.filter((c) => c.enabled).length;
  const errorCrons = crons.filter((c) => c.last_status === "error" && c.enabled);

  // Budget
  const schedulerConfig = (schedulerConfigRes.data?.config as Record<string, unknown>) || {};
  const dailyBudget = Number(schedulerConfig.daily_budget_usd || 50);
  const budgetPct = dailyBudget > 0 ? (todayCost / dailyBudget) * 100 : 0;

  return (
    <OverviewClient
      todayCost={todayCost}
      dailyBudget={dailyBudget}
      budgetPct={budgetPct}
      tasksDoneToday={tasksDoneToday}
      activeAgents={activeAgents}
      cronOk={cronOk}
      cronError={cronError}
      cronTotal={cronTotal}
      projectProgress={projectProgress}
      failedTasks={(failedTasksRes.data || []) as Array<{ id: string; title: string; agent: string; completed_at: string; error: string | null }>}
      errorCrons={errorCrons.map((c) => ({ name: c.cron_name, error: c.last_error, lastRun: c.last_run_at }))}
      initialActivity={activityRes.data || []}
    />
  );
}
