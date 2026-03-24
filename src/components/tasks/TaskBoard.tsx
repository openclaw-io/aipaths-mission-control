"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";
import { TaskDetailModal } from "./TaskDetailModal";

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
    id: "queued",
    title: "Queued",
    emoji: "⛓️",
    color: "text-gray-400",
    borderColor: "border-gray-500/30",
    filter: (t) => t.status === "blocked",
  },
  {
    id: "needs_you",
    title: "Needs You",
    emoji: "🔴",
    color: "text-red-400",
    borderColor: "border-red-500/30",
    filter: (t) => t.assignee === "gonza" || t.status === "pending_approval",
  },
  {
    id: "ready",
    title: "Ready",
    emoji: "⚡",
    color: "text-blue-400",
    borderColor: "border-blue-500/30",
    filter: (t) => t.status === "new" && t.assignee !== "gonza",
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
    title: "Failed",
    emoji: "⚠️",
    color: "text-orange-400",
    borderColor: "border-orange-500/30",
    filter: (t) => t.status === "failed",
  },
];

function getDayLabel(date: Date, today: Date): string {
  const diff = Math.floor((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TaskCard({
  task,
  allTasks,
  onStatusChange,
  onSelect,
}: {
  task: Task;
  allTasks: Task[];
  onStatusChange: (taskId: string, status: string) => void;
  onSelect: (task: Task) => void;
}) {
  const [loading, setLoading] = useState(false);

  const dependents = allTasks.filter((t) => t.depends_on?.includes(task.id));
  const dependency = task.depends_on?.length
    ? allTasks.find((t) => t.id === task.depends_on![0])
    : null;

  async function handleStatusChange(newStatus: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        onStatusChange(task.id, newStatus);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      onClick={() => onSelect(task)}
      className="cursor-pointer rounded-lg border border-gray-800 bg-[#0d0d14] p-3 hover:border-gray-600 transition"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white leading-snug">{task.title}</p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-gray-500">
            <span>{AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}</span>
            <span>·</span>
            <span>{timeAgo(task.created_at)}</span>
          </div>

          {dependency && (
            <p className="mt-1 text-xs text-gray-500">
              ⛓️ waiting on: <span className="text-gray-400">{dependency.title}</span>
            </p>
          )}
          {dependents.length > 0 && (
            <p className="mt-1 text-xs text-blue-500">
              → unblocks {dependents.length} task{dependents.length > 1 ? "s" : ""}
            </p>
          )}

          {task.error && (
            <p className="mt-1.5 text-xs text-red-400 line-clamp-2">{task.error}</p>
          )}
          {task.status === "pending_approval" && task.result && (
            <p className="mt-1.5 text-xs text-yellow-400 line-clamp-2">{task.result}</p>
          )}

          {/* Actions — only for Needs You and Failed */}
          {(task.status === "pending_approval" || task.assignee === "gonza" || task.status === "failed") && (
            <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
              {(task.status === "pending_approval" || task.assignee === "gonza") && (
                <button
                  onClick={() => handleStatusChange("done")}
                  disabled={loading}
                  className="rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-400 hover:bg-green-600/30 transition disabled:opacity-50"
                >
                  ✅ Approve
                </button>
              )}
              {task.status === "failed" && (
                <>
                  <button
                    onClick={() => handleStatusChange("new")}
                    disabled={loading}
                    className="rounded bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400 hover:bg-blue-600/30 transition disabled:opacity-50"
                  >
                    🔄 Retry
                  </button>
                  <button
                    onClick={() => handleStatusChange("done")}
                    disabled={loading}
                    className="rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-400 hover:bg-green-600/30 transition disabled:opacity-50"
                  >
                    ✅ Resolve
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskBoard({
  tasks,
  onTaskUpdate,
}: {
  tasks: Task[];
  onTaskUpdate?: (taskId: string, newStatus: string) => void;
}) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Exclude done, future-scheduled, and backlog tasks from columns
  // Past-scheduled tasks (time has arrived) show in board columns
  const now = new Date();
  const boardTasks = tasks.filter(
    (t) =>
      t.status !== "done" &&
      !t.tags?.includes("backlog") &&
      (!t.scheduled_for || new Date(t.scheduled_for) <= now)
  );

  // Scheduled tasks for calendar
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });
  const sevenDaysOut = new Date(today);
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

  const scheduledTasks = tasks.filter(
    (t) => t.scheduled_for && t.status !== "done" && new Date(t.scheduled_for) > now
  );

  function getTasksForDay(day: Date): Task[] {
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    return scheduledTasks.filter((t) => {
      const time = new Date(t.scheduled_for!).getTime();
      return time >= dayStart && time < dayEnd;
    });
  }

  const laterTasks = scheduledTasks.filter(
    (t) => new Date(t.scheduled_for!).getTime() >= sevenDaysOut.getTime()
  );

  function handleStatusChange(taskId: string, newStatus: string) {
    onTaskUpdate?.(taskId, newStatus);
  }

  return (
    <div>
      {/* Board columns */}
      <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const colTasks = boardTasks.filter(col.filter);
          return (
            <div key={col.id}>
              <div className={`flex items-center gap-2 border-b pb-2 ${col.borderColor}`}>
                <span>{col.emoji}</span>
                <span className={`text-sm font-semibold ${col.color}`}>{col.title}</span>
                <span className="ml-auto text-xs text-gray-600">{colTasks.length}</span>
              </div>
              <div className="mt-3 space-y-2">
                {colTasks.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-700">—</p>
                ) : (
                  colTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      allTasks={tasks}
                      onStatusChange={handleStatusChange}
                      onSelect={setSelectedTask}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Calendar: Coming Up */}
      {(scheduledTasks.length > 0 || true) && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">
            📅 Coming Up
          </h2>
          <div className="grid grid-cols-7 gap-2">
            {days.map((day) => {
              const dayTasks = getTasksForDay(day);
              const isToday = day.getTime() === today.getTime();
              return (
                <div
                  key={day.toISOString()}
                  className={`rounded-lg border bg-[#111118] p-3 min-h-[120px] ${
                    isToday
                      ? "border-blue-500/50 ring-1 ring-blue-500/20"
                      : "border-gray-800"
                  }`}
                >
                  <div className="mb-2 border-b border-gray-800 pb-1.5">
                    <p className={`text-xs font-semibold ${isToday ? "text-blue-400" : "text-gray-400"}`}>
                      {getDayLabel(day, today)}
                    </p>
                    <p className="text-xs text-gray-600">{formatDate(day)}</p>
                  </div>
                  {dayTasks.length === 0 ? (
                    <p className="text-xs text-gray-700 text-center py-2">—</p>
                  ) : (
                    <div className="space-y-1.5">
                      {dayTasks.map((task) => (
                        <div
                          key={task.id}
                          onClick={() => setSelectedTask(task)}
                          className="cursor-pointer rounded border border-blue-500/20 bg-[#0d0d14] px-2 py-1.5 hover:border-blue-500/40 transition"
                        >
                          <p className="text-xs text-white leading-snug line-clamp-2">
                            {task.title}
                          </p>
                          <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                            <span>{AGENT_EMOJI[task.agent] ?? "🤖"}</span>
                            <span>
                              {new Date(task.scheduled_for!).toLocaleTimeString("en-US", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Later: beyond 7 days */}
      {laterTasks.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">
            🔮 Later ({laterTasks.length})
          </h2>
          <div className="space-y-1.5">
            {laterTasks.map((task) => (
              <div
                key={task.id}
                onClick={() => setSelectedTask(task)}
                className="cursor-pointer flex items-center gap-3 rounded-lg border border-gray-800 bg-[#111118] px-4 py-2.5 hover:border-gray-600 transition"
              >
                <span className="text-xs text-gray-500 w-20 shrink-0">
                  {new Date(task.scheduled_for!).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="text-sm text-white flex-1">{task.title}</span>
                <span className="text-xs text-gray-500">
                  {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Backlog */}
      {(() => {
        const backlogTasks = tasks.filter(
          (t) => t.tags?.includes("backlog") && t.status !== "done"
        );
        if (backlogTasks.length === 0) return null;
        return (
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">
              📦 Backlog ({backlogTasks.length})
            </h2>
            <div className="space-y-1.5">
              {backlogTasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className="cursor-pointer flex items-center gap-3 rounded-lg border border-gray-800 bg-[#111118] px-4 py-2.5 hover:border-gray-600 transition"
                >
                  <span className="text-sm text-white flex-1">{task.title}</span>
                  <span className="text-xs text-gray-500">
                    {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
                  </span>
                  <span className="text-xs text-gray-600">
                    {timeAgo(task.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          allTasks={tasks}
          onClose={() => setSelectedTask(null)}
          onStatusChange={(taskId, newStatus) => {
            handleStatusChange(taskId, newStatus);
            setSelectedTask(null);
          }}
          onTaskUpdated={(updated) => {
            onTaskUpdate?.("__refresh__", "");
            setSelectedTask(null);
          }}
          onTaskDeleted={(taskId) => {
            onTaskUpdate?.("__delete__", taskId);
            setSelectedTask(null);
          }}
        />
      )}
    </div>
  );
}
