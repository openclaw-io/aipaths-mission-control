"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { TaskRow } from "./TaskRow";
import { CreateTaskForm } from "./CreateTaskForm";
import { TaskBoard } from "./TaskBoard";

const AGENTS = [
  { id: "strategist", name: "Strategist" },
  { id: "youtube", name: "YouTube Director" },
  { id: "content", name: "Content Director" },
  { id: "marketing", name: "Marketing Director" },
  { id: "dev", name: "Dev Director" },
  { id: "community", name: "Community Director" },
  { id: "editor", name: "Editor" },
  { id: "legal", name: "Legal" },
];

const VIEWS = [
  { id: "board", label: "Board", emoji: "📊" },
  { id: "list", label: "List", emoji: "📋" },
];

const STATUSES = ["all", "new", "in_progress", "done", "blocked", "failed", "pending_approval"] as const;
const STATUS_LABELS: Record<string, string> = {
  all: "All",
  new: "New",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
  pending_approval: "Needs Approval",
};

export function TasksClient({ initialTasks }: { initialTasks: Task[] }) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [view, setView] = useState<string>("board");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const filteredTasks = tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (agentFilter !== "all" && task.agent !== agentFilter) return false;
    return true;
  });

  function handleTaskCreated(task: Task) {
    setTasks((prev) => [task, ...prev]);
    setShowCreateForm(false);
  }

  // Count tasks needing Gonza's attention
  const needsYouCount = tasks.filter(
    (t) => t.assignee === "gonza" || t.status === "pending_approval"
  ).length;

  return (
    <div>
      <div className="flex items-center gap-4">
        <h1 className="text-3xl font-bold text-white">📋 Tasks</h1>
        {needsYouCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-red-500/20 px-3 py-1 text-sm font-medium text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            {needsYouCount} needs you
          </span>
        )}
      </div>
      <p className="mt-2 text-gray-400">
        Track and assign tasks to agents.
      </p>

      {/* View Switcher + Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* View tabs */}
        <div className="flex gap-1 rounded-lg bg-[#0a0a0f] p-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === v.id
                  ? "bg-[#1a1a24] text-white"
                  : "text-gray-500 hover:text-white"
              }`}
            >
              {v.emoji} {v.label}
            </button>
          ))}
        </div>

        {/* Filters (only for list view) */}
        {view === "list" && (
          <>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((status) => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    statusFilter === status
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-[#111118] text-gray-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {STATUS_LABELS[status]}
                </button>
              ))}
            </div>

            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Agents</option>
              {AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </>
        )}

        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          {showCreateForm ? "Cancel" : "+ Create"}
        </button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <CreateTaskForm
          agents={AGENTS}
          existingTasks={tasks}
          onCreated={handleTaskCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Views */}
      {view === "board" && (
        <TaskBoard
          tasks={tasks}
          onTaskUpdate={(taskId, newStatus) => {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === taskId
                  ? { ...t, status: newStatus, completed_at: newStatus === "done" ? new Date().toISOString() : t.completed_at }
                  : t
              )
            );
          }}
        />
      )}
      {view === "list" && (
        <>
          <p className="mt-4 text-sm text-gray-500">
            {filteredTasks.length} task{filteredTasks.length !== 1 ? "s" : ""}
          </p>
          {filteredTasks.length === 0 ? (
            <p className="mt-6 text-gray-500">No tasks found</p>
          ) : (
            <div className="mt-4 space-y-2">
              {filteredTasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
