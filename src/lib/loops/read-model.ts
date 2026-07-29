import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRows } from "@/lib/db/mission-control";
import { query, withTransaction } from "@/lib/db/postgres";
import type { PoolClient } from "pg";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getLoopStatusForPrimaryExecution,
  getPrimaryExecutionWorkItem,
  listPrimaryExecutionWorkItems,
  type PrimaryExecutionWorkItem,
} from "@/lib/loops/lifecycle";
import {
  getPrimaryExecutionWorkItemLocal,
  listPrimaryExecutionWorkItemsLocal,
} from "@/lib/loops/lifecycle-local";
import {
  projectLoopWorkflowShadow,
  type LoopWorkflowShadow,
  type ShadowDependencyRow,
  type ShadowEvidenceRow,
  type ShadowHistoryCountRow,
  type ShadowPlanRevisionRow,
  type ShadowReviewRow,
  type ShadowRunRow,
  type ShadowStageRow,
  type ShadowTaskRow,
  type WorkflowMode,
} from "@/lib/loops/read-model-v2-shadow";

export type PlanStep = {
  id: string;
  title: string;
  status?: string;
  notes?: string | null;
};

export type ClarificationQuestion = {
  id: string;
  question: string;
  reason?: string | null;
  status?: string;
};

export type ApprovalScope = {
  approved?: boolean;
  approved_by?: string | null;
  approved_at?: string | null;
  can_execute_unattended?: boolean;
  allowed_actions?: string[];
  forbidden_actions?: string[];
  notes?: string | null;
};

export type LoopEventPayload = Record<string, unknown>;

export type ClarificationHistoryEntry = {
  responded_at: string;
  responded_by?: string | null;
  response: string;
};

export type LoopGalleryCard = {
  id: string;
  title: string;
  summary: string;
  status: string;
  priority: "high" | "medium" | "low";
  progressLabel: string | null;
  progressPercent: number | null;
  needsMyAttention: boolean;
  readyToRun: boolean;
  blocked: boolean;
  queued: boolean;
  running: boolean;
  dispatchState: string | null;
  nextActionLabel: string | null;
  ownerAgent: string | null;
  deferredUntil: string | null;
  updatedAt: string;
  linkedWorkItemsCount: number;
};

export type LoopDeliverable = {
  workItemId: string;
  title: string | null;
  status: string | null;
  instruction: string | null;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  dispatchState: string | null;
};

type LoopDetailBase = {
  id: string;
  title: string;
  summary: string;
  status: string;
  needsMyAttention: boolean;
  workflowVersion: 1 | 2;
  mode: WorkflowMode;
};

export type LoopDetailV1Payload = LoopDetailBase & {
  workflowVersion: 1;
  priority: "high" | "medium" | "low";
  ownerAgent: string | null;
  targetOutcome: string | null;
  acceptanceCriteria: string[];
  plan: PlanStep[];
  clarificationQuestions: ClarificationQuestion[];
  approvalScope: ApprovalScope;
  notes: string | null;
  metadata: Record<string, unknown>;
  clarificationHistory: ClarificationHistoryEntry[];
  deliverable: LoopDeliverable | null;
  readyToRun: boolean;
  nextActionLabel: string | null;
  blockedReason: string | null;
  deferredUntil: string | null;
  linkedWorkItems: Array<{ id: string; relationType: string }>;
  recentEvents: Array<{
    id: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    actor: string | null;
    payload: LoopEventPayload;
    createdAt: string;
  }>;
};

export type LoopDetailV2Payload = LoopDetailBase & {
  workflowVersion: 2;
  workflow: LoopWorkflowShadow;
};

export type LoopDetailPayload = LoopDetailV1Payload | LoopDetailV2Payload;

type LoopRow = {
  id: string;
  name: string | null;
  title?: string | null;
  description: string | null;
  summary: string | null;
  status: string;
  priority: "high" | "medium" | "low";
  owner_agent: string | null;
  deferred_until: string | null;
  target_outcome?: string | null;
  acceptance_criteria?: string[] | null;
  plan: PlanStep[] | null;
  clarification_questions: ClarificationQuestion[] | null;
  approval_scope: ApprovalScope | null;
  notes?: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
  workflow_version: 1 | 2;
  mode: WorkflowMode;
  current_plan_revision_id: string | null;
  row_version: string | number;
};

