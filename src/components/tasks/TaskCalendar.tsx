"use client";

import type { Task } from "@/app/tasks/page";

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

const STATUS_COLOR: Record<string, string> = {
  new: "border-blue-500/30",
  in_progress: "border-green-500/30",
  done: "border-gray-700",
  blocked: "border-orange-500/30",
  failed: "border-red-500/30",
  pending_approval: "border-yellow-500/30",
};

function getDayLabel(date: Date, today: Date): string {
  const diff = Math.floor((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TaskCalendar({ tasks }: { tasks: Task[] }) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Generate 7 days starting from today
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Filter tasks that have scheduled_for or due_date within the 7-day window
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 7);

  function getTasksForDay(day: Date): Task[] {
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    return tasks.filter((task) => {
      const dateStr = task.scheduled_for || task.due_date;
      if (!dateStr) return false;
      const taskTime = new Date(dateStr).getTime();
      return taskTime >= dayStart && taskTime < dayEnd;
    });
  }

  // Also find unscheduled active tasks
  const unscheduled = tasks.filter(
    (t) => !t.scheduled_for && !t.due_date && t.status !== "done"
  );

  return (
    <div className="mt-6">
      {/* 7-day timeline */}
      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => {
          const dayTasks = getTasksForDay(day);
          const isToday = day.getTime() === today.getTime();

          return (
            <div
              key={day.toISOString()}
              className={`rounded-lg border bg-[#111118] p-3 min-h-[200px] ${
                isToday ? "border-blue-500/50 ring-1 ring-blue-500/20" : "border-gray-800"
              }`}
            >
              {/* Day header */}
              <div className="mb-3 border-b border-gray-800 pb-2">
                <p className={`text-xs font-semibold ${isToday ? "text-blue-400" : "text-gray-400"}`}>
                  {getDayLabel(day, today)}
                </p>
                <p className="text-xs text-gray-600">{formatDate(day)}</p>
              </div>

              {/* Tasks for this day */}
              {dayTasks.length === 0 ? (
                <p className="text-xs text-gray-700 text-center py-4">—</p>
              ) : (
                <div className="space-y-1.5">
                  {dayTasks.map((task) => (
                    <div
                      key={task.id}
                      className={`rounded border bg-[#0d0d14] px-2 py-1.5 ${STATUS_COLOR[task.status] ?? "border-gray-800"}`}
                    >
                      <p className="text-xs text-white leading-snug line-clamp-2">
                        {task.title}
                      </p>
                      <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                        <span>{AGENT_EMOJI[task.agent] ?? "🤖"}</span>
                        {task.scheduled_for && (
                          <span>
                            {new Date(task.scheduled_for).toLocaleTimeString("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Unscheduled tasks */}
      {unscheduled.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-3">
            Unscheduled ({unscheduled.length})
          </h3>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {unscheduled.slice(0, 12).map((task) => (
              <div
                key={task.id}
                className="rounded-lg border border-gray-800 bg-[#111118] px-3 py-2"
              >
                <p className="text-xs text-white line-clamp-1">{task.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent} · {task.status}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
