import { parsePersistedQaPolicy } from "@/lib/loops/qa-policy";

export type WorkflowMode = "linear" | "dag";
export type WorkflowItemStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "review_pending"
  | "qa_pending"
  | "rework_required"
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
  metadata?: Record<string, unknown> | null;
};

export type QaPolicySummary = {
  required: boolean;
  targetUrl: string | null;
  viewports: Array<{ name: string; width: number; height: number }>;
  flowCount: number;
};

export type ShadowDependencyRow = {
  task_id: string;
  depends_on_task_id: string;
  dependency_type: "hard" | "soft";
};

export type ShadowRunRow = {
  id: string;
  task_id: string;
  status: string;
  run_role?: "implementation" | "review" | "qa";
  quality_cycle?: number;
  artifact_sha?: string | null;
  target_sha?: string | null;
};

export type ShadowReviewRow = {
  id: string;
  task_id: string;
  task_run_id: string | null;
  task_run_owned?: boolean | null;
  status: string;
  quality_cycle?: number | null;
  reviewed_sha?: string | null;
  findings_count?: number;
};

export type ShadowEvidenceRow = {
  id: string;
  task_id: string;
  task_run_id: string | null;
  task_run_owned?: boolean | null;
  kind: string;
};

export type ShadowHistoryCountRow = {
  task_id: string;
  count: number | string;
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
  runCounts?: ShadowHistoryCountRow[];
  reviewCounts?: ShadowHistoryCountRow[];
  evidenceCounts?: ShadowHistoryCountRow[];
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
  runCount: number;
  runStatuses: string[];
  reviewCount: number;
  reviewStatuses: string[];
  evidenceCount: number;
  evidenceKinds: string[];
  qaPolicy?: QaPolicySummary;
  qualityCycle?: number;
  qualityState?: "implementation" | "review" | "qa" | "approved" | "blocked";
  implementationStatus?: string | null;
  reviewRunStatus?: string | null;
  artifactSha?: string | null;
  latestReviewStatus?: string | null;
  findingsCount?: number;
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
  historyCompleteness: "partial" | "bounded";
  planRevision: {
    id: string;
    revisionNumber: number;
    status: string;
  } | null;
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
  if (["pending", "ready", "in_progress", "review_pending", "qa_pending", "rework_required", "blocked", "completed", "skipped"].includes(status || "")) {
    return status as WorkflowItemStatus;
  }
  return "pending";
}

const NO_QA_POLICY: QaPolicySummary = { required: false, targetUrl: null, viewports: [], flowCount: 0 };

function qaPolicySummary(task: ShadowTaskRow): QaPolicySummary {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !Object.hasOwn(metadata, "qa_policy")) return { ...NO_QA_POLICY, viewports: [] };
  const policy = parsePersistedQaPolicy(metadata.qa_policy);
  if (!policy) throw new Error(`Task ${task.id} QA policy metadata is invalid`);
  if (!policy.required) return { ...NO_QA_POLICY, viewports: [] };
  return {
    required: true,
    targetUrl: policy.target_url,
    viewports: policy.viewports.map((viewport) => ({ ...viewport })),
    flowCount: policy.flows.length,
  };
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

function historyCounts(
  rows: ShadowHistoryCountRow[] | undefined,
  fallbackRows: Array<{ task_id: string }>,
  selectedTaskIds: Set<string>,
  label: string,
): Map<string, number> {
  if (rows === undefined) {
    const fallback = new Map<string, number>();
    for (const row of fallbackRows) fallback.set(row.task_id, (fallback.get(row.task_id) ?? 0) + 1);
    return fallback;
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!selectedTaskIds.has(row.task_id)) {
      throw new Error(`${label} count references task ${row.task_id} outside the current plan revision`);
    }
    const count = typeof row.count === "string"
      ? (/^\d+$/.test(row.count) ? Number(row.count) : Number.NaN)
      : row.count;
    if (!Number.isSafeInteger(count) || count < 0 || counts.has(row.task_id)) {
      throw new Error(`V2 ${label} count snapshot is inconsistent for task ${row.task_id}`);
    }
    counts.set(row.task_id, count);
  }
  return counts;
}

