"use client";

import { useEffect, useState } from "react";
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
  gonza: "👤",
};

const AGENTS = [
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

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  new: { label: "Ready", color: "bg-blue-500/20 text-blue-400" },
  in_progress: { label: "In Progress", color: "bg-green-500/20 text-green-400" },
  done: { label: "Done", color: "bg-gray-500/20 text-gray-400" },
  blocked: { label: "Queued", color: "bg-gray-500/20 text-gray-400" },
  failed: { label: "Failed", color: "bg-red-500/20 text-red-400" },
  pending_approval: { label: "Needs Approval", color: "bg-yellow-500/20 text-yellow-400" },
};

const inputClass =
  "w-full rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs font-medium uppercase tracking-wider text-gray-600">{label}</span>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function TaskDetailModal({
  task,
  allTasks,
  onClose,
  onStatusChange,
  onTaskUpdated,
  onTaskDeleted,
}: {
  task: Task;
  allTasks: Task[];
  onClose: () => void;
  onStatusChange?: (taskId: string, status: string) => void;
  onTaskUpdated?: (task: Task) => void;
  onTaskDeleted?: (taskId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editInstruction, setEditInstruction] = useState(task.instruction || "");
  const [editAgent, setEditAgent] = useState(task.agent);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) setEditing(false);
        else onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, editing]);

  const dependency = task.depends_on
    ? allTasks.find((t) => t.id === task.depends_on)
    : null;
  const dependents = allTasks.filter((t) => t.depends_on === task.id);
  const badge = STATUS_BADGE[task.status] ?? { label: task.status, color: "bg-gray-500/20 text-gray-400" };

  async function handleAction(newStatus: string) {
    const res = await fetch(`/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      onStatusChange?.(task.id, newStatus);
      onClose();
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          instruction: editInstruction.trim() || null,
          agent: editAgent,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        onTaskUpdated?.(updated);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this task? This cannot be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (res.ok) {
        onTaskDeleted?.(task.id);
        onClose();
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex-1 min-w-0 pr-4">
            {editing ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full border-0 bg-transparent text-lg font-semibold text-white focus:outline-none"
                autoFocus
              />
            ) : (
              <h2 className="text-lg font-semibold text-white leading-snug">{task.title}</h2>
            )}
            <div className="mt-2 flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.color}`}>
                {badge.label}
              </span>
              {editing ? (
                <select
                  value={editAgent}
                  onChange={(e) => setEditAgent(e.target.value)}
                  className="rounded border border-gray-700 bg-[#1a1a24] px-2 py-0.5 text-xs text-white focus:outline-none"
                >
                  {AGENTS.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-gray-400">
                  {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!editing && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="rounded p-1.5 text-gray-500 hover:text-white hover:bg-[#1a1a24] transition"
                  title="Edit"
                >
                  ✏️
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  title="Delete"
                >
                  🗑️
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="rounded p-1 text-gray-500 hover:text-white transition"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Instruction */}
          {editing ? (
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-gray-600">Instructions</span>
              <textarea
                value={editInstruction}
                onChange={(e) => setEditInstruction(e.target.value)}
                rows={4}
                placeholder="Task instructions..."
                className={`mt-1 ${inputClass}`}
              />
            </div>
          ) : (
            task.instruction && (
              <Field label="Instructions">
                <p className="text-sm text-gray-300 whitespace-pre-wrap">{task.instruction}</p>
              </Field>
            )
          )}

          {/* Result */}
          {!editing && task.result && (
            <Field label="Result">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{task.result}</p>
            </Field>
          )}

          {/* Error */}
          {!editing && task.error && (
            <Field label="Error">
              <p className="text-sm text-red-400 whitespace-pre-wrap">{task.error}</p>
            </Field>
          )}

          {/* Metadata grid */}
          {!editing && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-800">
              <Field label="Created">
                <p className="text-sm text-gray-300">{timeAgo(task.created_at)}</p>
              </Field>
              {task.scheduled_for && (
                <Field label="Scheduled for">
                  <p className="text-sm text-blue-400">
                    {new Date(task.scheduled_for).toLocaleDateString("en-US", {
                      weekday: "short", month: "short", day: "numeric",
                    })}{" "}
                    {new Date(task.scheduled_for).toLocaleTimeString("en-US", {
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </p>
                </Field>
              )}
              {task.started_at && (
                <Field label="Started">
                  <p className="text-sm text-gray-300">{timeAgo(task.started_at)}</p>
                </Field>
              )}
              {task.completed_at && (
                <Field label="Completed">
                  <p className="text-sm text-gray-300">{timeAgo(task.completed_at)}</p>
                </Field>
              )}
              {task.tags && task.tags.length > 0 && (
                <Field label="Tags">
                  <div className="flex gap-1">
                    {task.tags.map((tag) => (
                      <span key={tag} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                </Field>
              )}
            </div>
          )}

          {/* Dependencies */}
          {!editing && (dependency || dependents.length > 0) && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              {dependency && (
                <Field label="Depends on">
                  <p className="text-sm text-gray-300">
                    ⛓️ {dependency.title}
                    <span className="ml-2 text-xs text-gray-500">({dependency.status})</span>
                  </p>
                </Field>
              )}
              {dependents.length > 0 && (
                <Field label={`Unblocks (${dependents.length})`}>
                  <div className="space-y-1">
                    {dependents.map((t) => (
                      <p key={t.id} className="text-sm text-gray-300">
                        → {t.title}
                        <span className="ml-2 text-xs text-gray-500">({t.status})</span>
                      </p>
                    ))}
                  </div>
                </Field>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 px-6 py-4 flex gap-2 justify-end">
          {editing ? (
            <>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !editTitle.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          ) : (
            <>
              {(task.status === "pending_approval" || task.assignee === "gonza") && (
                <button
                  onClick={() => handleAction("done")}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition"
                >
                  ✅ Approve
                </button>
              )}
              {task.status === "failed" && (
                <>
                  <button
                    onClick={() => handleAction("new")}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition"
                  >
                    🔄 Retry
                  </button>
                  <button
                    onClick={() => handleAction("done")}
                    className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition"
                  >
                    ✅ Resolve
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