type V2TaskProgressRow = {
  loop_id: string;
  revision_id: string;
  status: string;
};

type V2TaskProgress = {
  completed: number;
  total: number;
};

function hasOpenClarifications(loop: LoopRow): boolean {
  return (loop.clarification_questions || []).some((q) => q.status === "open");
}

function deriveNeedsMyAttention(loop: LoopRow): boolean {
  if (["needs_clarification", "needs_approval", "blocked"].includes(loop.status)) {
    return true;
  }
  return hasOpenClarifications(loop);
}

function deriveReadyToRun(loop: LoopRow): boolean {
  if (!["approved", "queued"].includes(loop.status)) return false;
  const scope = loop.approval_scope || {};
  if (typeof scope.can_execute_unattended === "boolean") {
    return scope.can_execute_unattended;
  }
  return true;
}

function deriveNextActionLabel(loop: LoopRow): string | null {
  if (loop.status === "needs_clarification") return "Answer clarification questions";
  if (loop.status === "needs_approval") return "Review and approve plan";
  if (loop.status === "blocked") return "Resolve blocker";
  if (loop.status === "queued" && loop.deferred_until) {
    return `Queued for ${new Date(loop.deferred_until).toLocaleString()}`;
  }
  const nextPlanStep = (loop.plan || []).find((step) => step.status !== "done");
  return nextPlanStep?.title || null;
}

function deriveProgress(
  loop: LoopRow,
  v2TaskProgress?: Map<string, V2TaskProgress>,
): { progressPercent: number | null; progressLabel: string | null } {
  if ((loop.workflow_version ?? 1) === 2) {
    const progress = v2TaskProgress?.get(loop.id) ?? { completed: 0, total: 0 };
    return {
      progressPercent: progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
      progressLabel: `${progress.completed}/${progress.total} tasks`,
    };
  }

  const plan = loop.plan || [];
  if (plan.length > 0) {
    const done = plan.filter((step) => step.status === "done").length;
    const pct = Math.round((done / plan.length) * 100);
    return { progressPercent: pct, progressLabel: `${done}/${plan.length} steps` };
  }

  const byStatus: Record<string, number> = {
    drafting: 5,
    needs_clarification: 10,
    planning: 25,
    needs_approval: 40,
    approved: 55,
    queued: 60,
    in_progress: 75,
    in_review: 90,
    blocked: 75,
    completed: 100,
    planned: 15,
    active: 70,
    paused: 50,
    archived: 100,
  };
  return {
    progressPercent: byStatus[loop.status] ?? null,
    progressLabel: loop.status,
  };
}

function isArchivedFromMainList(loop: LoopRow): boolean {
  const metadata = (loop.metadata || {}) as Record<string, unknown>;
  return metadata.archived_from_main_list === true;
}

function toTitle(loop: LoopRow) {
  return loop.title || loop.name || "Untitled Loop";
}

function toSummary(loop: LoopRow) {
  return loop.summary || loop.description || "";
}

