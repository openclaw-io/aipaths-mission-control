"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { TaskRow } from "./TaskRow";
import { CreateTaskForm } from "./CreateTaskForm";

const STATUSES = ["all", "new", "in_progress", "done", "blocked"] as const;
const STATUS_LABELS: Record<string, string> = {
  all: "All",
  new: "New",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Blocked",
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
];

export function TasksClient({ initialTasks }: { initialTasks: Task[] }) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
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

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">📋 Tasks</h1>
      <p className="mt-2 text-gray-400">
        Track and assign tasks to agents.
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
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

        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          {showCreateForm ? "Cancel" : "+ Create"}
        </button>
      </div>

      {/* Task count */}
      <p className="mt-4 text-sm text-gray-500">
        {filteredTasks.length} task{filteredTasks.length !== 1 ? "s" : ""}
      </p>

      {/* Create Form */}
      {showCreateForm && (
        <CreateTaskForm
          agents={AGENTS}
          onCreated={handleTaskCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Task List */}
      {filteredTasks.length === 0 ? (
        <p className="mt-6 text-gray-500">No tasks found</p>
      ) : (
        <div className="mt-4 space-y-2">
          {filteredTasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
