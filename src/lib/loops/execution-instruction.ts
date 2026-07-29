type PlanStep = {
  title?: string | null;
  status?: string | null;
  notes?: string | null;
};

type ClarificationHistoryEntry = {
  response?: string | null;
};

type LoopInstructionContext = {
  id?: string | null;
  name?: string | null;
  summary?: string | null;
  description?: string | null;
  target_outcome?: string | null;
  acceptance_criteria?: string[] | null;
  plan?: PlanStep[] | null;
  metadata?: {
    original_input?: unknown;
    clarification_history?: ClarificationHistoryEntry[] | null;
  } | null;
  approval_scope?: {
    allowed_actions?: string[] | null;
    forbidden_actions?: string[] | null;
    notes?: string | null;
  } | null;
};

function listSection(label: string, values: string[] | null | undefined) {
  if (!Array.isArray(values) || values.length === 0) return `${label}:\n- (none specified)`;
  return `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function originalInput(loop: LoopInstructionContext) {
  const stored = loop.metadata?.original_input;
  if (typeof stored === "string") return stored;
  return loop.description ?? loop.summary ?? loop.name ?? "";
}

function clarificationContext(loop: LoopInstructionContext) {
  const history = Array.isArray(loop.metadata?.clarification_history)
    ? loop.metadata.clarification_history
    : [];
  const responses = history
    .map((entry) => typeof entry?.response === "string" ? entry.response.trim() : "")
    .filter(Boolean);
  return responses.length
    ? `Latest clarification from requester:\n${responses.map((response) => `- ${response}`).join("\n")}`
    : null;
}

/**
 * Durable execution guardrails shared by materialization, wake, and retry paths.
 * The original input is deliberately interpolated without trimming or rewriting.
 */
export function buildLoopWakeContext(loop: LoopInstructionContext) {
  const scope = loop.approval_scope || {};
  return [
    "Original requester input (verbatim; do not reinterpret or weaken):",
    `--- BEGIN ORIGINAL INPUT ---\n${originalInput(loop)}\n--- END ORIGINAL INPUT ---`,
    "Execution restrictions (these remain binding for every wake and retry):",
    listSection("Allowed actions", scope.allowed_actions),
    listSection("Forbidden actions", scope.forbidden_actions),
    scope.notes ? `Approval notes: ${scope.notes}` : null,
    listSection("Acceptance criteria", loop.acceptance_criteria),
    clarificationContext(loop),
  ].filter((part): part is string => typeof part === "string").join("\n\n");
}

export function buildLoopExecutionInstruction(loop: LoopInstructionContext) {
  const plan = Array.isArray(loop.plan) ? loop.plan : [];
  return [
    `Loop: ${loop.name || "Untitled Loop"}`,
    loop.summary ? `Summary: ${loop.summary}` : null,
    loop.target_outcome ? `Target outcome: ${loop.target_outcome}` : null,
    plan.length
      ? `Plan:\n${plan.map((step, index) => (
          `- ${index + 1}. ${step.title || "Untitled step"}${step.notes ? ` (${step.notes})` : ""}`
        )).join("\n")}`
      : null,
    buildLoopWakeContext(loop),
  ].filter((part): part is string => typeof part === "string").join("\n\n");
}

export function buildLoopTaskExecutionInstruction(context: {
  taskKey: string;
  title: string;
  description?: string | null;
  acceptanceCriteria: string[];
  approvalScope?: {
    allowed_actions?: string[] | null;
    forbidden_actions?: string[] | null;
    notes?: string | null;
  } | null;
}) {
  const scope = context.approvalScope || {};
  return [
    `Task key: ${context.taskKey}`,
    `Objective: ${context.title}`,
    context.description ? `Task description:\n${context.description}` : null,
    listSection("Acceptance criteria", context.acceptanceCriteria),
    "Approved execution restrictions:",
    listSection("Allowed actions", scope.allowed_actions),
    listSection("Forbidden actions", scope.forbidden_actions),
    scope.notes ? `Approval notes: ${scope.notes}` : null,
    "Complete only this task. Do not expand into other project tasks.",
  ].filter((part): part is string => typeof part === "string").join("\n\n");
}

export function buildLoopReworkInstruction(
  loop: LoopInstructionContext,
  feedback: string,
  fallbackLoopId?: string,
) {
  return [
    buildLoopExecutionInstruction({
      ...loop,
      name: loop.name || fallbackLoopId || "Untitled Loop",
    }),
    "Review requested changes:",
    feedback || "No explicit feedback provided. Rework the deliverable based on review comments and produce an updated final output.",
    "Important: produce a fresh updated deliverable, and persist the final answer in payload.result/output/summary when completing the work item.",
  ].join("\n\n");
}
