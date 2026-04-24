"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreateEpicModal } from "./CreateEpicModal";
import { ProjectCardV1 } from "./ProjectCardV1";
import { ProjectDetailV1 } from "./ProjectDetailV1";
import { WorkflowLegendDemo } from "./WorkflowLegendDemo";
import { QueueSchedulerStatus } from "./QueueSchedulerStatus";
import type { ProjectDetailPayload, ProjectGalleryCard } from "@/lib/projects/read-model";

export function ProjectsClient({
  projects,
  projectDetails,
}: {
  projects: ProjectGalleryCard[];
  projectDetails: Record<string, ProjectDetailPayload>;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    const hasLiveProjects = projects.some((p) =>
      ["planning", "queued", "in_progress", "active", "needs_clarification", "needs_approval", "in_review"].includes(p.status)
    );

    if (!hasLiveProjects) return;

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, 5000);

    return () => window.clearInterval(interval);
  }, [projects, router]);

  const completedCount = projects.filter((p) => p.status === "completed").length;
  const priorityOrder = { high: 0, medium: 1, low: 2 };

  const humanQueue = [...projects]
    .filter((p) => ["needs_clarification", "needs_approval", "in_review"].includes(p.status))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 3);

  const executionQueue = [...projects]
    .filter((p) => ["queued", "in_progress", "active"].includes(p.status) || (p.status === "planning" && p.readyToRun))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    })
    .slice(0, 3);

  const queueIds = new Set([...humanQueue, ...executionQueue].map((p) => p.id));

  const sorted = [...projects]
    .filter((p) => showCompleted || p.status !== "completed")
    .filter((p) => !queueIds.has(p.id))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
          <span>{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{projects.filter((p) => p.status !== "completed").length} active</span>
          {completedCount > 0 && (
            <>
              <span>·</span>
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                className="text-gray-500 transition hover:text-gray-300"
              >
                {showCompleted ? "Hide" : "Show"} {completedCount} completed
              </button>
            </>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          + New Project
        </button>
      </div>

      {humanQueue.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Human Queue</h2>
              <p className="text-xs text-gray-500">Clarify, approve, or review items that currently need you.</p>
            </div>
            <div className="text-xs text-gray-500">{humanQueue.length} waiting on you</div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {humanQueue.map((project) => (
              <button
                key={project.id}
                onClick={() => setExpandedProject(project.id)}
                className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-3 text-left transition hover:border-gray-700"
              >
                <div className="truncate text-sm font-medium text-white">{project.title}</div>
                <div className="mt-1 text-xs text-amber-300">{project.status.replaceAll("_", " ")}</div>
                <div className="mt-1 text-xs text-gray-500">priority {project.priority}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {executionQueue.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Execution Queue</h2>
              <p className="text-xs text-gray-500">Projects being planned or executed by the system.</p>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">{executionQueue.length} in system flow</div>
              <QueueSchedulerStatus />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {executionQueue.map((project, index) => (
              <button
                key={project.id}
                onClick={() => setExpandedProject(project.id)}
                className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-3 text-left transition hover:border-gray-700"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">#{index + 1}</span>
                  <div className="truncate text-sm font-medium text-white">{project.title}</div>
                </div>
                <div className="mt-1 text-xs text-blue-300">{project.dispatchState === "waking_agent" ? "Waking agent" : project.dispatchState === "retrying_notify" ? "Retrying dispatch" : project.dispatchState === "notified_agent" ? "Agent notified" : project.status === "in_progress" || project.status === "active" ? "Processing now" : project.status === "planning" ? "Planning" : "Waiting for scheduler"}</div>
                <div className="mt-1 text-xs text-gray-500">{project.status.replaceAll("_", " ")} · priority {project.priority}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-12 text-center">
          <p className="text-lg text-gray-500">No projects yet</p>
          <p className="mt-1 text-sm text-gray-600">Create a project to start planning work</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sorted.map((project) => (
              <ProjectCardV1 key={project.id} project={project} onOpen={() => setExpandedProject(project.id)} />
            ))}
          </div>
          <WorkflowLegendDemo />
        </div>
      )}

      {expandedProject && projectDetails[expandedProject] && (
        <ProjectDetailV1 project={projectDetails[expandedProject]} onClose={() => setExpandedProject(null)} />
      )}

      {showCreate && <CreateEpicModal onClose={() => setShowCreate(false)} />}
    </>
  );
}
