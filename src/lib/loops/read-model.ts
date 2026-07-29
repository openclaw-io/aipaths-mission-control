import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
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

export type LoopDetailPayload = {
  id: string;
  title: string;
  summary: string;
  status: string;
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
  needsMyAttention: boolean;
  readyToRun: boolean;
  nextActionLabel: string | null;
  blockedReason: string | null;
  deferredUntil: string | null;
  linkedWorkItems: Array<{ id: string; relationType: string }>;
  workflowVersion: 1 | 2;
  mode: WorkflowMode;
  workflow?: LoopWorkflowShadow;
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
};

type V2TaskProgressRow = {
  loop_id: string;
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
    if (task.status === "completed" || task.status === "skipped") item.completed += 1;
  }
  return progress;
}

async function loadV2TaskProgressLocal(rows: LoopRow[]): Promise<Map<string, V2TaskProgress>> {
  const loopIds = rows.filter((loop) => (loop.workflow_version ?? 1) === 2).map((loop) => loop.id);
  if (loopIds.length === 0) return new Map();

  const result = await query<V2TaskProgressRow>(
    `select selected_loop.id as loop_id, task.status
     from loops as selected_loop
     join loop_plan_revisions as revision
       on revision.id = selected_loop.current_plan_revision_id
      and revision.loop_id = selected_loop.id
     join loop_stages as stage on stage.plan_revision_id = revision.id
     join loop_tasks as task on task.stage_id = stage.id
     where selected_loop.workflow_version = 2
       and selected_loop.id = any($1::uuid[])`,
    [loopIds],
  );
  return aggregateV2TaskProgress(loopIds, normalizeRows(result.rows || []));
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
    return { loop_id: loopId, status: task.status };
  });
  return aggregateV2TaskProgress(v2Loops.map((loop) => loop.id), taskRows);
}

/** Loads and validates the normalized current revision used by the local V2 detail UI. */
export async function buildLoopWorkflowShadow(loop: LoopRow): Promise<LoopWorkflowShadow | undefined> {
  if ((loop.workflow_version ?? 1) !== 2) return undefined;
  if (!loop.current_plan_revision_id) {
    throw new Error(`V2 Loop ${loop.id} has no current plan revision`);
  }

  const revisionId = loop.current_plan_revision_id;
  const revisionResult = await query<ShadowPlanRevisionRow>(
    `select id, loop_id, revision_number, status, summary, created_at, updated_at
     from loop_plan_revisions
     where id = $1 and loop_id = $2`,
    [revisionId, loop.id],
  );
  const planRevisions = normalizeRows(revisionResult.rows || []);
  if (planRevisions.length !== 1) {
    throw new Error(`V2 Loop ${loop.id} has an inconsistent current plan revision snapshot`);
  }

  const stagesResult = await query<ShadowStageRow>(
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

  const tasksResult = await query<ShadowTaskRow>(
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
  const [dependenciesResult, runsResult, reviewsResult, evidenceResult] = taskIds.length > 0
    ? await Promise.all([
        query<ShadowDependencyRow>(
          `select task_id, depends_on_task_id, dependency_type
           from loop_task_dependencies
           where task_id = any($1::uuid[]) or depends_on_task_id = any($1::uuid[])`,
          [taskIds],
        ),
        query<ShadowRunRow>(
          `select id, task_id, attempt_number, status, started_at, finished_at, error, output, created_at
           from loop_task_runs
           where task_id = any($1::uuid[])
           order by task_id, attempt_number, id`,
          [taskIds],
        ),
        query<ShadowReviewRow>(
          `select id, task_id, task_run_id, status, reviewer, feedback, decided_at, created_at
           from loop_task_reviews
           where task_id = any($1::uuid[])
           order by task_id, created_at, id`,
          [taskIds],
        ),
        query<ShadowEvidenceRow>(
          `select id, task_id, task_run_id, kind, uri, content, metadata, created_at
           from loop_evidence
           where task_id = any($1::uuid[])
           order by task_id, created_at, id`,
          [taskIds],
        ),
      ])
    : [
        { rows: [] as ShadowDependencyRow[] },
        { rows: [] as ShadowRunRow[] },
        { rows: [] as ShadowReviewRow[] },
        { rows: [] as ShadowEvidenceRow[] },
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
    const loopRes = await query<LoopRow>(
      `select id, name, description, summary, status, priority, owner_agent, deferred_until, target_outcome, acceptance_criteria, plan, clarification_questions, approval_scope, notes, metadata, updated_at,
              workflow_version, mode, current_plan_revision_id
       from loops
       where id = $1
       limit 1`,
      [loopId],
    );
    const row = loopRes.rows[0] ? normalizeRows([loopRes.rows[0] as LoopRow])[0] : null;
    if (!row) return null;

    const [primaryExecution, workflow] = await Promise.all([
      getPrimaryExecutionWorkItemLocal(loopId),
      buildLoopWorkflowShadow(row),
    ]);
    const nextStatus = getLoopStatusForPrimaryExecution(row.status, primaryExecution?.status);
    if (nextStatus) {
      row.status = nextStatus;
    }

    const [workLinksRes, eventsRes] = await Promise.all([
      query<{ work_item_id: string; relation_type: string }>(`select work_item_id, relation_type from loop_work_items where loop_id = $1`, [loopId]),
      query<{ id: string; event_type: string; from_status: string | null; to_status: string | null; actor: string | null; payload: LoopEventPayload; created_at: string }>(
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
      priority: row.priority || 'medium',
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
            dispatchState: typeof primaryExecution.payload?.dispatch_state === 'string' ? String(primaryExecution.payload?.dispatch_state) : null,
          }
        : null,
      needsMyAttention: deriveNeedsMyAttention(row),
      readyToRun: deriveReadyToRun(row),
      nextActionLabel: deriveNextActionLabel(row),
      blockedReason: row.status === 'blocked' ? deriveNextActionLabel(row) : null,
      deferredUntil: row.deferred_until,
      linkedWorkItems: (workLinksRes.rows || []).map((r) => ({ id: r.work_item_id, relationType: r.relation_type })),
      workflowVersion: row.workflow_version ?? 1,
      mode: row.mode ?? "linear",
      ...(workflow ? { workflow } : {}),
      recentEvents: (eventsRes.rows || []).map((e) => ({
        id: e.id,
        eventType: e.event_type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        actor: e.actor,
        payload: (e.payload || {}) as LoopEventPayload,
        createdAt: e.created_at,
      })),
    };
  }

  const { data: loop, error } = await supabaseAdmin
    .from("loops")
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,target_outcome,acceptance_criteria,plan,clarification_questions,approval_scope,notes,metadata,updated_at,workflow_version,mode,current_plan_revision_id")
    .eq("id", loopId)
    .maybeSingle();

  if (error) throw error;
  if (!loop) return null;

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
    workflowVersion: row.workflow_version ?? 1,
    mode: row.mode ?? "linear",
    recentEvents: (events.data || []).map((e) => ({
      id: e.id,
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor,
      payload: (e.payload || {}) as LoopEventPayload,
      createdAt: e.created_at,
    })),
  };
}
