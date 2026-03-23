"use client";

import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠",
  youtube: "🎬",
  content: "✍️",
  marketing: "📣",
  dev: "💻",
  community: "🌐",
  editor: "📝",
  legal: "⚖️",
  gonza: "👤",
};

export function TaskLogs({
  tasks,
  agentFilter,
}: {
  tasks: Task[];
  agentFilter: string;
}) {
  const filtered = agentFilter === "all"
    ? tasks
    : tasks.filter((t) => t.agent === agentFilter);

  // Sort by completed_at DESC, fallback to created_at
  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.completed_at ? new Date(a.completed_at).getTime() : new Date(a.created_at).getTime();
    const bTime = b.completed_at ? new Date(b.completed_at).getTime() : new Date(b.created_at).getTime();
    return bTime - aTime;
  });

  if (sorted.length === 0) {
    return (
      <div className="mt-6">
        <p className="text-gray-500">No completed tasks yet.</p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-1.5">
      <p className="text-sm text-gray-500 mb-3">
        {sorted.length} completed task{sorted.length !== 1 ? "s" : ""}
      </p>
      {sorted.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 rounded-lg border border-gray-800 bg-[#111118] px-4 py-2.5"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          <span className="text-sm text-white flex-1 min-w-0 truncate">
            {task.title}
          </span>
          <span className="text-xs text-gray-500 shrink-0">
            {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
          </span>
          <span className="text-xs text-gray-600 shrink-0">
            {task.completed_at ? timeAgo(task.completed_at) : timeAgo(task.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}
