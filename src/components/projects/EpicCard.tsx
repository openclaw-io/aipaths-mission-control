"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-500",
  new: "bg-blue-500",
  in_progress: "bg-green-500",
  done: "bg-gray-600",
  blocked: "bg-yellow-500",
  failed: "bg-red-500",
  pending_approval: "bg-yellow-500",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  new: "Ready",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Queued",
  failed: "Failed",
  pending_approval: "Needs Approval",
};

function ProgressBar({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pctDone = (done / tasks.length) * 100;
  const pctProgress = (inProgress / tasks.length) * 100;

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden">
        <div className="h-full flex">
          <div className="bg-green-500 transition-all" style={{ width: `${pctDone}%` }} />
          <div className="bg-blue-500 transition-all" style={{ width: `${pctProgress}%` }} />
        </div>
      </div>
      <span className="text-xs text-gray-500 shrink-0">
        {done}/{tasks.length}
      </span>
    </div>
  );
}

function SubTaskRow({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  const deps = task.depends_on?.length
    ? allTasks.filter((t) => task.depends_on!.includes(t.id))
    : [];

  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 ${
      task.status === "done" ? "border-gray-800/50 bg-[#0d0d14]/50 opacity-60" : "border-gray-800 bg-[#0d0d14]"
    }`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[task.status] || "bg-gray-500"}`} />
      <span className={`flex-1 text-sm ${task.status === "done" ? "text-gray-500 line-through" : "text-white"}`}>
        {task.title}
      </span>
      {deps.length > 0 && (
        <span className="text-xs text-gray-600" title={deps.map((d) => d.title).join(", ")}>
          ⛓️ {deps.length}
        </span>
      )}
      <span className="text-xs text-gray-500">
        {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
      </span>
      <span className={`rounded-full px-2 py-0.5 text-xs ${
        task.status === "done" ? "bg-gray-800 text-gray-500"
        : task.status === "draft" ? "bg-gray-700/50 text-gray-400"
        : task.status === "in_progress" ? "bg-green-500/20 text-green-400"
        : task.status === "new" ? "bg-blue-500/20 text-blue-400"
        : task.status === "failed" ? "bg-red-500/20 text-red-400"
        : "bg-gray-700/50 text-gray-400"
      }`}>
        {STATUS_LABELS[task.status] || task.status}
      </span>
    </div>
  );
}

export function EpicCard({
  epic,
  subTasks,
  allTasks,
}: {
  epic: Task;
  subTasks: Task[];
  allTasks: Task[];
}) {
  const [expanded, setExpanded] = useState(epic.status !== "done");
  const done = subTasks.filter((t) => t.status === "done").length;
  const total = subTasks.length;
  const isComplete = total > 0 && done === total;

  return (
    <div className={`rounded-xl border transition ${
      isComplete ? "border-gray-800/50 bg-[#111118]/50" : "border-gray-700 bg-[#111118]"
    }`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 px-6 py-4 text-left"
      >
        <span className="text-gray-500 transition" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0)" }}>
          ▶
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className={`font-semibold ${isComplete ? "text-gray-500" : "text-white"}`}>
              {epic.title}
            </h3>
            {isComplete && <span className="text-xs text-green-500">✅ Complete</span>}
          </div>
          {epic.description && (
            <p className="mt-0.5 text-sm text-gray-500 line-clamp-1">{epic.description}</p>
          )}
          <div className="mt-2">
            <ProgressBar tasks={subTasks} />
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-gray-500">{timeAgo(epic.created_at)}</span>
        </div>
      </button>

      {/* Sub-tasks */}
      {expanded && (
        <div className="border-t border-gray-800 px-6 py-4">
          {subTasks.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-4">
              No sub-tasks yet — add tasks with this project as parent
            </p>
          ) : (
            <div className="space-y-2">
              {subTasks.map((task) => (
                <SubTaskRow key={task.id} task={task} allTasks={allTasks} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
