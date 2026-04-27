"use client";

import type { ProjectGalleryCard } from "@/lib/projects/read-model";
import { QueuedExecutionHint } from "./QueuedExecutionHint";

const WORKFLOW_STEPS = ["Clarify", "Plan", "Approve", "Execute", "Review", "Done"];

function deriveWorkflowStep(status: string) {
  if (["drafting", "needs_clarification"].includes(status)) return 0;
  if (["planning", "planned"].includes(status)) return 1;
  if (["needs_approval", "approved", "queued"].includes(status)) return 2;
  if (["in_progress", "active", "paused", "blocked"].includes(status)) return 3;
  if (["in_review"].includes(status)) return 4;
  if (["completed", "archived"].includes(status)) return 5;
  return 1;
}

function deriveDot(project: ProjectGalleryCard) {
  if (["needs_clarification", "needs_approval", "in_review"].includes(project.status)) return "bg-amber-400";
  if (project.running || project.status === "queued") return "bg-emerald-400";
  return "bg-gray-500";
}

export function ProjectCard({
  project,
  onOpen,
}: {
  project: ProjectGalleryCard;
  onOpen: () => void;
}) {
  const activeStep = deriveWorkflowStep(project.status);
  const dotClass = deriveDot(project);

  return (
    <button
      onClick={onOpen}
      className="flex h-60 w-full flex-col overflow-hidden rounded-xl border border-gray-800 bg-[#111118] p-5 text-left transition hover:border-gray-600"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-lg font-semibold text-white">{project.title}</h3>
          <p className="mt-2 line-clamp-3 text-sm text-gray-400">{project.summary || "No summary yet"}</p>
        </div>
        <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${dotClass}`} />
      </div>

      <div className="mb-auto">
        {project.status === "queued" && (
          <div className="mt-1">
            <QueuedExecutionHint compact />
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-1.5">
          {WORKFLOW_STEPS.map((step, index) => (
            <div key={step} className="flex min-w-0 flex-1 items-center gap-1.5">
              <div
                className={`h-1.5 flex-1 rounded-full ${index <= activeStep ? "bg-blue-400" : "bg-gray-800"}`}
              />
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}
