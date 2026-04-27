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
    projectWorkItemsRes,
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
    // 2. Work items completed today
    supabaseAdmin
      .from("work_items")
      .select("*", { count: "exact", head: true })
      .eq("status", "done")
      .gte("completed_at", `${today}T00:00:00`),
    // 3. Active agents (distinct agents with in_progress work items)
    supabaseAdmin
      .from("work_items")
      .select("owner_agent, target_agent_id")
      .eq("status", "in_progress")
      .or("target_agent_id.not.is.null,owner_agent.not.is.null"),
    // 4. Active canonical projects
    supabaseAdmin
      .from("projects")
      .select("id, name, status")
      .not("status", "in", "(completed,canceled,archived)"),
    // 5. Work items linked to projects for progress
    supabaseAdmin
      .from("project_work_items")
      .select("project_id, work_items(id, status)"),
    // 6. Failed work items (last 24h)
    supabaseAdmin
      .from("work_items")
      .select("id, title, owner_agent, target_agent_id, completed_at, updated_at, payload")
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
      .eq("cron_name", "work-item-scheduler")
      .single(),
  ]);

  // Process data
  const todayCost = (todayCostRes.data || []).reduce((s, r) => s + Number(r.cost_usd), 0);
  const tasksDoneToday = tasksDoneTodayRes.count || 0;
  const activeAgents = [
    ...new Set((activeAgentsRes.data || []).map((r) => r.target_agent_id || r.owner_agent).filter(Boolean)),
  ];

  // Project progress from canonical project_work_items -> work_items links
  const linkedWorkItemsByProject = new Map<string, Array<{ status: string | null }>>();
  for (const link of projectWorkItemsRes.data || []) {
    const workItem = Array.isArray(link.work_items) ? link.work_items[0] : link.work_items;
    if (!workItem) continue;
    const existing = linkedWorkItemsByProject.get(link.project_id) || [];
    existing.push(workItem as { status: string | null });
    linkedWorkItemsByProject.set(link.project_id, existing);
  }

  const projectProgress = (activeProjectsRes.data || []).map((project) => {
    const linkedItems = linkedWorkItemsByProject.get(project.id) || [];
    const done = linkedItems.filter((item) => item.status === "done").length;
    const total = linkedItems.length;
    return { id: project.id, title: project.name || project.id, done, total };
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
      failedTasks={(failedTasksRes.data || []).map((task) => {
        const payload = (task.payload || {}) as Record<string, unknown>;
        const error = payload.error || payload.dispatch_failure_reason || null;
        return {
          id: task.id,
          title: task.title,
          agent: task.target_agent_id || task.owner_agent || "unknown",
          completed_at: task.completed_at || task.updated_at || new Date().toISOString(),
          error: typeof error === "string" ? error : null,
        };
      })}
      errorCrons={errorCrons.map((c) => ({ name: c.cron_name, error: c.last_error, lastRun: c.last_run_at }))}
      initialActivity={activityRes.data || []}
    />
  );
}
