"use client";

import { useState, useRef, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/app/tasks/page";

interface Agent {
  id: string;
  name: string;
}

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

const inputClass =
  "w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500";

// Mini calendar component
function MiniCalendar({
  selectedDate,
  onSelect,
}: {
  selectedDate: Date | null;
  onSelect: (date: Date) => void;
}) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = selectedDate || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const monthName = viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function isSelected(day: number): boolean {
    if (!selectedDate) return false;
    return (
      selectedDate.getFullYear() === year &&
      selectedDate.getMonth() === month &&
      selectedDate.getDate() === day
    );
  }

  function isToday(day: number): boolean {
    return (
      today.getFullYear() === year &&
      today.getMonth() === month &&
      today.getDate() === day
    );
  }

  function isPast(day: number): boolean {
    const d = new Date(year, month, day);
    return d < today;
  }

  return (
    <div className="w-64 rounded-lg border border-gray-700 bg-[#111118] p-3">
      {/* Month nav */}
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setViewMonth(new Date(year, month - 1, 1))}
          className="rounded p-1 text-gray-400 hover:text-white hover:bg-[#1a1a24] transition"
        >
          ‹
        </button>
        <span className="text-sm font-medium text-white">{monthName}</span>
        <button
          type="button"
          onClick={() => setViewMonth(new Date(year, month + 1, 1))}
          className="rounded p-1 text-gray-400 hover:text-white hover:bg-[#1a1a24] transition"
        >
          ›
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {dayNames.map((d) => (
          <div key={d} className="text-center text-xs text-gray-600 py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Days */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) =>
          day === null ? (
            <div key={`empty-${i}`} />
          ) : (
            <button
              key={day}
              type="button"
              disabled={isPast(day)}
              onClick={() => onSelect(new Date(year, month, day))}
              className={`rounded py-1 text-xs transition ${
                isSelected(day)
                  ? "bg-blue-600 text-white font-bold"
                  : isToday(day)
                  ? "bg-blue-500/20 text-blue-400 font-medium"
                  : isPast(day)
                  ? "text-gray-700 cursor-not-allowed"
                  : "text-gray-300 hover:bg-[#1a1a24]"
              }`}
            >
              {day}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function CreateTaskModal({
  agents,
  existingTasks,
  onCreated,
  onClose,
}: {
  agents: Agent[];
  existingTasks: Task[];
  onCreated: (task: Task) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState(agents[0].id);
  const [instruction, setInstruction] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState("09:00");
  const [showCalendar, setShowCalendar] = useState(false);
  const [isBacklog, setIsBacklog] = useState(false);
  const [dependsOn, setDependsOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);

  // Close on escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Close calendar on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setShowCalendar(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const dependencyOptions = existingTasks.filter(
    (t) => t.status !== "done" && t.status !== "failed"
  );

  function getScheduledFor(): string | null {
    if (!selectedDate) return null;
    const [hours, minutes] = selectedTime.split(":").map(Number);
    const d = new Date(selectedDate);
    d.setHours(hours, minutes, 0, 0);
    return d.toISOString();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const scheduledFor = getScheduledFor();
    const status = dependsOn ? "blocked" : "new";

    const { data, error: insertError } = await supabase
      .from("agent_tasks")
      .insert({
        title: title.trim(),
        agent,
        priority: "medium",
        instruction: instruction.trim() || null,
        scheduled_for: scheduledFor,
        task_type: scheduledFor ? "scheduled" : "auto",
        depends_on: dependsOn ? [dependsOn] : [],
        status,
        tags: isBacklog ? ["backlog"] : [],
      })
      .select()
      .single();

    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    // Notify agent if task is immediately ready
    if (status === "new" && agent !== "gonza") {
      fetch("/api/tasks/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: data.id,
          agent,
          title: title.trim(),
          action: "created",
        }),
      }).catch(() => {});
    }

    onCreated(data as Task);
  }

  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-lg rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">New Task</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:text-white transition"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4">
          <div className="space-y-4">
            {/* Title */}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              required
              autoFocus
              className="w-full border-0 bg-transparent text-lg text-white placeholder-gray-600 focus:outline-none"
            />

            {/* Instruction */}
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder="Add details..."
              className="w-full border-0 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none resize-none"
            />

            {/* Controls row */}
            <div className="flex flex-wrap gap-2">
              {/* Agent */}
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {AGENT_EMOJI[a.id] ?? "🤖"} {a.name}
                  </option>
                ))}
              </select>

              {/* Date picker trigger */}
              <div className="relative" ref={calendarRef}>
                <button
                  type="button"
                  onClick={() => setShowCalendar(!showCalendar)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    selectedDate
                      ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                      : "border-gray-700 bg-[#1a1a24] text-gray-400 hover:text-white"
                  }`}
                >
                  📅 {dateLabel ?? "Add date"}
                </button>

                {showCalendar && (
                  <div className="absolute left-0 top-full z-50 mt-1">
                    <MiniCalendar
                      selectedDate={selectedDate}
                      onSelect={(d) => {
                        setSelectedDate(d);
                        setShowCalendar(false);
                      }}
                    />
                    {selectedDate && (
                      <div className="mt-1 flex gap-1">
                        <input
                          type="time"
                          value={selectedTime}
                          onChange={(e) => setSelectedTime(e.target.value)}
                          className="flex-1 rounded-lg border border-gray-700 bg-[#111118] px-2 py-1 text-sm text-white focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDate(null);
                            setShowCalendar(false);
                          }}
                          className="rounded-lg border border-gray-700 bg-[#111118] px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Dependency */}
              {dependencyOptions.length > 0 && (
                <select
                  value={dependsOn}
                  onChange={(e) => setDependsOn(e.target.value)}
                  className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[200px]"
                >
                  <option value="">⛓️ No dependency</option>
                  {dependencyOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      ⛓️ {t.title.slice(0, 40)}
                    </option>
                  ))}
                </select>
              )}

              {/* Backlog */}
              <button
                type="button"
                onClick={() => setIsBacklog(!isBacklog)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  isBacklog
                    ? "border-gray-500/50 bg-gray-500/10 text-gray-300"
                    : "border-gray-700 bg-[#1a1a24] text-gray-500 hover:text-white"
                }`}
              >
                📦 Backlog
              </button>
            </div>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          {/* Footer */}
          <div className="mt-6 flex items-center justify-between border-t border-gray-800 pt-4">
            {/* Status preview */}
            <div className="text-xs text-gray-500">
              {dependsOn && <span className="text-yellow-400">⛓️ Blocked · </span>}
              {selectedDate && <span className="text-blue-400">📅 Scheduled · </span>}
              {isBacklog && !selectedDate && <span className="text-gray-400">📦 Backlog · </span>}
              {!selectedDate && !isBacklog && !dependsOn && (
                <span className="text-green-400">⚡ Ready · </span>
              )}
              <span>{AGENT_EMOJI[agent] ?? "🤖"} {agent}</span>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !title.trim()}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