function extractDeliverableSummary(primaryExecution: PrimaryExecutionWorkItem | null): string | null {
  if (!primaryExecution) return null;

  const payload = (primaryExecution.payload || {}) as Record<string, unknown>;
  const candidates = [
    payload.result,
    payload.output,
    payload.deliverable,
    payload.summary,
    payload.final_response,
    payload.finalResponse,
    payload.response,
    payload.message,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  return null;
}

function deriveLoopStatusesFromPrimaryExecution(
  rows: LoopRow[],
  primaryExecutionByLoop: Map<string, PrimaryExecutionWorkItem>
) {
  for (const loop of rows) {
    const primaryExecution = primaryExecutionByLoop.get(loop.id) || null;
    const nextStatus = getLoopStatusForPrimaryExecution(loop.status, primaryExecution?.status);

    if (!nextStatus) continue;

    loop.status = nextStatus;
  }
}

function aggregateV2TaskProgress(
  loopIds: string[],
  taskRows: V2TaskProgressRow[],
): Map<string, V2TaskProgress> {
  const progress = new Map(loopIds.map((loopId): [string, V2TaskProgress] => [
    loopId,
    { completed: 0, total: 0 },
  ]));
  for (const task of taskRows) {
    const item = progress.get(task.loop_id);
    if (!item) {
      throw new Error(`V2 gallery task snapshot references unexpected Loop ${task.loop_id}`);
    }
    item.total += 1;
    if (["completed", "skipped", "cancelled", "canceled"].includes(task.status)) item.completed += 1;
  }
  return progress;
}

async function loadV2TaskProgressLocal(rows: LoopRow[]): Promise<Map<string, V2TaskProgress>> {
  const v2Loops = rows.filter((loop) => (loop.workflow_version ?? 1) === 2);
  const loopIds = v2Loops.map((loop) => loop.id);
  if (v2Loops.length === 0) return new Map();
  if (v2Loops.some((loop) => !loop.current_plan_revision_id)) {
    throw new Error("V2 gallery snapshot has a Loop without a current plan revision");
  }
  const revisionIds = v2Loops.map((loop) => loop.current_plan_revision_id as string);
  const revisionToLoop = new Map(v2Loops.map((loop) => [loop.current_plan_revision_id as string, loop.id]));

  const result = await query<V2TaskProgressRow>(
    `select revision.loop_id, revision.id as revision_id, task.status
     from loop_plan_revisions as revision
     join loop_stages as stage on stage.plan_revision_id = revision.id
     join loop_tasks as task on task.stage_id = stage.id
     where revision.id = any($1::uuid[])`,
    [revisionIds],
  );
  const taskRows = normalizeRows(result.rows || []);
  for (const task of taskRows) {
    if (revisionToLoop.get(task.revision_id) !== task.loop_id) {
      throw new Error(`V2 gallery revision ${task.revision_id} changed ownership during the snapshot`);
    }
  }
  return aggregateV2TaskProgress(loopIds, taskRows);
}

async function loadV2TaskProgressCloud(rows: LoopRow[]): Promise<Map<string, V2TaskProgress>> {
  const v2Loops = rows.filter((loop) => (loop.workflow_version ?? 1) === 2);
  const revisionIds = v2Loops.map((loop) => loop.current_plan_revision_id).filter((id): id is string => Boolean(id));
  if (v2Loops.length === 0) return new Map();
  if (revisionIds.length !== v2Loops.length) {
    throw new Error("V2 gallery snapshot has a Loop without a current plan revision");
  }

  const { data: stages, error: stagesError } = await supabaseAdmin
    .from("loop_stages")
    .select("id,plan_revision_id")
    .in("plan_revision_id", revisionIds);
  if (stagesError) throw stagesError;

  const revisionToLoop = new Map(v2Loops.map((loop) => [loop.current_plan_revision_id as string, loop.id]));
  const stageToLoop = new Map<string, string>();
  for (const stage of stages || []) {
    const loopId = revisionToLoop.get(stage.plan_revision_id);
    if (!loopId) throw new Error(`V2 gallery stage ${stage.id} is outside the selected revisions`);
    stageToLoop.set(stage.id, loopId);
  }

  const stageIds = Array.from(stageToLoop.keys());
  if (stageIds.length === 0) return aggregateV2TaskProgress(v2Loops.map((loop) => loop.id), []);
  const { data: tasks, error: tasksError } = await supabaseAdmin
    .from("loop_tasks")
    .select("stage_id,status")
    .in("stage_id", stageIds);
  if (tasksError) throw tasksError;

  const taskRows = (tasks || []).map((task) => {
    const loopId = stageToLoop.get(task.stage_id);
    if (!loopId) throw new Error(`V2 gallery task references unexpected stage ${task.stage_id}`);
    return { loop_id: loopId, revision_id: revisionIds.find((revisionId) => revisionToLoop.get(revisionId) === loopId) as string, status: task.status };
  });
  return aggregateV2TaskProgress(v2Loops.map((loop) => loop.id), taskRows);
}

const V2_HISTORY_LIMIT = 100;
type DetailQueryable = Pick<PoolClient, "query">;

/** Loads and validates the normalized current revision used by the local V2 detail UI. */
export async function buildLoopWorkflowShadow(
  loop: LoopRow,
  db: DetailQueryable,
): Promise<LoopWorkflowShadow | undefined> {
  if ((loop.workflow_version ?? 1) !== 2) return undefined;
  if (!loop.current_plan_revision_id) {
    throw new Error(`V2 Loop ${loop.id} has no current plan revision`);
  }

  const revisionId = loop.current_plan_revision_id;
  const revisionResult = await db.query<ShadowPlanRevisionRow>(
    `select id, loop_id, revision_number, status, summary, created_at, updated_at
     from loop_plan_revisions
     where id = $1 and loop_id = $2`,
    [revisionId, loop.id],
  );
  const planRevisions = normalizeRows(revisionResult.rows || []);
  if (planRevisions.length !== 1) {
    throw new Error(`V2 Loop ${loop.id} has an inconsistent current plan revision snapshot`);
  }

  const stagesResult = await db.query<ShadowStageRow>(
    `select id, plan_revision_id, key, title, description, position, status
     from loop_stages
     where plan_revision_id = $1
     order by position, id`,
    [revisionId],
  );
  const stages = normalizeRows(stagesResult.rows || []);
  if (stages.some((stage) => stage.plan_revision_id !== revisionId)) {
    throw new Error(`V2 Loop ${loop.id} has an inconsistent stage snapshot`);
  }

  const tasksResult = await db.query<ShadowTaskRow>(
    `select task.id, task.stage_id, task.key, task.title, task.description, task.position, task.status
     from loop_tasks as task
     join loop_stages as stage on stage.id = task.stage_id
     where stage.plan_revision_id = $1
     order by stage.position, stage.id, task.position, task.id`,
    [revisionId],
  );
  const tasks = normalizeRows(tasksResult.rows || []);
  const stageIds = new Set(stages.map((stage) => stage.id));
  if (tasks.some((task) => !stageIds.has(task.stage_id))) {
    throw new Error(`V2 Loop ${loop.id} has an inconsistent task snapshot`);
  }

  const taskIds = tasks.map((task) => task.id);
  const [
    dependenciesResult,
    runsResult,
    reviewsResult,
    evidenceResult,
    runCountsResult,
    reviewCountsResult,
    evidenceCountsResult,
  ] = taskIds.length > 0
    ? await Promise.all([
        db.query<ShadowDependencyRow>(
          `select task_id, depends_on_task_id, dependency_type
           from loop_task_dependencies
           where task_id = any($1::uuid[]) or depends_on_task_id = any($1::uuid[])`,
          [taskIds],
        ),
        db.query<ShadowRunRow>(
          `select id, task_id, status
           from loop_task_runs
           where task_id = any($1::uuid[])
           order by created_at desc, id desc
           limit $2`,
          [taskIds, V2_HISTORY_LIMIT],
        ),
        db.query<ShadowReviewRow>(
          `select review.id, review.task_id, review.task_run_id, review.status,
                  case when review.task_run_id is null then true
                       else referenced_run.task_id = review.task_id end as task_run_owned
           from loop_task_reviews as review
           left join loop_task_runs as referenced_run on referenced_run.id = review.task_run_id
           where review.task_id = any($1::uuid[])
           order by review.created_at desc, review.id desc
           limit $2`,
          [taskIds, V2_HISTORY_LIMIT],
        ),
        db.query<ShadowEvidenceRow>(
          `select evidence.id, evidence.task_id, evidence.task_run_id, evidence.kind,
                  case when evidence.task_run_id is null then true
                       else referenced_run.task_id = evidence.task_id end as task_run_owned
           from loop_evidence as evidence
           left join loop_task_runs as referenced_run on referenced_run.id = evidence.task_run_id
           where evidence.task_id = any($1::uuid[])
           order by evidence.created_at desc, evidence.id desc
           limit $2`,
          [taskIds, V2_HISTORY_LIMIT],
        ),
        db.query<ShadowHistoryCountRow>(
          `select task_id, count(*) as count
           from loop_task_runs
           where task_id = any($1::uuid[])
           group by task_id`,
          [taskIds],
        ),
        db.query<ShadowHistoryCountRow>(
          `select task_id, count(*) as count
           from loop_task_reviews
           where task_id = any($1::uuid[])
           group by task_id`,
          [taskIds],
        ),
        db.query<ShadowHistoryCountRow>(
          `select task_id, count(*) as count
           from loop_evidence
           where task_id = any($1::uuid[])
           group by task_id`,
          [taskIds],
        ),
      ])
    : [
        { rows: [] as ShadowDependencyRow[] },
        { rows: [] as ShadowRunRow[] },
        { rows: [] as ShadowReviewRow[] },
        { rows: [] as ShadowEvidenceRow[] },
        { rows: [] as ShadowHistoryCountRow[] },
        { rows: [] as ShadowHistoryCountRow[] },
        { rows: [] as ShadowHistoryCountRow[] },
      ];

  const taskIdSet = new Set(taskIds);
  const dependencies = normalizeRows(dependenciesResult.rows || []);
  const runs = normalizeRows(runsResult.rows || []);
  const reviews = normalizeRows(reviewsResult.rows || []);
  const evidence = normalizeRows(evidenceResult.rows || []);
  if (dependencies.some((edge) => !taskIdSet.has(edge.task_id) || !taskIdSet.has(edge.depends_on_task_id))) {
    throw new Error(`V2 Loop ${loop.id} has a dependency outside the current plan revision`);
  }
  if ([...runs, ...reviews, ...evidence].some((item) => !taskIdSet.has(item.task_id))) {
    throw new Error(`V2 Loop ${loop.id} has inconsistent task history`);
  }

  return projectLoopWorkflowShadow({
    loop: {
      id: loop.id,
      workflow_version: 2,
      mode: loop.mode,
      current_plan_revision_id: revisionId,
      plan: loop.plan,
    },
    planRevisions,
    stages,
    tasks,
    dependencies,
    runs,
    reviews,
    evidence,
    runCounts: normalizeRows(runCountsResult.rows || []),
    reviewCounts: normalizeRows(reviewCountsResult.rows || []),
    evidenceCounts: normalizeRows(evidenceCountsResult.rows || []),
  });
}

export async function listLoopGalleryCards(): Promise<LoopGalleryCard[]> {
  if (isLocalAuthDisabled()) {
    const loopsRes = await query<LoopRow>(
      `select id, name, description, summary, status, priority, owner_agent, deferred_until, plan, clarification_questions, approval_scope, updated_at, metadata,
              workflow_version, mode, current_plan_revision_id
       from loops
       order by updated_at desc`,
    );

    const rows = normalizeRows((loopsRes.rows as LoopRow[])).filter((loop) => !isArchivedFromMainList(loop));
    const loopIds = rows.map((p) => p.id);
    const [workLinksRes, primaryExecutionByLoop, v2TaskProgress] = await Promise.all([
      loopIds.length ? query<{ loop_id: string }>(`select loop_id from loop_work_items`) : Promise.resolve({ rows: [] as { loop_id: string }[] }),
      listPrimaryExecutionWorkItemsLocal(loopIds),
      loadV2TaskProgressLocal(rows),
    ]);

    const workCounts = new Map<string, number>();
    for (const row of workLinksRes.rows || []) {
      workCounts.set(row.loop_id, (workCounts.get(row.loop_id) || 0) + 1);
    }

    for (const loop of rows) {
      const primaryExecution = primaryExecutionByLoop.get(loop.id) || null;
      const nextStatus = getLoopStatusForPrimaryExecution(loop.status, primaryExecution?.status);
      if (nextStatus) {
        loop.status = nextStatus;
      }
    }

    return rows.map((loop) => {
      const { progressPercent, progressLabel } = deriveProgress(loop, v2TaskProgress);
      const primaryExecution = primaryExecutionByLoop.get(loop.id) || null;
      return {
        id: loop.id,
        title: toTitle(loop),
        summary: toSummary(loop),
        status: loop.status,
        priority: loop.priority || 'medium',
        progressLabel,
        progressPercent,
        needsMyAttention: deriveNeedsMyAttention(loop),
        readyToRun: deriveReadyToRun(loop),
        blocked: loop.status === 'blocked',
        queued: loop.status === 'queued',
        running: loop.status === 'in_progress' || loop.status === 'active',
        dispatchState: typeof primaryExecution?.payload?.dispatch_state === 'string' ? String(primaryExecution.payload?.dispatch_state) : null,
        nextActionLabel: deriveNextActionLabel(loop),
        ownerAgent: loop.owner_agent,
        deferredUntil: loop.deferred_until,
        updatedAt: loop.updated_at,
        linkedWorkItemsCount: workCounts.get(loop.id) || 0,
      };
    });
  }

  const { data: loops, error } = await supabaseAdmin
    .from("loops")
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,plan,clarification_questions,approval_scope,updated_at,metadata,workflow_version,mode,current_plan_revision_id")
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const rows = ((loops || []) as LoopRow[]).filter((loop) => !isArchivedFromMainList(loop));
  const loopIds = rows.map((p) => p.id);

  const [workLinks, primaryExecutionByLoop, v2TaskProgress] = await Promise.all([
    loopIds.length ? supabaseAdmin.from("loop_work_items").select("loop_id") : Promise.resolve({ data: [], error: null }),
    listPrimaryExecutionWorkItems(supabaseAdmin, loopIds),
    loadV2TaskProgressCloud(rows),
  ]);

  const countBy = (linkRows: Array<{ loop_id: string }> | null | undefined) => {
    const map = new Map<string, number>();
    for (const row of linkRows || []) {
      map.set(row.loop_id, (map.get(row.loop_id) || 0) + 1);
    }
    return map;
  };

  const workCounts = countBy(workLinks.data as Array<{ loop_id: string }>);

  deriveLoopStatusesFromPrimaryExecution(rows, primaryExecutionByLoop);

  return rows.map((loop) => {
    const { progressPercent, progressLabel } = deriveProgress(loop, v2TaskProgress);
    const primaryExecution = primaryExecutionByLoop.get(loop.id) || null;
    return {
      id: loop.id,
      title: toTitle(loop),
      summary: toSummary(loop),
      status: loop.status,
      priority: loop.priority || "medium",
      progressLabel,
      progressPercent,
      needsMyAttention: deriveNeedsMyAttention(loop),
      readyToRun: deriveReadyToRun(loop),
      blocked: loop.status === "blocked",
      queued: loop.status === "queued",
      running: loop.status === "in_progress" || loop.status === "active",
      dispatchState: typeof primaryExecution?.payload?.dispatch_state === "string" ? String(primaryExecution.payload?.dispatch_state) : null,
      nextActionLabel: deriveNextActionLabel(loop),
      ownerAgent: loop.owner_agent,
      deferredUntil: loop.deferred_until,
      updatedAt: loop.updated_at,
      linkedWorkItemsCount: workCounts.get(loop.id) || 0,
    };
  });
}

export async function getLoopDetail(loopId: string): Promise<LoopDetailPayload | null> {
  if (isLocalAuthDisabled()) {
    return withTransaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const loopRes = await client.query<LoopRow>(
        `select id, name, description, summary, status, clarification_questions,
                workflow_version, mode, current_plan_revision_id, row_version
         from loops
         where id = $1
         limit 1`,
        [loopId],
      );
      let row = loopRes.rows[0] ? normalizeRows([loopRes.rows[0] as LoopRow])[0] : null;
      if (!row) return null;

      if ((row.workflow_version ?? 1) === 2) {
        const workflow = await buildLoopWorkflowShadow(row, client);
        if (!workflow) throw new Error(`V2 Loop ${row.id} workflow projection is unavailable`);
        const finalSnapshot = await client.query<Pick<LoopRow, "row_version" | "current_plan_revision_id" | "workflow_version">>(
          `select row_version, current_plan_revision_id, workflow_version
           from loops
           where id = $1
           limit 1`,
          [loopId],
        );
        const finalRow = finalSnapshot.rows[0];
        if (
          !finalRow
          || String(finalRow.row_version) !== String(row.row_version)
          || finalRow.current_plan_revision_id !== row.current_plan_revision_id
          || finalRow.workflow_version !== 2
        ) {
          throw new Error(`V2 Loop ${row.id} snapshot changed while loading detail`);
        }
        return {
          id: row.id,
          title: toTitle(row),
          summary: toSummary(row),
          status: row.status,
          needsMyAttention: deriveNeedsMyAttention(row),
          workflowVersion: 2,
          mode: row.mode,
          workflow,
        } satisfies LoopDetailV2Payload;
      }

      const legacyResult = await client.query<LoopRow>(
        `select id, name, description, summary, status, priority, owner_agent, deferred_until, target_outcome, acceptance_criteria, plan, clarification_questions, approval_scope, notes, metadata, updated_at,
                workflow_version, mode, current_plan_revision_id, row_version
         from loops
         where id = $1 and workflow_version = 1
         limit 1`,
        [loopId],
      );
      row = legacyResult.rows[0] ? normalizeRows([legacyResult.rows[0]])[0] : null;
      if (!row) throw new Error(`Legacy Loop ${loopId} changed while loading detail`);
      const primaryExecution = await getPrimaryExecutionWorkItemLocal(loopId, client);
      const nextStatus = getLoopStatusForPrimaryExecution(row.status, primaryExecution?.status);
      if (nextStatus) row.status = nextStatus;

      const [workLinksRes, eventsRes] = await Promise.all([
        client.query<{ work_item_id: string; relation_type: string }>(
          `select work_item_id, relation_type from loop_work_items where loop_id = $1`,
          [loopId],
        ),
        client.query<{ id: string; event_type: string; from_status: string | null; to_status: string | null; actor: string | null; payload: LoopEventPayload; created_at: string }>(
          `select id, event_type, from_status, to_status, actor, payload, created_at
           from loop_events
           where loop_id = $1
           order by created_at desc
           limit 20`,
          [loopId],
        ),
      ]);

      return {
        id: row.id,
        title: toTitle(row),
        summary: toSummary(row),
        status: row.status,
        priority: row.priority || "medium",
        ownerAgent: row.owner_agent,
        targetOutcome: row.target_outcome || null,
        acceptanceCriteria: row.acceptance_criteria || [],
        plan: row.plan || [],
        clarificationQuestions: row.clarification_questions || [],
        approvalScope: row.approval_scope || {},
        notes: row.notes || null,
        metadata: row.metadata || {},
        clarificationHistory: Array.isArray((row.metadata || {}).clarification_history)
          ? ((row.metadata || {}).clarification_history as ClarificationHistoryEntry[])
          : [],
        deliverable: primaryExecution
          ? {
              workItemId: primaryExecution.workItemId,
              title: primaryExecution.title,
              status: primaryExecution.status,
              instruction: primaryExecution.instruction,
              summary: extractDeliverableSummary(primaryExecution as unknown as PrimaryExecutionWorkItem),
              startedAt: primaryExecution.startedAt,
              completedAt: primaryExecution.completedAt,
              updatedAt: primaryExecution.updatedAt,
              dispatchState: typeof primaryExecution.payload?.dispatch_state === "string" ? String(primaryExecution.payload.dispatch_state) : null,
            }
          : null,
        needsMyAttention: deriveNeedsMyAttention(row),
        readyToRun: deriveReadyToRun(row),
        nextActionLabel: deriveNextActionLabel(row),
        blockedReason: row.status === "blocked" ? deriveNextActionLabel(row) : null,
        deferredUntil: row.deferred_until,
        linkedWorkItems: (workLinksRes.rows || []).map((link) => ({ id: link.work_item_id, relationType: link.relation_type })),
        workflowVersion: 1,
        mode: "linear",
        recentEvents: (eventsRes.rows || []).map((event) => ({
          id: event.id,
          eventType: event.event_type,
          fromStatus: event.from_status,
          toStatus: event.to_status,
          actor: event.actor,
          payload: (event.payload || {}) as LoopEventPayload,
          createdAt: event.created_at,
        })),
      } satisfies LoopDetailV1Payload;
    });
  }

  const { data: loopVersion, error: versionError } = await supabaseAdmin
    .from("loops")
    .select("id,workflow_version")
    .eq("id", loopId)
    .maybeSingle();

  if (versionError) throw versionError;
  if (!loopVersion) return null;
  if (loopVersion.workflow_version === 2) {
    throw new Error(`V2 cloud detail is unavailable; refusing to fall back to the legacy plan for Loop ${loopVersion.id}`);
  }
  if (loopVersion.workflow_version !== 1) {
    throw new Error(`Unsupported cloud Loop workflow version: ${String(loopVersion.workflow_version)}`);
  }

  const { data: loop, error } = await supabaseAdmin
    .from("loops")
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,target_outcome,acceptance_criteria,plan,clarification_questions,approval_scope,notes,metadata,updated_at,workflow_version,mode,current_plan_revision_id,row_version")
    .eq("id", loopId)
    .eq("workflow_version", 1)
    .maybeSingle();
  if (error) throw error;
  if (!loop) throw new Error(`Legacy cloud Loop ${loopId} changed while loading detail`);

  const row = loop as LoopRow;

  const primaryExecution = await getPrimaryExecutionWorkItem(supabaseAdmin, loopId);
  const nextStatus = getLoopStatusForPrimaryExecution(row.status, primaryExecution?.status);

  if (nextStatus) {
    row.status = nextStatus;
  }

  const [workLinks, events] = await Promise.all([
    supabaseAdmin.from("loop_work_items").select("work_item_id, relation_type").eq("loop_id", loopId),
    supabaseAdmin
      .from("loop_events")
      .select("id, event_type, from_status, to_status, actor, payload, created_at")
      .eq("loop_id", loopId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return {
    id: row.id,
    title: toTitle(row),
    summary: toSummary(row),
    status: row.status,
    priority: row.priority || "medium",
    ownerAgent: row.owner_agent,
    targetOutcome: row.target_outcome || null,
    acceptanceCriteria: row.acceptance_criteria || [],
    plan: row.plan || [],
    clarificationQuestions: row.clarification_questions || [],
    approvalScope: row.approval_scope || {},
    notes: row.notes || null,
    metadata: row.metadata || {},
    clarificationHistory: Array.isArray((row.metadata || {}).clarification_history)
      ? ((row.metadata || {}).clarification_history as ClarificationHistoryEntry[])
      : [],
    deliverable: primaryExecution
      ? {
          workItemId: primaryExecution.workItemId,
          title: primaryExecution.title,
          status: primaryExecution.status,
          instruction: primaryExecution.instruction,
          summary: extractDeliverableSummary(primaryExecution),
          startedAt: primaryExecution.startedAt,
          completedAt: primaryExecution.completedAt,
          updatedAt: primaryExecution.updatedAt,
          dispatchState: typeof primaryExecution.payload?.dispatch_state === "string" ? String(primaryExecution.payload?.dispatch_state) : null,
        }
      : null,
    needsMyAttention: deriveNeedsMyAttention(row),
    readyToRun: deriveReadyToRun(row),
    nextActionLabel: deriveNextActionLabel(row),
    blockedReason: row.status === "blocked" ? deriveNextActionLabel(row) : null,
    deferredUntil: row.deferred_until,
    linkedWorkItems: (workLinks.data || []).map((r) => ({ id: r.work_item_id, relationType: r.relation_type })),
    workflowVersion: 1,
    mode: "linear",
    recentEvents: (events.data || []).map((e) => ({
      id: e.id,
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor,
      payload: (e.payload || {}) as LoopEventPayload,
      createdAt: e.created_at,
    })),
  } satisfies LoopDetailV1Payload;
}