function projectV1(loop: ShadowLoopRow): LoopWorkflowShadow {
  if (loop.mode !== "linear") {
    throw new Error(`V1 Loop ${loop.id} must use linear mode`);
  }
  if (loop.current_plan_revision_id !== null) {
    throw new Error(`V1 Loop ${loop.id} must not have a current plan revision`);
  }
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
      runCount: 0,
      runStatuses: [],
      reviewCount: 0,
      reviewStatuses: [],
      evidenceCount: 0,
      evidenceKinds: [],

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
  if (loop.mode !== "linear" && loop.mode !== "dag") {
    throw new Error(`V2 Loop ${loop.id} has unsupported mode: ${String(loop.mode)}`);
  }
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
  for (const dependency of input.dependencies) {
    const taskIsCurrent = selectedTaskIds.has(dependency.task_id);
    const dependencyIsCurrent = selectedTaskIds.has(dependency.depends_on_task_id);
    if (taskIsCurrent !== dependencyIsCurrent) {
      throw new Error(
        `Task ${dependency.task_id} dependency ${dependency.depends_on_task_id} points outside the current plan revision`,
      );
    }
  }
  const adjacency = new Map<string, string[]>(
    Array.from(selectedTaskIds, (taskId): [string, string[]] => [taskId, []]),
  );
  for (const dependency of input.dependencies) {
    if (selectedTaskIds.has(dependency.task_id)) {
      adjacency.get(dependency.task_id)?.push(dependency.depends_on_task_id);
    }
  }
  const visitState = new Map<string, 1 | 2>();
  const visit = (taskId: string): void => {
    if (visitState.get(taskId) === 1) {
      throw new Error(`V2 Loop ${loop.id} dependency graph contains a cycle`);
    }
    if (visitState.get(taskId) === 2) return;
    visitState.set(taskId, 1);
    for (const dependencyId of adjacency.get(taskId) ?? []) visit(dependencyId);
    visitState.set(taskId, 2);
  };
  for (const taskId of selectedTaskIds) visit(taskId);

  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  for (const item of [...input.reviews, ...input.evidence]) {
    if (!selectedTaskIds.has(item.task_id) || item.task_run_id === null) continue;
    const ownershipIsValid = item.task_run_owned === undefined
      ? runsById.get(item.task_run_id)?.task_id === item.task_id
      : item.task_run_owned === true;
    if (!ownershipIsValid) {
      throw new Error(`${item.id} task run does not belong to task ${item.task_id}`);
    }
  }

  const runCounts = historyCounts(input.runCounts, input.runs, selectedTaskIds, "run");
  const reviewCounts = historyCounts(input.reviewCounts, input.reviews, selectedTaskIds, "review");
  const evidenceCounts = historyCounts(input.evidenceCounts, input.evidence, selectedTaskIds, "evidence");

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
      .map((task) => {
        const taskRuns = input.runs.filter((run) => run.task_id === task.id);
        const implementationRuns = taskRuns.filter((run) => (run.run_role ?? "implementation") === "implementation");
        const latestImplementation = implementationRuns.slice().sort((left, right) =>
          (right.quality_cycle ?? 1) - (left.quality_cycle ?? 1) || right.id.localeCompare(left.id)
        )[0];
        const qualityCycle = latestImplementation?.quality_cycle ?? 1;
        const latestReviewRun = taskRuns.find((run) => run.run_role === "review" && (run.quality_cycle ?? 1) === qualityCycle);
        const latestReview = input.reviews
          .filter((review) => review.task_id === task.id && (review.quality_cycle ?? 1) === qualityCycle)
          .sort((left, right) => right.id.localeCompare(left.id))[0];
        const qualityState: ShadowTask["qualityState"] = task.status === "blocked"
          ? "blocked"
          : task.status === "qa_pending"
            ? "qa"
          : latestReview?.status === "approved"
            ? "approved"
            : latestReviewRun || task.status === "review_pending"
              ? "review"
              : "implementation";
        return ({
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
        runCount: runCounts.get(task.id) ?? 0,
        runStatuses: taskRuns.map((run) => run.status),
        reviewCount: reviewCounts.get(task.id) ?? 0,
        reviewStatuses: input.reviews.filter((review) => review.task_id === task.id).map((review) => review.status),
        evidenceCount: evidenceCounts.get(task.id) ?? 0,
        evidenceKinds: input.evidence.filter((item) => item.task_id === task.id).map((item) => item.kind),
        qaPolicy: qaPolicySummary(task),
        qualityCycle,
        qualityState,
        implementationStatus: latestImplementation?.status ?? null,
        reviewRunStatus: latestReviewRun?.status ?? null,
        artifactSha: latestImplementation?.artifact_sha ?? null,
        latestReviewStatus: latestReview?.status ?? null,
        findingsCount: latestReview?.findings_count ?? 0,
      });
      }),
  }));

  return {
    loopId: loop.id,
    workflowVersion: 2,
    mode: loop.mode,
    source: "v2_normalized",
    historyCompleteness: "bounded",
    planRevision: {
      id: revision.id,
      revisionNumber: revision.revision_number,
      status: revision.status,
    },
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
