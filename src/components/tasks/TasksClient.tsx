"use client";

import { useState, useEffect } from "react";
import type { Task } from "@/app/tasks/page";
import { CreateTaskModal } from "./CreateTaskModal";
import { TaskBoard } from "./TaskBoard";
import { TaskLogs } from "./TaskLogs";
import { AGENTS } from "@/lib/agents";
import { useRealtimeTasks } from "@/hooks/useRealtimeTasks";

const VIEWS = [
  { id: "board", label: "Board", emoji: "📊" },
  { id: "logs", label: "Logs", emoji: "📜" },
];
export function TasksClient({ initialTasks }: { initialTasks: Task[] }) {
  const tasks = useRealtimeTasks(initialTasks);
  const [view, setView] = useState<string>("board");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Auto-promote past-due scheduled tasks on load (no reload needed — realtime handles updates)
  useEffect(() => {
    fetch("/api/tasks/promote-scheduled", { method: "POST" }).catch(() => {});
  }, []);

  function handleTaskCreated() {
    // Realtime will pick up the new task automatically
    setShowCreateForm(false);
  }

  // Count tasks needing Gonza's attention
  const needsYouCount = tasks.filter(
    (t) => (t.assignee === "gonza" || t.status === "pending_approval") && t.status !== "done" && t.status !== "failed"
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

        {/* Agent filter for logs view */}
        {view === "logs" && (
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
        )}

        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          {showCreateForm ? "Cancel" : "+ Create"}
        </button>
      </div>

      {/* Create Modal */}
      {showCreateForm && (
        <CreateTaskModal
          agents={AGENTS}
          existingTasks={tasks}
          onCreated={handleTaskCreated}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      {/* Views */}
      {view === "board" && (
        <TaskBoard
          tasks={tasks}
          onTaskUpdate={() => {
            // Realtime handles all state updates automatically
          }}
        />
      )}
      {view === "logs" && (
        <TaskLogs
          tasks={tasks.filter((t) => t.status === "done")}
          agentFilter={agentFilter}
        />
      )}
    </div>
  );
}
