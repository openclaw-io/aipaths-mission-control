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
};

const PRIORITY_DOT: Record<string, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-gray-500",
};

interface BoardColumn {
  id: string;
  title: string;
  emoji: string;
  color: string;
  borderColor: string;
  filter: (task: Task) => boolean;
}

const COLUMNS: BoardColumn[] = [
  {
    id: "needs_you",
    title: "Needs You",
    emoji: "🔴",
    color: "text-red-400",
    borderColor: "border-red-500/30",
    filter: (t) => t.assignee === "gonza" || t.status === "pending_approval",
  },
  {
    id: "queued",
    title: "Queued",
    emoji: "⏳",
    color: "text-blue-400",
    borderColor: "border-blue-500/30",
    filter: (t) =>
      t.status === "new" &&
      t.assignee !== "gonza",
  },
  {
    id: "in_progress",
    title: "In Progress",
    emoji: "🔄",
    color: "text-green-400",
    borderColor: "border-green-500/30",
    filter: (t) => t.status === "in_progress",
  },
  {
    id: "failed",
    title: "Failed / Blocked",
    emoji: "⚠️",
    color: "text-orange-400",
    borderColor: "border-orange-500/30",
    filter: (t) => t.status === "failed" || t.status === "blocked",
  },
];

function TaskCard({ task }: { task: Task }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-[#0d0d14] p-3 hover:border-gray-600 transition">
      <div className="flex items-start gap-2">
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority ?? "medium"]}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white leading-snug">
            {task.title}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-500">
            <span>{AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}</span>
            <span>·</span>
            <span>{timeAgo(task.created_at)}</span>
          </div>
          {task.error && (
            <p className="mt-1.5 text-xs text-red-400 line-clamp-2">
              {task.error}
            </p>
          )}
          {task.status === "pending_approval" && task.result && (
            <p className="mt-1.5 text-xs text-yellow-400 line-clamp-2">
              {task.result}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  // Exclude done tasks from the board
  const activeTasks = tasks.filter((t) => t.status !== "done");

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((col) => {
        const colTasks = activeTasks.filter(col.filter);
        return (
          <div key={col.id}>
            {/* Column header */}
            <div className={`flex items-center gap-2 border-b pb-2 ${col.borderColor}`}>
              <span>{col.emoji}</span>
              <span className={`text-sm font-semibold ${col.color}`}>
                {col.title}
              </span>
              <span className="ml-auto text-xs text-gray-600">
                {colTasks.length}
              </span>
            </div>

            {/* Cards */}
            <div className="mt-3 space-y-2">
              {colTasks.length === 0 ? (
                <p className="py-8 text-center text-xs text-gray-600">
                  No tasks
                </p>
              ) : (
                colTasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
