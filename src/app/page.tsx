import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  done: "bg-green-500",
  in_progress: "bg-yellow-500",
  new: "bg-blue-500",
  blocked: "bg-red-500",
};

export default async function OverviewPage() {
  const supabase = await createClient();

  // Fetch all stats in parallel
  const [activeTasksRes, cronHealthRes, memoryCountRes, recentTasksRes, recentMemoryRes] =
    await Promise.all([
      supabase
        .from("agent_tasks")
        .select("*", { count: "exact", head: true })
        .eq("status", "in_progress"),
      supabase.from("cron_health").select("last_status"),
      supabase
        .from("agent_memory")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("agent_tasks")
        .select("id, title, agent, status, created_at")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("agent_memory")
        .select("id, agent, content, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  const activeTasks = activeTasksRes.count ?? 0;

  const cronRows = cronHealthRes.data ?? [];
  const cronOk = cronRows.filter((r) => r.last_status === "ok").length;
  const cronTotal = cronRows.length;

  const memoryCount = memoryCountRes.count ?? 0;
  const recentTasks = recentTasksRes.data ?? [];
  const recentMemory = recentMemoryRes.data ?? [];

  const stats = [
    { label: "Total Agents", value: "8", emoji: "🤖" },
    { label: "Active Tasks", value: String(activeTasks), emoji: "🔥" },
    {
      label: "Cron Health",
      value: `${cronOk}/${cronTotal} OK`,
      emoji: "🟢",
    },
    { label: "Memory Entries", value: String(memoryCount), emoji: "🧠" },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">📊 Overview</h1>
      <p className="mt-2 text-gray-400">
        Welcome to Mission Control. Your agent dashboard at a glance.
      </p>

      {/* Stat Cards */}
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-gray-800 bg-[#111118] p-5"
          >
            <div className="text-3xl font-bold text-white">
              <span className="mr-2">{stat.emoji}</span>
              {stat.value}
            </div>
            <div className="mt-1 text-sm text-gray-400">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Recent Tasks */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-white">Recent Tasks</h2>
        {recentTasks.length === 0 ? (
          <p className="mt-4 text-gray-500">No tasks yet</p>
        ) : (
          <div className="mt-4 space-y-2">
            {recentTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-3 rounded-lg border border-gray-800 bg-[#111118] px-4 py-3"
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLORS[task.status] ?? "bg-gray-500"}`}
                />
                <span className="flex-1 truncate text-sm text-white">
                  {task.title}
                </span>
                <span className="text-xs text-gray-500">{task.agent}</span>
                <span className="text-xs text-gray-600">
                  {timeAgo(task.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Activity */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-white">Recent Activity</h2>
        {recentMemory.length === 0 ? (
          <p className="mt-4 text-gray-500">No memory entries yet</p>
        ) : (
          <div className="mt-4 space-y-2">
            {recentMemory.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-gray-800 bg-[#111118] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
                    {entry.agent}
                  </span>
                  <span className="text-xs text-gray-500">
                    {timeAgo(entry.created_at)}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-gray-300">
                  {entry.content?.length > 100
                    ? entry.content.slice(0, 100) + "..."
                    : entry.content}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
