import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/utils";
import { AGENTS } from "@/lib/agents";

const STATUS_COLORS: Record<string, string> = {
  done: "text-green-400",
  in_progress: "text-yellow-400",
  new: "text-blue-400",
  blocked: "text-red-400",
};

interface TaskRow {
  id: string;
  title: string;
  status: string;
  agent: string;
}

interface MemoryRow {
  id: string;
  agent: string;
  created_at: string;
}

export default async function AgentsPage() {
  const supabase = await createClient();

  // Fetch all tasks and memory in bulk, then group client-side
  const [tasksRes, memoryRes] = await Promise.all([
    supabase
      .from("agent_tasks")
      .select("id, title, status, agent")
      .order("created_at", { ascending: false }),
    supabase
      .from("agent_memory")
      .select("id, agent, created_at")
      .order("created_at", { ascending: false }),
  ]);

  const allTasks = (tasksRes.data ?? []) as TaskRow[];
  const allMemory = (memoryRes.data ?? []) as MemoryRow[];

  // Group by agent
  const tasksByAgent: Record<string, TaskRow[]> = {};
  for (const task of allTasks) {
    if (!tasksByAgent[task.agent]) tasksByAgent[task.agent] = [];
    tasksByAgent[task.agent].push(task);
  }

  const memoryByAgent: Record<string, MemoryRow[]> = {};
  for (const mem of allMemory) {
    if (!memoryByAgent[mem.agent]) memoryByAgent[mem.agent] = [];
    memoryByAgent[mem.agent].push(mem);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🤖 Agents</h1>
      <p className="mt-2 text-gray-400">
        View and manage your AI agents.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {AGENTS.map((agent) => {
          const agentTasks = tasksByAgent[agent.id] ?? [];
          const lastTask = agentTasks[0] ?? null;
          const taskCount = agentTasks.length;
          const lastMemory = memoryByAgent[agent.id]?.[0] ?? null;

          return (
            <div
              key={agent.id}
              className="rounded-lg border border-gray-800 bg-[#111118] p-5"
            >
              {/* Header */}
              <div className="flex items-center gap-3">
                <span className="text-3xl">{agent.emoji}</span>
                <h3 className="text-lg font-semibold text-white">
                  {agent.name}
                </h3>
              </div>

              {/* Role */}
              <p className="mt-2 text-sm text-gray-400">{agent.role}</p>

              {/* Stats */}
              <div className="mt-4 space-y-2 border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Tasks</span>
                  <span className="text-white">{taskCount}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Last task</span>
                  {lastTask ? (
                    <span
                      className={`truncate max-w-[140px] ${STATUS_COLORS[lastTask.status] ?? "text-gray-400"}`}
                      title={lastTask.title}
                    >
                      {lastTask.title.length > 20
                        ? lastTask.title.slice(0, 20) + "..."
                        : lastTask.title}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Last memory</span>
                  {lastMemory ? (
                    <span className="text-gray-300">
                      {timeAgo(lastMemory.created_at)}
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
