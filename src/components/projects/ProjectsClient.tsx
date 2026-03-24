"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { CreateEpicModal } from "./CreateEpicModal";
import { ProjectCard } from "./ProjectCard";

export function ProjectsClient({
  epics,
  subTasksByParent,
  allTasks,
}: {
  epics: Task[];
  subTasksByParent: Record<string, Task[]>;
  allTasks: Task[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  // Projects = tasks tagged "project" or "epic" with no parent_id
  const projects = epics.filter((e) => !e.parent_id);

  // Sort: active first, then by created_at desc
  const sorted = [...projects].sort((a, b) => {
    const aActive = a.status !== "done";
    const bActive = b.status !== "done";
    if (aActive !== bActive) return aActive ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-3 text-sm text-gray-400">
          <span>{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{projects.filter((e) => e.status !== "done").length} active</span>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition"
        >
          + New Project
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-12 text-center">
          <p className="text-lg text-gray-500">No projects yet</p>
          <p className="mt-1 text-sm text-gray-600">
            Create a project to organize epics and tasks
          </p>
        </div>
      ) : (
        <>
          {/* Card grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map((project) => {
              const projectEpics = subTasksByParent[project.id] || [];
              // All tasks under this project (epics' children)
              const allProjectTasks = projectEpics.flatMap(
                (epic) => subTasksByParent[epic.id] || []
              );
              // Also include direct children that aren't epics
              const directTasks = (subTasksByParent[project.id] || []).filter(
                (t) => !t.tags?.includes("epic")
              );

              return (
                <ProjectCard
                  key={project.id}
                  project={project}
                  epics={projectEpics.filter((t) => t.tags?.includes("epic"))}
                  totalTasks={allProjectTasks.length + directTasks.length}
                  doneTasks={
                    [...allProjectTasks, ...directTasks].filter((t) => t.status === "done").length
                  }
                  isExpanded={expandedProject === project.id}
                  onToggle={() =>
                    setExpandedProject(expandedProject === project.id ? null : project.id)
                  }
                />
              );
            })}
          </div>

          {/* Expanded project detail */}
          {expandedProject && (
            <ProjectDetail
              project={sorted.find((p) => p.id === expandedProject)!}
              epics={(subTasksByParent[expandedProject] || []).filter((t) =>
                t.tags?.includes("epic")
              )}
              subTasksByParent={subTasksByParent}
              allTasks={allTasks}
            />
          )}
        </>
      )}

      {showCreate && <CreateEpicModal onClose={() => setShowCreate(false)} />}
    </>
  );
}

function ProjectDetail({
  project,
  epics,
  subTasksByParent,
  allTasks,
}: {
  project: Task;
  epics: Task[];
  subTasksByParent: Record<string, Task[]>;
  allTasks: Task[];
}) {
  const STATUS_COLORS: Record<string, string> = {
    draft: "bg-gray-500",
    new: "bg-blue-500",
    in_progress: "bg-green-500",
    done: "bg-gray-600",
    blocked: "bg-yellow-500",
    failed: "bg-red-500",
    pending_approval: "bg-yellow-500",
  };

  const STATUS_LABELS: Record<string, string> = {
    draft: "Draft",
    new: "Ready",
    in_progress: "In Progress",
    done: "Done",
    blocked: "Queued",
    failed: "Failed",
    pending_approval: "Needs Approval",
  };

  const AGENT_EMOJI: Record<string, string> = {
    strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
    dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
  };

  async function activateEpic(epicId: string) {
    if (!confirm("Activate this epic? Its tasks will become available for the scheduler.")) return;
    const res = await fetch(`/api/tasks/${epicId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "new" }),
    });
    if (res.ok) window.location.reload();
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-700 bg-[#0d0d14] p-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-white">{project.title}</h2>
        {project.description && (
          <p className="mt-2 text-sm text-gray-400 whitespace-pre-wrap">{project.description}</p>
        )}
      </div>

      {epics.length === 0 ? (
        <p className="text-sm text-gray-600 text-center py-8">
          No epics yet — add epics to break this project into phases
        </p>
      ) : (
        <div className="space-y-4">
          {epics.map((epic) => {
            const tasks = subTasksByParent[epic.id] || [];
            const done = tasks.filter((t) => t.status === "done").length;
            const total = tasks.length;
            const pctDone = total > 0 ? (done / total) * 100 : 0;
            const inProgress = tasks.filter((t) => t.status === "in_progress").length;
            const pctProgress = total > 0 ? (inProgress / total) * 100 : 0;

            return (
              <div key={epic.id} className="rounded-lg border border-gray-800 bg-[#111118]">
                {/* Epic header */}
                <div className="flex items-center gap-4 px-5 py-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLORS[epic.status] || "bg-gray-500"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-white text-sm">{epic.title}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        epic.status === "draft" ? "bg-gray-700/50 text-gray-400"
                        : epic.status === "done" ? "bg-gray-800 text-gray-500"
                        : epic.status === "new" ? "bg-blue-500/20 text-blue-400"
                        : epic.status === "in_progress" ? "bg-green-500/20 text-green-400"
                        : "bg-gray-700/50 text-gray-400"
                      }`}>
                        {STATUS_LABELS[epic.status] || epic.status}
                      </span>
                    </div>
                    {total > 0 && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden max-w-48">
                          <div className="h-full flex">
                            <div className="bg-green-500" style={{ width: `${pctDone}%` }} />
                            <div className="bg-blue-500" style={{ width: `${pctProgress}%` }} />
                          </div>
                        </div>
                        <span className="text-xs text-gray-600">{done}/{total}</span>
                      </div>
                    )}
                  </div>
                  {epic.status === "draft" && (
                    <button
                      onClick={() => activateEpic(epic.id)}
                      className="rounded-lg border border-green-600/50 bg-green-600/10 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-600/20 transition shrink-0"
                    >
                      ▶️ Activate
                    </button>
                  )}
                </div>

                {/* Tasks */}
                {tasks.length > 0 && (
                  <div className="border-t border-gray-800/50 px-5 py-2.5 space-y-1">
                    {tasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 py-1">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_COLORS[task.status] || "bg-gray-500"}`} />
                        <span className={`flex-1 text-xs ${task.status === "done" ? "text-gray-600 line-through" : "text-gray-300"}`}>
                          {task.title}
                        </span>
                        <span className="text-xs text-gray-600">
                          {AGENT_EMOJI[task.agent] ?? "🤖"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
