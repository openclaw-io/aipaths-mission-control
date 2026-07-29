"use client";

import type { LoopGalleryCard } from "@/lib/loops/read-model";
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

function deriveDot(loop: LoopGalleryCard) {
  if (["needs_clarification", "needs_approval", "in_review"].includes(loop.status)) return "bg-amber-400";
  if (loop.running || loop.status === "queued") return "bg-emerald-400";
  return "bg-gray-500";
}

export function LoopCard({
  loop,
  onOpen,
}: {
  loop: LoopGalleryCard;
  onOpen: () => void;
}) {
  const activeStep = deriveWorkflowStep(loop.status);
  const dotClass = deriveDot(loop);

  return (
    <button
      onClick={onOpen}
      className="flex h-60 w-full flex-col overflow-hidden rounded-xl border border-gray-800 bg-[#111118] p-5 text-left transition hover:border-gray-600"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-lg font-semibold text-white">{loop.title}</h3>
          <p className="mt-2 line-clamp-3 text-sm text-gray-400">{loop.summary || "No summary yet"}</p>
        </div>
        <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${dotClass}`} />
      </div>

      <div className="mb-auto">
        {loop.status === "queued" && (
          <div className="mt-1">
            <QueuedExecutionHint compact />
          </div>
        )}
      </div>

      <div className="mt-4">
        {loop.progressLabel?.endsWith(" tasks") && (
          <div className="mb-2 text-xs text-gray-500">{loop.progressLabel}</div>
        )}
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
