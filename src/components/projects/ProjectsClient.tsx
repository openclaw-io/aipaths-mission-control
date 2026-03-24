"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { CreateEpicModal } from "./CreateEpicModal";
import { ProjectCard } from "./ProjectCard";
import { ProjectDetailModal } from "./ProjectDetailModal";

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
  const [showDone, setShowDone] = useState(false);

  // Projects = tasks tagged "project" or "epic" with no parent_id
  const projects = epics.filter((e) => !e.parent_id);

  const doneCount = projects.filter((p) => p.status === "done").length;

  // Filter + sort: active first, then by created_at desc
  const sorted = [...projects]
    .filter((p) => showDone || p.status !== "done")
    .sort((a, b) => {
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
          {doneCount > 0 && (
            <>
              <span>·</span>
              <button
                onClick={() => setShowDone(!showDone)}
                className="text-gray-500 hover:text-gray-300 transition"
              >
                {showDone ? "Hide" : "Show"} {doneCount} done
              </button>
            </>
          )}
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

              // Use leaf tasks for progress if they exist, otherwise use epics
              const epicsOnly = projectEpics.filter((t) => t.tags?.includes("epic"));
              const leafTasks = [...allProjectTasks, ...directTasks];
              const hasLeafTasks = leafTasks.length > 0;
              const totalForProgress = hasLeafTasks ? leafTasks.length : epicsOnly.length;
              const doneForProgress = hasLeafTasks
                ? leafTasks.filter((t) => t.status === "done").length
                : epicsOnly.filter((t) => t.status === "done").length;

              return (
                <ProjectCard
                  key={project.id}
                  project={project}
                  epics={epicsOnly}
                  totalTasks={totalForProgress}
                  doneTasks={doneForProgress}
                  isExpanded={expandedProject === project.id}
                  onToggle={() =>
                    setExpandedProject(expandedProject === project.id ? null : project.id)
                  }
                />
              );
            })}
          </div>

          {/* Project detail modal */}
          {expandedProject && (
            <ProjectDetailModal
              project={sorted.find((p) => p.id === expandedProject)!}
              epics={(subTasksByParent[expandedProject] || []).filter((t) =>
                t.tags?.includes("epic")
              )}
              subTasksByParent={subTasksByParent}
              onClose={() => setExpandedProject(null)}
            />
          )}
        </>
      )}

      {showCreate && <CreateEpicModal onClose={() => setShowCreate(false)} />}
    </>
  );
}
