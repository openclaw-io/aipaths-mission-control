"use client";

import { useState, useRef, useEffect } from "react";
import type { Task } from "@/app/tasks/page";

interface Agent {
  id: string;
  name: string;
}

const AGENTS: Agent[] = [
  { id: "strategist", name: "Strategist" },
  { id: "youtube", name: "YouTube Director" },
  { id: "content", name: "Content Director" },
  { id: "marketing", name: "Marketing Director" },
  { id: "dev", name: "Dev Director" },
  { id: "community", name: "Community Director" },
  { id: "editor", name: "Editor" },
  { id: "legal", name: "Legal" },
  { id: "gonza", name: "👤 Gonza" },
];

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

const inputClass =
  "w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500";

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

  return (
    <div className="w-64 rounded-lg border border-gray-700 bg-[#111118] p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => setViewMonth(new Date(year, month - 1, 1))} className="rounded p-1 text-gray-400 hover:text-white hover:bg-[#1a1a24] transition">‹</button>
        <span className="text-sm font-medium text-white">{monthName}</span>
        <button type="button" onClick={() => setViewMonth(new Date(year, month + 1, 1))} className="rounded p-1 text-gray-400 hover:text-white hover:bg-[#1a1a24] transition">›</button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {dayNames.map((d) => <div key={d} className="text-center text-xs text-gray-600 py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) =>
          day === null ? <div key={`e-${i}`} /> : (
            <button
              key={day} type="button"
              onClick={() => onSelect(new Date(year, month, day))}
              className={`rounded py-1 text-xs transition ${
                selectedDate && selectedDate.getFullYear() === year && selectedDate.getMonth() === month && selectedDate.getDate() === day
                  ? "bg-blue-600 text-white font-bold"
                  : today.getFullYear() === year && today.getMonth() === month && today.getDate() === day
                  ? "bg-blue-500/20 text-blue-400 font-medium"
                  : "text-gray-300 hover:bg-[#1a1a24]"
              }`}
            >{day}</button>
          )
        )}
      </div>
    </div>
  );
}

export function EditTaskModal({
  task,
  existingTasks,
  onSaved,
  onClose,
}: {
  task: Task;
  existingTasks: Task[];
  onSaved: (updated: Task) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [agent, setAgent] = useState(task.agent);
  const [instruction, setInstruction] = useState(task.instruction || "");
  const [selectedDate, setSelectedDate] = useState<Date | null>(
    task.scheduled_for ? new Date(task.scheduled_for) : null
  );
  const [selectedTime, setSelectedTime] = useState(() => {
    if (task.scheduled_for) {
      const d = new Date(task.scheduled_for);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return "09:00";
  });
  const [showCalendar, setShowCalendar] = useState(false);
  const [isBacklog, setIsBacklog] = useState(task.tags?.includes("backlog") || false);
  const [dependsOn, setDependsOn] = useState(task.depends_on?.[0] || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calendarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) setShowCalendar(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const dependencyOptions = existingTasks.filter(
    (t) => t.status !== "done" && t.status !== "failed" && t.id !== task.id
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
    setSaving(true);
    setError(null);

    const scheduledFor = getScheduledFor();

    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        instruction: instruction.trim() || null,
        agent,
        scheduled_for: scheduledFor,
        tags: isBacklog ? ["backlog"] : [],
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to save");
      setSaving(false);
      return;
    }

    const updated = await res.json();
    onSaved(updated as Task);
  }

  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">Edit Task</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 hover:text-white transition">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4">
          <div className="space-y-4">
            <input
              type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?" required autoFocus
              className="w-full border-0 bg-transparent text-lg text-white placeholder-gray-600 focus:outline-none"
            />

            <textarea
              value={instruction} onChange={(e) => setInstruction(e.target.value)}
              rows={3} placeholder="Add details..."
              className="w-full border-0 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none resize-none"
            />

            <div className="flex flex-wrap gap-2">
              <select value={agent} onChange={(e) => setAgent(e.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                {AGENTS.map((a) => <option key={a.id} value={a.id}>{AGENT_EMOJI[a.id] ?? "🤖"} {a.name}</option>)}
              </select>

              <div className="relative" ref={calendarRef}>
                <button type="button" onClick={() => setShowCalendar(!showCalendar)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${selectedDate ? "border-blue-500/50 bg-blue-500/10 text-blue-400" : "border-gray-700 bg-[#1a1a24] text-gray-400 hover:text-white"}`}
                >📅 {dateLabel ?? "Add date"}</button>
                {showCalendar && (
                  <div className="absolute left-0 top-full z-50 mt-1">
                    <MiniCalendar selectedDate={selectedDate} onSelect={(d) => { setSelectedDate(d); setShowCalendar(false); }} />
                    {selectedDate && (
                      <div className="mt-1 flex gap-1">
                        <input type="time" value={selectedTime} onChange={(e) => setSelectedTime(e.target.value)} className="flex-1 rounded-lg border border-gray-700 bg-[#111118] px-2 py-1 text-sm text-white focus:outline-none" />
                        <button type="button" onClick={() => { setSelectedDate(null); setShowCalendar(false); }} className="rounded-lg border border-gray-700 bg-[#111118] px-2 py-1 text-xs text-red-400 hover:bg-red-500/10">Clear</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {dependencyOptions.length > 0 && (
                <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[200px]">
                  <option value="">⛓️ No dependency</option>
                  {dependencyOptions.map((t) => <option key={t.id} value={t.id}>⛓️ {t.title.slice(0, 40)}</option>)}
                </select>
              )}

              <button type="button" onClick={() => setIsBacklog(!isBacklog)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${isBacklog ? "border-gray-500/50 bg-gray-500/10 text-gray-300" : "border-gray-700 bg-[#1a1a24] text-gray-500 hover:text-white"}`}
              >📦 Backlog</button>
            </div>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-6 flex items-center justify-between border-t border-gray-800 pt-4">
            <div className="text-xs text-gray-500">
              {selectedDate && <span className="text-blue-400">📅 Scheduled · </span>}
              {isBacklog && !selectedDate && <span className="text-gray-400">📦 Backlog · </span>}
              {!selectedDate && !isBacklog && <span className="text-green-400">⚡ Active · </span>}
              <span>{AGENT_EMOJI[agent] ?? "🤖"} {agent}</span>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
              <button type="submit" disabled={saving || !title.trim()} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
