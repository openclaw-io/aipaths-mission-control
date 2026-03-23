"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/app/tasks/page";

interface Agent {
  id: string;
  name: string;
}

export function CreateTaskForm({
  agents,
  onCreated,
  onCancel,
}: {
  agents: Agent[];
  onCreated: (task: Task) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState(agents[0].id);
  const [priority, setPriority] = useState("medium");
  const [instruction, setInstruction] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const { data, error: insertError } = await supabase
      .from("agent_tasks")
      .insert({
        title: title.trim(),
        agent,
        priority,
        instruction: instruction.trim() || null,
        due_date: dueDate || null,
        status: "new",
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
    setDueDate("");
    setSubmitting(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-gray-700 bg-[#111118] p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-sm text-gray-400">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title..."
            required
            className="w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-400">Agent</label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-400">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className="mb-1 block text-sm text-gray-400">
            Instruction (optional)
          </label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            placeholder="Task instructions..."
            className="w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-400">
            Due date (optional)
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400">{error}</p>
      )}

      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create Task"}
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
