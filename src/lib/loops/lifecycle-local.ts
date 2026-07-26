import type { PoolClient, QueryResultRow } from "pg";
import { query } from "@/lib/db/postgres";

export type PrimaryExecutionWorkItem = {
  loopId: string;
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

type ReconcileLoopStatusOptions = {
  loopId: string;
  actor: string;
  reason: string;
  loopStatus?: string;
  primaryExecution?: PrimaryExecutionWorkItem | null;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  loopUpdates?: Record<string, unknown>;
  now?: string;
};

export type ReconcileLoopStatusResult = {
  reconciled: boolean;
  loopId: string;
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
    loopId: String(row.loop_id),
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

export function getLoopStatusForPrimaryExecution(
  loopStatus: string,
  workItemStatus: string | null | undefined
): string | null {
  if (!workItemStatus) return null;

  if (workItemStatus === "done") {
    return ["in_review", "completed"].includes(loopStatus) ? null : "in_review";
  }

  if (OPEN_PRIMARY_EXECUTION_STATUSES.has(workItemStatus)) {
    return loopStatus === "in_progress" ? null : "in_progress";
  }

  return null;
}

export async function listPrimaryExecutionWorkItemsLocal(
  loopIds: string[],
  db: Queryable = query
): Promise<Map<string, PrimaryExecutionWorkItem>> {
  const byLoop = new Map<string, PrimaryExecutionWorkItem>();
  if (!loopIds.length) return byLoop;

  const { rows } = await runQuery(db, `
    SELECT
      pwi.loop_id,
      pwi.work_item_id,
      wi.status,
      wi.title,
      wi.instruction,
      wi.payload,
      wi.started_at,
      wi.completed_at,
      wi.updated_at,
      wi.created_at
    FROM public.loop_work_items pwi
    INNER JOIN public.work_items wi ON wi.id = pwi.work_item_id
    WHERE pwi.loop_id = ANY($1::uuid[])
      AND pwi.relation_type = 'primary_execution'
  `, [loopIds]);

  for (const row of rows) {
    const candidate = normalizePrimaryExecutionRow(row);
    byLoop.set(candidate.loopId, pickPreferredWorkItem(byLoop.get(candidate.loopId), candidate));
  }

  return byLoop;
}

export async function getPrimaryExecutionWorkItemLocal(
  loopId: string,
  db: Queryable = query
): Promise<PrimaryExecutionWorkItem | null> {
  return (await listPrimaryExecutionWorkItemsLocal([loopId], db)).get(loopId) || null;
}

export async function supersedePrimaryExecutionLinksLocal(
  db: Queryable,
  loopId: string,
  keepWorkItemId?: string | null,
  actor = "system"
): Promise<void> {
  const { rows } = await runQuery(db, `
    SELECT pwi.loop_id, pwi.work_item_id, wi.payload
    FROM public.loop_work_items pwi
    INNER JOIN public.work_items wi ON wi.id = pwi.work_item_id
    WHERE pwi.loop_id = $1
      AND pwi.relation_type = 'primary_execution'
  `, [loopId]);

  const now = new Date().toISOString();
  for (const row of rows) {
    const workItemId = String(row.work_item_id);
    if (keepWorkItemId && workItemId === keepWorkItemId) continue;

    const payload = {
      ...((row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>),
      superseded_at: now,
      superseded_by: actor,
      superseded_for_loop_id: loopId,
      superseded_in_relation: "primary_execution",
    };

    await runQuery(db, `
      UPDATE public.work_items
      SET payload = $1::jsonb,
          updated_at = $2::timestamptz
      WHERE id = $3
    `, [JSON.stringify(payload), now, workItemId]);

    await runQuery(db, `
      UPDATE public.loop_work_items
      SET relation_type = 'historical_primary_execution',
          updated_at = $1::timestamptz
      WHERE loop_id = $2
        AND work_item_id = $3
        AND relation_type = 'primary_execution'
    `, [now, String(row.loop_id), workItemId]);
  }
}

export async function reconcileLoopStatusWithPrimaryExecutionLocal(
  db: Queryable,
  options: ReconcileLoopStatusOptions
): Promise<ReconcileLoopStatusResult> {
  let loopStatus = options.loopStatus;

  if (!loopStatus) {
    const { rows } = await runQuery<{ id: string; status: string }>(
      db,
      `SELECT id, status FROM public.loops WHERE id = $1 LIMIT 1`,
      [options.loopId]
    );

    if (!rows[0]) {
      return {
        reconciled: false,
        loopId: options.loopId,
        previousStatus: null,
        nextStatus: null,
        workItemId: null,
        workItemStatus: null,
      };
    }

    loopStatus = rows[0].status;
  }

  if (!loopStatus) {
    return {
      reconciled: false,
      loopId: options.loopId,
      previousStatus: null,
      nextStatus: null,
      workItemId: null,
      workItemStatus: null,
    };
  }

  const resolvedLoopStatus = loopStatus;
  const primaryExecution = options.primaryExecution === undefined
    ? await getPrimaryExecutionWorkItemLocal(options.loopId, db)
    : options.primaryExecution;

  const nextStatus = getLoopStatusForPrimaryExecution(resolvedLoopStatus, primaryExecution?.status);
  if (!nextStatus || nextStatus === resolvedLoopStatus) {
    return {
      reconciled: false,
      loopId: options.loopId,
      previousStatus: resolvedLoopStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const now = options.now || new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: nextStatus,
    updated_at: now,
    ...(options.loopUpdates || {}),
  };
  const keys = Object.keys(updates);
  const values = keys.map((key) => updates[key]);
  values.push(options.loopId, resolvedLoopStatus);

  const updated = await runQuery(db, `
    UPDATE public.loops
    SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(", ")}
    WHERE id = $${values.length - 1}
      AND status = $${values.length}
    RETURNING id, status
  `, values);

  if (!updated.rows[0]) {
    return {
      reconciled: false,
      loopId: options.loopId,
      previousStatus: resolvedLoopStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  await runQuery(db, `
    INSERT INTO public.loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
  `, [
    options.loopId,
    options.eventType || "loop.lifecycle_reconciled",
    resolvedLoopStatus,
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
    loopId: options.loopId,
    previousStatus: resolvedLoopStatus,
    nextStatus,
    workItemId: primaryExecution?.workItemId || null,
    workItemStatus: primaryExecution?.status || null,
  };
}
