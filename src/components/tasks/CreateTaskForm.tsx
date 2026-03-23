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
  const [priority, setPriority] = useState("medium");
  const [instruction, setInstruction] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [assignee, setAssignee] = useState("");
  const [taskType, setTaskType] = useState("auto");
  const [dependsOn, setDependsOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only show active tasks as dependency options
  const dependencyOptions = existingTasks.filter(
    (t) => t.status !== "done" && t.status !== "failed"
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    const supabase = createClient();

    const insertData: Record<string, unknown> = {
      title: title.trim(),
      agent,
      priority,
      instruction: instruction.trim() || null,
      due_date: dueDate || null,
      scheduled_for: scheduledFor || null,
      assignee: assignee || null,
      task_type: taskType,
      depends_on: dependsOn || null,
      // If it depends on another task, start as blocked
      status: dependsOn ? "blocked" : assignee === "gonza" ? "pending_approval" : "new",
    };

    const { data, error: insertError } = await supabase
      .from("agent_tasks")
      .insert(insertData)
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
    setScheduledFor("");
    setAssignee("");
    setTaskType("auto");
    setDependsOn("");
    setSubmitting(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-lg border border-gray-700 bg-[#111118] p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Title - full width */}
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="mb-1 block text-sm text-gray-400">Title</label>
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
          <label className="mb-1 block text-sm text-gray-400">Agent</label>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className={inputClass}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Priority */}
        <div>
          <label className="mb-1 block text-sm text-gray-400">Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputClass}>
            <option value="high">🔴 High</option>
            <option value="medium">🟡 Medium</option>
            <option value="low">⚪ Low</option>
          </select>
        </div>

        {/* Task Type */}
        <div>
          <label className="mb-1 block text-sm text-gray-400">Type</label>
          <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className={inputClass}>
            <option value="auto">🤖 Auto (agent executes)</option>
            <option value="approval">👤 Approval (needs human OK)</option>
            <option value="scheduled">📅 Scheduled (runs at time)</option>
          </select>
        </div>

        {/* Assignee */}
        <div>
          <label className="mb-1 block text-sm text-gray-400">Assignee (optional)</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputClass}>
            <option value="">Agent handles it</option>
            <option value="gonza">👤 Gonza (human)</option>
          </select>
        </div>

        {/* Depends On */}
        <div>
          <label className="mb-1 block text-sm text-gray-400">Depends on (optional)</label>
          <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} className={inputClass}>
            <option value="">No dependency</option>
            {dependencyOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title.slice(0, 50)}{t.title.length > 50 ? "..." : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Scheduled For */}
        {taskType === "scheduled" && (
          <div>
            <label className="mb-1 block text-sm text-gray-400">Scheduled for</label>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        {/* Due Date */}
        <div>
          <label className="mb-1 block text-sm text-gray-400">Due date (optional)</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Instruction - full width */}
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="mb-1 block text-sm text-gray-400">Instruction (optional)</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            placeholder="Task instructions..."
            className={inputClass}
          />
        </div>
      </div>

      {/* Status preview */}
      {dependsOn && (
        <p className="mt-3 text-xs text-yellow-400">
          ⛓️ This task will start as &quot;blocked&quot; until its dependency is completed.
        </p>
      )}
      {assignee === "gonza" && !dependsOn && (
        <p className="mt-3 text-xs text-blue-400">
          👤 This task will appear in &quot;Needs You&quot; for your approval.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

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
