import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getProjectStatusForPrimaryExecution,
  getPrimaryExecutionWorkItem,
  listPrimaryExecutionWorkItems,
  reconcileProjectStatusWithPrimaryExecution,
  type PrimaryExecutionWorkItem,
} from "@/lib/projects/lifecycle";

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

export type ProjectEventPayload = Record<string, unknown>;

export type ClarificationHistoryEntry = {
  responded_at: string;
  responded_by?: string | null;
  response: string;
};

export type ProjectGalleryCard = {
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

export type ProjectDeliverable = {
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

export type ProjectDetailPayload = {
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
  deliverable: ProjectDeliverable | null;
  needsMyAttention: boolean;
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
    payload: ProjectEventPayload;
    createdAt: string;
  }>;
};

type ProjectRow = {
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
};

function hasOpenClarifications(project: ProjectRow): boolean {
  return (project.clarification_questions || []).some((q) => q.status === "open");
}

function isReadyForApproval(project: ProjectRow): boolean {
  if (project.status !== "planning") return false;
  if (hasOpenClarifications(project)) return false;

  const metadata = (project.metadata || {}) as Record<string, unknown>;
  const clarificationHistory = Array.isArray(metadata.clarification_history) ? metadata.clarification_history : [];
  const latestClarificationText = clarificationHistory.length
    ? String((clarificationHistory[clarificationHistory.length - 1] as Record<string, unknown>).response || "").toLowerCase()
    : "";

  if (
    metadata.normalization_invalidated_at ||
    metadata.manual_triage_reason ||
    /desestim|cancel|descart|viejo|old/.test(latestClarificationText)
  ) {
    return false;
  }

  return (project.plan || []).length > 0;
}

async function autoPromotePlanningProjects(rows: ProjectRow[]) {
  const ready = rows.filter(isReadyForApproval);
  if (ready.length === 0) return;

  const ids = ready.map((project) => project.id);
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("projects")
    .update({ status: "needs_approval", updated_at: now })
    .in("id", ids)
    .eq("status", "planning");

  if (error) throw error;

  const events = ready.map((project) => ({
    project_id: project.id,
    event_type: "project.ready_for_approval",
    from_status: "planning",
    to_status: "needs_approval",
    actor: "system:auto",
    payload: { source: "read_model_auto_promotion", guarded: true },
  }));

  const { error: eventError } = await supabaseAdmin.from("project_events").insert(events);
  if (eventError) throw eventError;

  for (const project of ready) {
    project.status = "needs_approval";
  }
}

function deriveNeedsMyAttention(project: ProjectRow): boolean {
  if (["needs_clarification", "needs_approval", "blocked"].includes(project.status)) {
    return true;
  }
  return hasOpenClarifications(project);
}

function deriveReadyForApproval(project: ProjectRow): boolean {
  return isReadyForApproval(project);
}

function deriveReadyToRun(project: ProjectRow): boolean {
  if (!["approved", "queued"].includes(project.status)) return false;
  const scope = project.approval_scope || {};
  if (typeof scope.can_execute_unattended === "boolean") {
    return scope.can_execute_unattended;
  }
  return true;
}

function deriveNextActionLabel(project: ProjectRow): string | null {
  if (project.status === "needs_clarification") return "Answer clarification questions";
  if (project.status === "needs_approval") return "Review and approve plan";
  if (project.status === "blocked") return "Resolve blocker";
  if (project.status === "queued" && project.deferred_until) {
    return `Queued for ${new Date(project.deferred_until).toLocaleString()}`;
  }
  const nextPlanStep = (project.plan || []).find((step) => step.status !== "done");
  return nextPlanStep?.title || null;
}

function deriveProgress(project: ProjectRow): { progressPercent: number | null; progressLabel: string | null } {
  const plan = project.plan || [];
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
    progressPercent: byStatus[project.status] ?? null,
    progressLabel: project.status,
  };
}

function isArchivedFromMainList(project: ProjectRow): boolean {
  const metadata = (project.metadata || {}) as Record<string, unknown>;
  return metadata.archived_from_main_list === true;
}

function toTitle(project: ProjectRow) {
  return project.title || project.name || "Untitled Project";
}

