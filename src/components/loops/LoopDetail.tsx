"use client";

import { useRouter } from "next/navigation";
import type { ClarificationQuestion, PlanStep, LoopDetailPayload } from "@/lib/loops/read-model";
import { ApprovalDecisionBox } from "./ApprovalDecisionBox";
import { SubmitClarificationBox } from "./SubmitClarificationBox";
import { LoopReviewActions } from "./LoopReviewActions";
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

function deriveDotClass(status: string, needsMyAttention: boolean) {
  if (needsMyAttention || ["needs_clarification", "needs_approval", "in_review"].includes(status)) return "bg-amber-400";
  if (["queued", "in_progress", "active"].includes(status)) return "bg-emerald-400";
  return "bg-gray-500";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-800 bg-[#111118] p-4">
      <h3 className="mb-3 text-sm font-semibold text-white">{title}</h3>
      {children}
    </section>
  );
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function LoopDetail({
  loop,
  onClose,
}: {
  loop: LoopDetailPayload;
  onClose: () => void;
}) {
  const router = useRouter();
  const activeStep = deriveWorkflowStep(loop.status);
  const dotClass = deriveDotClass(loop.status, loop.needsMyAttention);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-gray-800 bg-[#0d0d14] px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-bold text-white">{loop.title}</h2>
                <span className={`h-3 w-3 rounded-full ${dotClass}`} />
              </div>
              <p className="mt-2 text-sm text-gray-400">{loop.summary || "No summary yet"}</p>
              <div className="mt-4">
                <div className="flex items-center gap-1.5">
                  {WORKFLOW_STEPS.map((step, index) => (
                    <div key={step} className="flex min-w-0 flex-1 items-center gap-1.5">
                      <div className={`h-1.5 flex-1 rounded-full ${index <= activeStep ? "bg-blue-400" : "bg-gray-800"}`} />
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500">
                  {WORKFLOW_STEPS.map((step) => (
                    <span key={step} className="min-w-0 flex-1 truncate text-center">{step}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="rounded p-1 text-gray-500 transition hover:text-white">✕</button>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-6 py-4">
          {loop.status === "queued" && <QueuedExecutionHint />}

          <Section title="Clarification">
            {loop.clarificationQuestions.length === 0 && loop.clarificationHistory.length === 0 ? (
              <p className="text-sm text-gray-500">No clarification activity yet.</p>
            ) : (
              <div className="space-y-2">
                {loop.clarificationQuestions.map((q: ClarificationQuestion) => {
                  const isOpen = (q.status || "open") === "open";
                  const showAwaiting = isOpen && loop.status === "needs_clarification";
                  return (
                    <div key={q.id} className="rounded border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-gray-300">
                      <p><span className="font-medium text-amber-300">Q:</span> {q.question}</p>
                      {showAwaiting ? (
                        <p className="mt-1 text-xs text-amber-200/70">Awaiting answer{q.reason ? ` • ${q.reason}` : ""}</p>
                      ) : q.reason ? (
                        <p className="mt-1 text-xs text-amber-200/70">{q.reason}</p>
                      ) : null}
                    </div>
                  );
                })}
                {loop.clarificationHistory.slice(loop.clarificationQuestions.length).map((entry, index) => (
                  <div key={`${entry.responded_at}-${index}`} className="rounded border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-gray-300">
                    <p className="whitespace-pre-wrap"><span className="font-medium text-emerald-300">A:</span> {entry.response}</p>
                  </div>
                ))}
                {loop.status === "needs_clarification" && (
                  <SubmitClarificationBox
                    loopId={loop.id}
                    onDone={() => {
                      router.refresh();
                      onClose();
                    }}
                  />
                )}
              </div>
            )}
          </Section>

          {loop.deliverable && (
            <Section title="Latest Deliverable">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                  <span className="rounded-full border border-gray-700 px-2 py-0.5 text-gray-300">{loop.deliverable.status || "unknown"}</span>
                  {loop.deliverable.completedAt && <span>Completed {formatTimestamp(loop.deliverable.completedAt)}</span>}
                  {!loop.deliverable.completedAt && loop.deliverable.updatedAt && <span>Updated {formatTimestamp(loop.deliverable.updatedAt)}</span>}
                </div>

                {loop.deliverable.summary ? (
                  <div className="rounded border border-emerald-900/40 bg-emerald-950/20 p-3">
                    <p className="whitespace-pre-wrap text-sm text-gray-200">{loop.deliverable.summary}</p>
                  </div>
                ) : (
                  <p className="text-sm text-amber-200/80">No final deliverable text was captured for the latest execution yet.</p>
                )}

                {loop.deliverable.instruction && (
                  <details className="rounded border border-gray-800 bg-[#0d0d14] p-3">
                    <summary className="cursor-pointer text-sm text-gray-300">Execution instruction</summary>
                    <p className="mt-3 whitespace-pre-wrap text-sm text-gray-400">{loop.deliverable.instruction}</p>
                  </details>
                )}
              </div>
            </Section>
          )}

          <Section title="Compact Plan">
            {loop.plan.length === 0 ? (
              <p className="text-sm text-gray-500">No plan steps yet.</p>
            ) : (
              <div className="space-y-2">
                {loop.plan.map((step: PlanStep) => (
                  <div key={step.id} className="flex items-start justify-between gap-3 rounded border border-gray-800 bg-[#0d0d14] p-3">
                    <div>
                      <p className="text-sm text-white">{step.title}</p>
                      {step.notes && <p className="mt-1 text-xs text-gray-500">{step.notes}</p>}
                    </div>
                    <span className="rounded-full border border-gray-700 px-2 py-0.5 text-xs text-gray-300">{step.status || "pending"}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {loop.status === "needs_approval" && (
            <section className="rounded-lg border border-gray-800 bg-[#111118] p-4">
              <p className="text-sm text-gray-300">This loop is waiting for your approval before it can move into queue.</p>
              <div className="mt-4">
                <ApprovalDecisionBox
                  loopId={loop.id}
                  onDone={() => {
                    router.refresh();
                    onClose();
                  }}
                />
              </div>
            </section>
          )}

          {loop.deliverable?.dispatchState && ["waking_agent", "retrying_notify", "notified_agent", "claimed_by_agent"].includes(loop.deliverable.dispatchState) && (
            <section className="rounded-lg border border-gray-800 bg-[#111118] p-4">
              <p className="text-sm text-gray-300">
                {loop.deliverable.dispatchState === "waking_agent" && "Waking assigned agent now."}
                {loop.deliverable.dispatchState === "retrying_notify" && "Retrying agent dispatch after a transient wake failure."}
                {loop.deliverable.dispatchState === "notified_agent" && "Agent was notified and Mission Control is waiting for claim."}
                {loop.deliverable.dispatchState === "claimed_by_agent" && "Agent claimed the work item and execution is now live."}
              </p>
            </section>
          )}

          {(loop.status === "in_progress" || loop.status === "in_review") && (
            <LoopReviewActions
              loopId={loop.id}
              status={loop.status}
              onDone={() => {
                router.refresh();
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
