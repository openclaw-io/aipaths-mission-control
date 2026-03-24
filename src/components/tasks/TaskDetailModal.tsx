"use client";

import { useEffect, useState } from "react";
import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";
import { EditTaskModal } from "./EditTaskModal";
import { createClient } from "@/lib/supabase/client";

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

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  new: { label: "Ready", color: "bg-blue-500/20 text-blue-400" },
  in_progress: { label: "In Progress", color: "bg-green-500/20 text-green-400" },
  done: { label: "Done", color: "bg-gray-500/20 text-gray-400" },
  blocked: { label: "Queued", color: "bg-gray-500/20 text-gray-400" },
  failed: { label: "Failed", color: "bg-red-500/20 text-red-400" },
  pending_approval: { label: "Needs Approval", color: "bg-yellow-500/20 text-yellow-400" },
};

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
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [taskCost, setTaskCost] = useState<number | null>(null);

  // Fetch cost for this task
  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("usage_logs")
      .select("cost_usd")
      .eq("task_id", task.id)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const total = data.reduce((sum, r) => sum + Number(r.cost_usd), 0);
          setTaskCost(total);
        }
      });
  }, [task.id]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !showEdit) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, showEdit]);

  const dependencies = task.depends_on?.length
    ? allTasks.filter((t) => task.depends_on!.includes(t.id))
    : [];
  const dependents = allTasks.filter((t) => t.depends_on?.includes(task.id));
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
            <h2 className="text-lg font-semibold text-white leading-snug">{task.title}</h2>
            <div className="mt-2 flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.color}`}>
                {badge.label}
              </span>
              <span className="text-sm text-gray-400">
                {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:text-white transition shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Instruction */}
          {task.instruction && (
            <Field label="Instructions">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{task.instruction}</p>
            </Field>
          )}

          {/* Result */}
          {task.result && (
            <Field label="Result">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{task.result}</p>
            </Field>
          )}

          {/* Error */}
          {task.error && (
            <Field label="Error">
              <p className="text-sm text-red-400 whitespace-pre-wrap">{task.error}</p>
            </Field>
          )}

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-800">
              <Field label="Created">
                <p className="text-sm text-gray-300">{timeAgo(task.created_at)}</p>
              </Field>
              {task.model && (
                <Field label="Model">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    task.model === "opus" ? "bg-purple-500/20 text-purple-400" : "bg-blue-500/20 text-blue-400"
                  }`}>
                    {task.model === "opus" ? "🧠 Opus" : "⚡ Sonnet"}
                  </span>
                </Field>
              )}
              {taskCost !== null && taskCost > 0 && (
                <Field label="Cost">
                  <p className="text-sm font-medium text-green-400">${taskCost.toFixed(4)}</p>
                </Field>
              )}
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

          {/* Dependencies */}
          {(dependencies.length > 0 || dependents.length > 0) && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              {dependencies.length > 0 && (
                <Field label={`Depends on (${dependencies.length})`}>
                  <div className="space-y-1">
                    {dependencies.map((dep) => (
                      <p key={dep.id} className="text-sm text-gray-300">
                        ⛓️ {dep.title}
                        <span className="ml-2 text-xs text-gray-500">({dep.status})</span>
                      </p>
                    ))}
                  </div>
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
        <div className="border-t border-gray-800 px-6 py-4 flex items-center">
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowEdit(true)}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-[#1a1a24] transition"
            >
              ✏️ Edit
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
            >
              🗑️ Delete
            </button>
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
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {showEdit && (
        <EditTaskModal
          task={task}
          existingTasks={allTasks}
          onSaved={(updated) => {
            onTaskUpdated?.(updated);
            onClose();
          }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </div>
  );
}
