export type WorkflowMode = "linear" | "dag";
export type WorkflowItemStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "blocked"
  | "completed"
  | "skipped"
  | "cancelled";

export type ShadowLoopRow = {
  id: string;
  workflow_version: number;
  mode: WorkflowMode;
  current_plan_revision_id: string | null;
  plan: Array<{
    id?: string;
    title?: string;
    status?: string;
    notes?: string | null;
  }> | null;
};

export type ShadowPlanRevisionRow = {
  id: string;
  loop_id: string;
  revision_number: number;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

export type ShadowStageRow = {
  id: string;
  plan_revision_id: string;
  key: string;
  title: string;
  description: string | null;
  position: number;
  status: WorkflowItemStatus;
};

export type ShadowTaskRow = {
  id: string;
  stage_id: string;
  key: string;
  title: string;
  description: string | null;
  position: number;
  status: WorkflowItemStatus;
};

export type ShadowDependencyRow = {
  task_id: string;
  depends_on_task_id: string;
  dependency_type: "hard" | "soft";
};

export type ShadowRunRow = {
  id: string;
  task_id: string;
  attempt_number: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  output: Record<string, unknown>;
  created_at?: string;
};

export type ShadowReviewRow = {
  id: string;
  task_id: string;
  task_run_id: string | null;
  status: string;
  reviewer: string | null;
  feedback: string | null;
  decided_at: string | null;
  created_at: string;
};

export type ShadowEvidenceRow = {
  id: string;
  task_id: string;
  task_run_id: string | null;
  kind: string;
  uri: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LoopWorkflowShadowInput = {
  loop: ShadowLoopRow;
  planRevisions: ShadowPlanRevisionRow[];
  stages: ShadowStageRow[];
  tasks: ShadowTaskRow[];
  dependencies: ShadowDependencyRow[];
  runs: ShadowRunRow[];
  reviews: ShadowReviewRow[];
  evidence: ShadowEvidenceRow[];
};

export type ShadowTask = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  position: number;
  status: WorkflowItemStatus;
  synthetic: boolean;
  dependencies: string[];
  runs: ShadowRunRow[];
  reviews: ShadowReviewRow[];
  evidence: ShadowEvidenceRow[];
};

export type ShadowStage = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  position: number;
  status: WorkflowItemStatus;
  synthetic: boolean;
  tasks: ShadowTask[];
};

export type LoopWorkflowShadow = {
  loopId: string;
  workflowVersion: 1 | 2;
  mode: WorkflowMode;
  source: "v1_synthetic" | "v2_normalized";
  historyCompleteness: "partial" | "complete";
  planRevision: ShadowPlanRevisionRow | null;
  stages: ShadowStage[];
};

function comparePositionAndId(
  left: { position: number; id: string },
  right: { position: number; id: string },
): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function normalizeLegacyStatus(status: string | undefined): WorkflowItemStatus {
  if (status === "done") return "completed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (["pending", "ready", "in_progress", "blocked", "completed", "skipped"].includes(status || "")) {
    return status as WorkflowItemStatus;
  }
  return "pending";
}

function stageStatusFor(tasks: ShadowTask[]): WorkflowItemStatus {
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed" || task.status === "skipped")) {
    return "completed";
  }
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "in_progress" || task.status === "completed")) return "in_progress";
  if (tasks.some((task) => task.status === "ready")) return "ready";
  return "pending";
}