function toSummary(project: ProjectRow) {
  return project.summary || project.description || "";
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

async function reconcileProjectsWithPrimaryExecution(
  rows: ProjectRow[],
  primaryExecutionByProject: Map<string, PrimaryExecutionWorkItem>
) {
  for (const project of rows) {
    const primaryExecution = primaryExecutionByProject.get(project.id) || null;
    const nextStatus = getProjectStatusForPrimaryExecution(project.status, primaryExecution?.status);

    if (!nextStatus) continue;

    await reconcileProjectStatusWithPrimaryExecution(supabaseAdmin, {
      projectId: project.id,
      projectStatus: project.status,
      primaryExecution,
      actor: "system:read_model",
      reason: "read_model_primary_execution_sync",
    });

    project.status = nextStatus;
  }
}

export async function listProjectGalleryCards(): Promise<ProjectGalleryCard[]> {
  const { data: projects, error } = await supabaseAdmin
    .from("projects")
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,plan,clarification_questions,approval_scope,updated_at,metadata")
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const rows = ((projects || []) as ProjectRow[]).filter((project) => !isArchivedFromMainList(project));
  await autoPromotePlanningProjects(rows);
  const projectIds = rows.map((p) => p.id);

  const [workLinks, primaryExecutionByProject] = await Promise.all([
    projectIds.length ? supabaseAdmin.from("project_work_items").select("project_id") : Promise.resolve({ data: [], error: null }),
    listPrimaryExecutionWorkItems(supabaseAdmin, projectIds),
  ]);

  const countBy = (linkRows: Array<{ project_id: string }> | null | undefined) => {
    const map = new Map<string, number>();
    for (const row of linkRows || []) {
      map.set(row.project_id, (map.get(row.project_id) || 0) + 1);
    }
    return map;
  };

  const workCounts = countBy(workLinks.data as Array<{ project_id: string }>);

  await reconcileProjectsWithPrimaryExecution(rows, primaryExecutionByProject);

  return rows.map((project) => {
    const { progressPercent, progressLabel } = deriveProgress(project);
    const primaryExecution = primaryExecutionByProject.get(project.id) || null;
    return {
      id: project.id,
      title: toTitle(project),
      summary: toSummary(project),
      status: project.status,
      priority: project.priority || "medium",
      progressLabel,
      progressPercent,
      needsMyAttention: deriveNeedsMyAttention(project),
      readyToRun: deriveReadyToRun(project),
      blocked: project.status === "blocked",
      queued: project.status === "queued",
      running: project.status === "in_progress" || project.status === "active",
      dispatchState: typeof primaryExecution?.payload?.dispatch_state === "string" ? String(primaryExecution.payload?.dispatch_state) : null,
      nextActionLabel: deriveNextActionLabel(project),
      ownerAgent: project.owner_agent,
      deferredUntil: project.deferred_until,
      updatedAt: project.updated_at,
      linkedWorkItemsCount: workCounts.get(project.id) || 0,
    };
  });
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetailPayload | null> {
  const { data: project, error } = await supabaseAdmin
    .from("projects")
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,target_outcome,acceptance_criteria,plan,clarification_questions,approval_scope,notes,metadata,updated_at")
    .eq("id", projectId)
    .maybeSingle();

  if (error) throw error;
  if (!project) return null;

  const row = project as ProjectRow;

  if (isReadyForApproval(row)) {
    await autoPromotePlanningProjects([row]);
  }

  const primaryExecution = await getPrimaryExecutionWorkItem(supabaseAdmin, projectId);
  const nextStatus = getProjectStatusForPrimaryExecution(row.status, primaryExecution?.status);

  if (nextStatus) {
    await reconcileProjectStatusWithPrimaryExecution(supabaseAdmin, {
      projectId,
      projectStatus: row.status,
      primaryExecution,
      actor: "system:read_model",
      reason: "read_model_primary_execution_sync",
    });

    row.status = nextStatus;
  }

  const [workLinks, events] = await Promise.all([
    supabaseAdmin.from("project_work_items").select("work_item_id, relation_type").eq("project_id", projectId),
    supabaseAdmin
      .from("project_events")
      .select("id, event_type, from_status, to_status, actor, payload, created_at")
      .eq("project_id", projectId)
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
    recentEvents: (events.data || []).map((e) => ({
      id: e.id,
      eventType: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor,
      payload: (e.payload || {}) as ProjectEventPayload,
      createdAt: e.created_at,
    })),
  };
}
