"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/app/tasks/page";

interface Agent {
  id: string;
  name: string;
}

const inputClass =
  "w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500";

export function CreateTaskForm({
  agents,
  existingTasks,
  onCreated,
  onCancel,
}: {
  agents: Agent[];
  existingTasks: Task[];
  onCreated: (task: Task) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState(agents[0].id);
  const [instruction, setInstruction] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [isBacklog, setIsBacklog] = useState(false);
  const [dependsOn, setDependsOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dependencyOptions = existingTasks.filter(
    (t) => t.status !== "done" && t.status !== "failed"
  );

  // Derive task_type automatically
  const taskType = scheduledFor ? "scheduled" : isBacklog ? "backlog" : "auto";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    const supabase = createClient();

    const status = dependsOn ? "blocked" : "new";

    const { data, error: insertError } = await supabase
      .from("agent_tasks")
      .insert({
        title: title.trim(),
        agent,
        priority: "medium",
        instruction: instruction.trim() || null,
        scheduled_for: scheduledFor || null,
        task_type: taskType === "backlog" ? "auto" : taskType,
        depends_on: dependsOn || null,
        status,
        tags: isBacklog ? ["backlog"] : [],
      })
      .select()
      .single();

    if (insertError) {
      console.error("[CreateTaskForm] Insert failed:", insertError);
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    onCreated(data as Task);
    setTitle("");
    setInstruction("");
    setScheduledFor("");
    setIsBacklog(false);
    setDependsOn("");
    setSubmitting(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-gray-700 bg-[#111118] p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Title */}
        <div className="sm:col-span-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title..."
            required
            className={inputClass}
          />
        </div>

        {/* Agent */}
        <div>
          <label className="mb-1 block text-xs text-gray-500">Agent</label>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className={inputClass}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Scheduled for (optional) */}
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Date (optional — makes it scheduled)
          </label>
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Depends On */}
        <div>
          <label className="mb-1 block text-xs text-gray-500">Depends on (optional)</label>
          <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} className={inputClass}>
            <option value="">No dependency</option>
            {dependencyOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title.slice(0, 60)}{t.title.length > 60 ? "..." : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Backlog toggle */}
        <div className="flex items-end">
          <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm hover:border-gray-600 transition w-full">
            <input
              type="checkbox"
              checked={isBacklog}
              onChange={(e) => setIsBacklog(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-gray-400">📦 Backlog</span>
          </label>
        </div>

        {/* Instruction */}
        <div className="sm:col-span-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="Instructions (optional)..."
            className={inputClass}
          />
        </div>
      </div>

      {/* Status preview */}
      <div className="mt-3 text-xs text-gray-500">
        {dependsOn && <span className="text-yellow-400">⛓️ Starts blocked · </span>}
        {scheduledFor && <span className="text-blue-400">📅 Scheduled · </span>}
        {isBacklog && !scheduledFor && <span className="text-gray-400">📦 Backlog · </span>}
        {!scheduledFor && !isBacklog && !dependsOn && <span className="text-green-400">⚡ Ready immediately · </span>}
        <span>{AGENT_EMOJI[agent] ?? "🤖"} {agent}</span>
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-sm text-gray-400 transition hover:bg-white/5 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </form>
  );
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