function projectV1(loop: ShadowLoopRow): LoopWorkflowShadow {
  const plan = Array.isArray(loop.plan) ? loop.plan : [];
  const sourceSteps = plan.length > 0
    ? plan
    : [{ id: "execution", title: "Legacy Loop execution", status: "pending", notes: null }];
  const tasks: ShadowTask[] = sourceSteps.map((step, position) => {
    const key = typeof step.id === "string" && step.id.length > 0 ? step.id : String(position);
    return {
      id: `synthetic:${loop.id}:task:${key}`,
      key,
      title: typeof step.title === "string" && step.title.length > 0 ? step.title : `Legacy step ${position + 1}`,
      description: typeof step.notes === "string" ? step.notes : null,
      position,
      status: normalizeLegacyStatus(step.status),
      synthetic: true,
      dependencies: position === 0 ? [] : [`synthetic:${loop.id}:task:${
        typeof sourceSteps[position - 1].id === "string" && sourceSteps[position - 1].id
          ? sourceSteps[position - 1].id
          : String(position - 1)
      }`],
      runs: [],
      reviews: [],
      evidence: [],
    };
  });

  return {
    loopId: loop.id,
    workflowVersion: 1,
    mode: "linear",
    source: "v1_synthetic",
    historyCompleteness: "partial",
    planRevision: null,
    stages: [{
      id: `synthetic:${loop.id}:stage`,
      key: "legacy-plan",
      title: "Legacy plan",
      description: null,
      position: 0,
      status: stageStatusFor(tasks),
      synthetic: true,
      tasks,
    }],
  };
}

function projectV2(input: LoopWorkflowShadowInput): LoopWorkflowShadow {
  const { loop } = input;
  if (!loop.current_plan_revision_id) {
    throw new Error(`V2 Loop ${loop.id} has no current plan revision`);
  }
  const revision = input.planRevisions.find((candidate) =>
    candidate.id === loop.current_plan_revision_id && candidate.loop_id === loop.id
  );
  if (!revision) {
    throw new Error(`V2 Loop ${loop.id} current plan revision is absent from the shadow snapshot`);
  }

  const stageRows = input.stages
    .filter((stage) => stage.plan_revision_id === revision.id)
    .slice()
    .sort(comparePositionAndId);
  const selectedStageIds = new Set(stageRows.map((stage) => stage.id));
  const selectedTaskIds = new Set(
    input.tasks.filter((task) => selectedStageIds.has(task.stage_id)).map((task) => task.id),
  );

  const stages = stageRows.map<ShadowStage>((stage) => ({
    id: stage.id,
    key: stage.key,
    title: stage.title,
    description: stage.description,
    position: stage.position,
    status: stage.status,
    synthetic: false,
    tasks: input.tasks
      .filter((task) => task.stage_id === stage.id)
      .slice()
      .sort(comparePositionAndId)
      .map((task) => ({
        id: task.id,
        key: task.key,
        title: task.title,
        description: task.description,
        position: task.position,
        status: task.status,
        synthetic: false,
        dependencies: input.dependencies
          .filter((dependency) => dependency.task_id === task.id && selectedTaskIds.has(dependency.depends_on_task_id))
          .map((dependency) => dependency.depends_on_task_id)
          .sort(),
        runs: input.runs
          .filter((run) => run.task_id === task.id)
          .slice()
          .sort((left, right) => left.attempt_number - right.attempt_number || left.id.localeCompare(right.id)),
        reviews: input.reviews
          .filter((review) => review.task_id === task.id)
          .slice()
          .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)),
        evidence: input.evidence
          .filter((item) => item.task_id === task.id)
          .slice()
          .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)),
      })),
  }));

  return {
    loopId: loop.id,
    workflowVersion: 2,
    mode: loop.mode,
    source: "v2_normalized",
    historyCompleteness: "complete",
    planRevision: { ...revision },
    stages,
  };
}

/**
 * Pure phase-1 shadow projection. It accepts an already-loaded snapshot and has
 * no persistence, network, runtime scheduling, or UI side effects.
 */
export function projectLoopWorkflowShadow(input: LoopWorkflowShadowInput): LoopWorkflowShadow {
  if (input.loop.workflow_version === 1) return projectV1(input.loop);
  if (input.loop.workflow_version === 2) return projectV2(input);
  throw new Error(`Unsupported Loop workflow version: ${input.loop.workflow_version}`);
}
