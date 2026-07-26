import type { PoolClient, QueryResultRow } from "pg";
import { query } from "@/lib/db/postgres";

export type PrimaryExecutionWorkItem = {
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
  primaryExecution?: PrimaryExecutionWorkItem | null;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  projectUpdates?: Record<string, unknown>;
  now?: string;
};

export type ReconcileProjectStatusResult = {
  reconciled: boolean;
  projectId: string;
  previousStatus: string | null;
  nextStatus: string | null;
  workItemId: string | null;
  workItemStatus: string | null;
};

type Queryable = Pick<PoolClient, "query"> | typeof import("@/lib/db/postgres").query;

const OPEN_PRIMARY_EXECUTION_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);
const TERMINAL_PRIMARY_EXECUTION_STATUSES = new Set(["done", "failed", "canceled"]);

function asIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizePrimaryExecutionRow(row: QueryResultRow): PrimaryExecutionWorkItem {
  return {
    projectId: String(row.project_id),
    workItemId: String(row.work_item_id),
    status: typeof row.status === "string" ? row.status : null,
    title: typeof row.title === "string" ? row.title : null,
    instruction: typeof row.instruction === "string" ? row.instruction : null,
    payload: row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : null,
    startedAt: asIso(row.started_at),
    completedAt: asIso(row.completed_at),
    updatedAt: asIso(row.updated_at),
    createdAt: asIso(row.created_at),
  };
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

function workItemSortKey(item: PrimaryExecutionWorkItem) {
  return item.updatedAt || item.createdAt || "";
}

function isSuperseded(item: PrimaryExecutionWorkItem) {
  return item.payload?.superseded_at != null;
}

function pickPreferredWorkItem(
  current: PrimaryExecutionWorkItem | undefined,
  candidate: PrimaryExecutionWorkItem
) {
  if (!current) return candidate;

  const candidateSuperseded = isSuperseded(candidate);
  const currentSuperseded = isSuperseded(current);

  if (candidateSuperseded !== currentSuperseded) {
    return candidateSuperseded ? current : candidate;
  }

  const candidatePriority = workItemPriority(candidate.status);
  const currentPriority = workItemPriority(current.status);

  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }

  return workItemSortKey(candidate) > workItemSortKey(current) ? candidate : current;
}

async function runQuery<T extends QueryResultRow = QueryResultRow>(db: Queryable, text: string, params: unknown[] = []) {
  if (typeof db === "function") return db<T>(text, params);
  return db.query<T>(text, params);
}

export function isPrimaryExecutionOpen(status: string | null | undefined): boolean {
  return !!status && !TERMINAL_PRIMARY_EXECUTION_STATUSES.has(status);
}

export function getProjectStatusForPrimaryExecution(
  projectStatus: string,
  workItemStatus: string | null | undefined
): string | null {
  if (!workItemStatus) return null;

  if (workItemStatus === "done") {
    return ["in_review", "completed"].includes(projectStatus) ? null : "in_review";
  }

  if (OPEN_PRIMARY_EXECUTION_STATUSES.has(workItemStatus)) {
    return projectStatus === "in_progress" ? null : "in_progress";
  }

  return null;
}

export async function listPrimaryExecutionWorkItemsLocal(
  projectIds: string[],
  db: Queryable = query
): Promise<Map<string, PrimaryExecutionWorkItem>> {
  const byProject = new Map<string, PrimaryExecutionWorkItem>();
  if (!projectIds.length) return byProject;

  const { rows } = await runQuery(db, `
    SELECT
      pwi.project_id,
      pwi.work_item_id,
      wi.status,
      wi.title,
      wi.instruction,
      wi.payload,
      wi.started_at,
      wi.completed_at,
      wi.updated_at,
      wi.created_at
    FROM public.project_work_items pwi
    INNER JOIN public.work_items wi ON wi.id = pwi.work_item_id
    WHERE pwi.project_id = ANY($1::uuid[])
      AND pwi.relation_type = 'primary_execution'
  `, [projectIds]);

  for (const row of rows) {
    const candidate = normalizePrimaryExecutionRow(row);
    byProject.set(candidate.projectId, pickPreferredWorkItem(byProject.get(candidate.projectId), candidate));
  }

  return byProject;
}

