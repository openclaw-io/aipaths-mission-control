"use client";

import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";

const STATUS_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  draft: { border: "border-gray-700", bg: "bg-gray-500/10", text: "text-gray-400" },
  new: { border: "border-blue-500/30", bg: "bg-blue-500/10", text: "text-blue-400" },
  in_progress: { border: "border-green-500/30", bg: "bg-green-500/10", text: "text-green-400" },
  done: { border: "border-gray-800", bg: "bg-gray-500/5", text: "text-gray-500" },
};

export function ProjectCard({
  project,
  epics,
  totalTasks,
  doneTasks,
  isExpanded,
  onToggle,
}: {
  project: Task;
  epics: Task[];
  totalTasks: number;
  doneTasks: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const colors = STATUS_COLORS[project.status] || STATUS_COLORS.draft;
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const isComplete = totalTasks > 0 && doneTasks === totalTasks;
  const activeEpics = epics.filter((e) => e.status !== "done" && e.status !== "draft").length;
  const draftEpics = epics.filter((e) => e.status === "draft").length;

  return (
    <button
      onClick={onToggle}
      className={`w-full text-left rounded-xl border transition p-5 h-48 flex flex-col ${
        isExpanded
          ? "border-blue-500/50 ring-1 ring-blue-500/20 bg-[#111118]"
          : `${colors.border} bg-[#111118] hover:border-gray-600`
      } ${isComplete ? "opacity-60" : ""}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className={`font-semibold leading-snug line-clamp-2 ${isComplete ? "text-gray-500" : "text-white"}`}>
          {project.title}
        </h3>
        {isComplete && <span className="text-xs text-green-500 shrink-0">✅</span>}
      </div>

      {/* Description preview */}
      {project.description && (
        <p className="text-xs text-gray-500 line-clamp-2 mb-auto">
          {project.description}
        </p>
      )}
      {!project.description && <div className="mb-auto" />}

      {/* Progress */}
      {totalTasks > 0 && (
        <div className="mt-2">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-gray-500">{pct}%</span>
          </div>
        </div>
      )}

      {/* Footer stats */}
      <div className="flex items-center gap-3 text-xs text-gray-600 mt-1">
        {epics.length > 0 && (
          <span>{epics.length} epic{epics.length !== 1 ? "s" : ""}</span>
        )}
        {totalTasks > 0 && (
          <span>{doneTasks}/{totalTasks} tasks</span>
        )}
        {activeEpics > 0 && (
          <span className="text-green-500">{activeEpics} active</span>
        )}
        {draftEpics > 0 && (
          <span className="text-gray-500">{draftEpics} draft</span>
        )}
        <span className="ml-auto">{timeAgo(project.created_at)}</span>
      </div>
    </button>
  );
}
