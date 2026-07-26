import { query } from "@/lib/db/postgres";

type WorkItemRow = {
  project_id: string;
  work_item_id: string;
  status: string | null;
  title: string | null;
  instruction: string | null;
  payload: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

export type PrimaryExecutionWorkItemLocal = {
  projectId: string;
  workItemId: string;
  status: string | null;
  title: string | null;
  instruction: string | null;
  payload: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

type ReconcileProjectStatusOptions = {
  projectId: string;
  actor: string;
  reason: string;
  projectStatus?: string;
  primaryExecution?: PrimaryExecutionWorkItemLocal | null;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  projectUpdates?: Record<string, unknown>;
  now?: string;
};

const OPEN_PRIMARY_EXECUTION_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);
const TERMINAL_PRIMARY_EXECUTION_STATUSES = new Set(["done", "failed", "canceled"]);

function isSuperseded(item: PrimaryExecutionWorkItemLocal) {
  return item.payload?.superseded_at != null;
}

function workItemPriority(status: string | null) {
  if (status === "in_progress") return 0;
  if (status === "ready") return 1;
  if (status === "blocked") return 2;
  if (status === "draft") return 3;
  if (status === "done") return 4;
  if (status === "failed") return 5;
  if (status === "canceled") return 6;
  return 7;
}

function workItemSortKey(item: PrimaryExecutionWorkItemLocal) {
  return item.updatedAt || item.createdAt || "";
}

function pickPreferredWorkItem(
  current: PrimaryExecutionWorkItemLocal | undefined,
  candidate: PrimaryExecutionWorkItemLocal,
) {
  if (!current) return candidate;

  const candidateSuperseded = isSuperseded(candidate);
  const currentSuperseded = isSuperseded(current);
  if (candidateSuperseded !== currentSuperseded) return candidateSuperseded ? current : candidate;

  const candidatePriority = workItemPriority(candidate.status);
  const currentPriority = workItemPriority(current.status);
  if (candidatePriority !== currentPriority) return candidatePriority < currentPriority ? candidate : current;

  return workItemSortKey(candidate) > workItemSortKey(current) ? candidate : current;
}

function normalizePrimaryExecutionRow(row: WorkItemRow): PrimaryExecutionWorkItemLocal {
  return {
    projectId: row.project_id,
    workItemId: row.work_item_id,
    status: row.status,
    title: row.title,
    instruction: row.instruction,
    payload: row.payload || null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function isPrimaryExecutionOpen(status: string | null | undefined): boolean {
  return !!status && !TERMINAL_PRIMARY_EXECUTION_STATUSES.has(status);
}

export function getProjectStatusForPrimaryExecution(
  projectStatus: string,
  workItemStatus: string | null | undefined,
): string | null {
  if (!workItemStatus) return null;
  if (workItemStatus === "done") return ["in_review", "completed"].includes(projectStatus) ? null : "in_review";
  if (OPEN_PRIMARY_EXECUTION_STATUSES.has(workItemStatus)) return projectStatus === "in_progress" ? null : "in_progress";
  return null;
}

export async function listPrimaryExecutionWorkItemsLocal(projectIds: string[]) {
  const byProject = new Map<string, PrimaryExecutionWorkItemLocal>();
  if (!projectIds.length) return byProject;

  const { rows } = await query<WorkItemRow>(
    `select pwi.project_id, pwi.work_item_id, wi.status, wi.title, wi.instruction, wi.payload, wi.started_at, wi.completed_at, wi.updated_at, wi.created_at
       from project_work_items pwi
       join work_items wi on wi.id = pwi.work_item_id
      where pwi.project_id = any($1::uuid[])
        and pwi.relation_type = 'primary_execution'`,
    [projectIds],
  );

  for (const row of rows) {
    const candidate = normalizePrimaryExecutionRow(row);
    byProject.set(candidate.projectId, pickPreferredWorkItem(byProject.get(candidate.projectId), candidate));
  }

  return byProject;
}

export async function getPrimaryExecutionWorkItemLocal(projectId: string) {
  return (await listPrimaryExecutionWorkItemsLocal([projectId])).get(projectId) || null;
}

export async function reconcileProjectStatusWithPrimaryExecutionLocal(options: ReconcileProjectStatusOptions) {
  let projectStatus = options.projectStatus;
  if (!projectStatus) {
    const { rows } = await query<{ status: string }>(`select status from projects where id = $1 limit 1`, [options.projectId]);
    projectStatus = rows[0]?.status;
  }

  if (!projectStatus) {
    return { reconciled: false, projectId: options.projectId, previousStatus: null, nextStatus: null, workItemId: null, workItemStatus: null };
  }

  const primaryExecution = options.primaryExecution === undefined
    ? await getPrimaryExecutionWorkItemLocal(options.projectId)
    : options.primaryExecution;

  const nextStatus = getProjectStatusForPrimaryExecution(projectStatus, primaryExecution?.status);
  if (!nextStatus || nextStatus === projectStatus) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: projectStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const now = options.now || new Date().toISOString();
  const projectUpdates = options.projectUpdates || {};
  const allowedKeys = ["last_completed_at", "updated_at", "status"];
  const updates: Record<string, unknown> = { status: nextStatus, updated_at: now };
  for (const [key, value] of Object.entries(projectUpdates)) {
    if (allowedKeys.includes(key)) updates[key] = value;
  }

  const setters = Object.keys(updates).map((key, index) => `${key} = $${index + 1}`);
  const values = Object.values(updates);
  values.push(options.projectId, projectStatus);

  const updated = await query<{ id: string; status: string }>(
    `update projects
        set ${setters.join(", ")}
      where id = $${values.length - 1}
        and status = $${values.length}
      returning id, status`,
    values,
  );

  if (!updated.rows[0]) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: projectStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  await query(
    `insert into project_events (project_id, event_type, from_status, to_status, actor, payload, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      options.projectId,
      options.eventType || "project.lifecycle_reconciled",
      projectStatus,
      nextStatus,
      options.actor,
      JSON.stringify({
        reason: options.reason,
        relation_type: "primary_execution",
        work_item_id: primaryExecution?.workItemId || null,
        work_item_status: primaryExecution?.status || null,
        ...(options.eventPayload || {}),
      }),
      now,
    ],
  );

  return {
    reconciled: true,
    projectId: options.projectId,
    previousStatus: projectStatus,
    nextStatus,
    workItemId: primaryExecution?.workItemId || null,
    workItemStatus: primaryExecution?.status || null,
  };
}