export async function getPrimaryExecutionWorkItemLocal(
  projectId: string,
  db: Queryable = query
): Promise<PrimaryExecutionWorkItem | null> {
  return (await listPrimaryExecutionWorkItemsLocal([projectId], db)).get(projectId) || null;
}

export async function supersedePrimaryExecutionLinksLocal(
  db: Queryable,
  projectId: string,
  keepWorkItemId?: string | null,
  actor = "system"
): Promise<void> {
  const { rows } = await runQuery(db, `
    SELECT pwi.project_id, pwi.work_item_id, wi.payload
    FROM public.project_work_items pwi
    INNER JOIN public.work_items wi ON wi.id = pwi.work_item_id
    WHERE pwi.project_id = $1
      AND pwi.relation_type = 'primary_execution'
  `, [projectId]);

  const now = new Date().toISOString();
  for (const row of rows) {
    const workItemId = String(row.work_item_id);
    if (keepWorkItemId && workItemId === keepWorkItemId) continue;

    const payload = {
      ...((row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>),
      superseded_at: now,
      superseded_by: actor,
      superseded_for_project_id: projectId,
      superseded_in_relation: "primary_execution",
    };

    await runQuery(db, `
      UPDATE public.work_items
      SET payload = $1::jsonb,
          updated_at = $2::timestamptz
      WHERE id = $3
    `, [JSON.stringify(payload), now, workItemId]);

    await runQuery(db, `
      UPDATE public.project_work_items
      SET relation_type = 'historical_primary_execution',
          updated_at = $1::timestamptz
      WHERE project_id = $2
        AND work_item_id = $3
        AND relation_type = 'primary_execution'
    `, [now, String(row.project_id), workItemId]);
  }
}

export async function reconcileProjectStatusWithPrimaryExecutionLocal(
  db: Queryable,
  options: ReconcileProjectStatusOptions
): Promise<ReconcileProjectStatusResult> {
  let projectStatus = options.projectStatus;

  if (!projectStatus) {
    const { rows } = await runQuery<{ id: string; status: string }>(
      db,
      `SELECT id, status FROM public.projects WHERE id = $1 LIMIT 1`,
      [options.projectId]
    );

    if (!rows[0]) {
      return {
        reconciled: false,
        projectId: options.projectId,
        previousStatus: null,
        nextStatus: null,
        workItemId: null,
        workItemStatus: null,
      };
    }

    projectStatus = rows[0].status;
  }

  if (!projectStatus) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: null,
      nextStatus: null,
      workItemId: null,
      workItemStatus: null,
    };
  }

  const resolvedProjectStatus = projectStatus;
  const primaryExecution = options.primaryExecution === undefined
    ? await getPrimaryExecutionWorkItemLocal(options.projectId, db)
    : options.primaryExecution;

  const nextStatus = getProjectStatusForPrimaryExecution(resolvedProjectStatus, primaryExecution?.status);
  if (!nextStatus || nextStatus === resolvedProjectStatus) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: resolvedProjectStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const now = options.now || new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: nextStatus,
    updated_at: now,
    ...(options.projectUpdates || {}),
  };
  const keys = Object.keys(updates);
  const values = keys.map((key) => updates[key]);
  values.push(options.projectId, resolvedProjectStatus);

  const updated = await runQuery(db, `
    UPDATE public.projects
    SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(", ")}
    WHERE id = $${values.length - 1}
      AND status = $${values.length}
    RETURNING id, status
  `, values);

  if (!updated.rows[0]) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: resolvedProjectStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  await runQuery(db, `
    INSERT INTO public.project_events (project_id, event_type, from_status, to_status, actor, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
  `, [
    options.projectId,
    options.eventType || "project.lifecycle_reconciled",
    resolvedProjectStatus,
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
  ]);

  return {
    reconciled: true,
    projectId: options.projectId,
    previousStatus: resolvedProjectStatus,
    nextStatus,
    workItemId: primaryExecution?.workItemId || null,
    workItemStatus: primaryExecution?.status || null,
  };
}
