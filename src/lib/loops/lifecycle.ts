import { createServiceClient } from "@/lib/supabase/admin";

type ServiceClient = ReturnType<typeof createServiceClient>;

type WorkItemRow = {
  id: string;
  status: string | null;
  title?: string | null;
  instruction?: string | null;
  payload?: Record<string, unknown> | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

type LoopWorkItemRow = {
  loop_id: string;
  work_item_id: string;
  work_items: WorkItemRow[] | WorkItemRow | null;
};

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

const OPEN_PRIMARY_EXECUTION_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);
const TERMINAL_PRIMARY_EXECUTION_STATUSES = new Set(["done", "failed", "canceled"]);

function normalizeWorkItem(row: LoopWorkItemRow): PrimaryExecutionWorkItem | null {
  const joined = Array.isArray(row.work_items) ? row.work_items[0] : row.work_items;
  if (!joined) return null;

  return {
    loopId: row.loop_id,
    workItemId: row.work_item_id,
    status: joined.status,
    title: joined.title || null,
    instruction: joined.instruction || null,
    payload: (joined.payload as Record<string, unknown> | null) || null,
    startedAt: joined.started_at || null,
    completedAt: joined.completed_at || null,
    updatedAt: joined.updated_at || null,
    createdAt: joined.created_at || null,
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

export async function listPrimaryExecutionWorkItems(
  supabase: ServiceClient,
  loopIds: string[]
): Promise<Map<string, PrimaryExecutionWorkItem>> {
  const byLoop = new Map<string, PrimaryExecutionWorkItem>();

  if (!loopIds.length) return byLoop;

  const { data, error } = await supabase
    .from("loop_work_items")
    .select("loop_id, work_item_id, work_items!inner(id,status,title,instruction,payload,started_at,completed_at,updated_at,created_at)")
    .in("loop_id", loopIds)
    .eq("relation_type", "primary_execution");

  if (error) throw error;

  for (const row of (data || []) as LoopWorkItemRow[]) {
    const candidate = normalizeWorkItem(row);
    if (!candidate) continue;
    byLoop.set(candidate.loopId, pickPreferredWorkItem(byLoop.get(candidate.loopId), candidate));
  }

  return byLoop;
}

export async function getPrimaryExecutionWorkItem(
  supabase: ServiceClient,
  loopId: string
): Promise<PrimaryExecutionWorkItem | null> {
  return (await listPrimaryExecutionWorkItems(supabase, [loopId])).get(loopId) || null;
}

export async function supersedePrimaryExecutionLinks(
  supabase: ServiceClient,
  loopId: string,
  keepWorkItemId?: string | null,
  actor = "system"
): Promise<void> {
  const { data, error } = await supabase
    .from("loop_work_items")
    .select("loop_id, work_item_id, work_items!inner(payload)")
    .eq("loop_id", loopId)
    .eq("relation_type", "primary_execution");

  if (error) throw error;

  const now = new Date().toISOString();
  for (const row of (data || []) as Array<{ loop_id: string; work_item_id: string; work_items: { payload?: Record<string, unknown> }[] | { payload?: Record<string, unknown> } | null }>) {
    if (keepWorkItemId && row.work_item_id === keepWorkItemId) continue;
    const joined = Array.isArray(row.work_items) ? row.work_items[0] : row.work_items;
    const payload = {
      ...((joined?.payload || {}) as Record<string, unknown>),
      superseded_at: now,
      superseded_by: actor,
      superseded_for_loop_id: loopId,
      superseded_in_relation: "primary_execution",
    };
    const { error: updateError } = await supabase
      .from("work_items")
      .update({ payload, updated_at: now })
      .eq("id", row.work_item_id);
    if (updateError) throw updateError;

    const { error: linkError } = await supabase
      .from("loop_work_items")
      .update({ relation_type: "historical_primary_execution" })
      .eq("loop_id", row.loop_id)
      .eq("work_item_id", row.work_item_id)
      .eq("relation_type", "primary_execution");
    if (linkError) throw linkError;
  }
}

export async function reconcileLoopStatusWithPrimaryExecution(
  supabase: ServiceClient,
  options: ReconcileLoopStatusOptions
): Promise<ReconcileLoopStatusResult> {
  let loopStatus = options.loopStatus;

  if (!loopStatus) {
    const { data: loop, error } = await supabase
      .from("loops")
      .select("id, status")
      .eq("id", options.loopId)
      .maybeSingle();

    if (error) throw error;
    if (!loop) {
      return {
        reconciled: false,
        loopId: options.loopId,
        previousStatus: null,
        nextStatus: null,
        workItemId: null,
        workItemStatus: null,
      };
    }

    loopStatus = loop.status;
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
    ? await getPrimaryExecutionWorkItem(supabase, options.loopId)
    : options.primaryExecution;

  const nextStatus = getLoopStatusForPrimaryExecution(resolvedLoopStatus, primaryExecution?.status);
  if (!nextStatus || nextStatus === resolvedLoopStatus) {
    return {
      reconciled: false,
      loopId: options.loopId,
      previousStatus: resolvedLoopStatus,
      nextStatus: nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const now = options.now || new Date().toISOString();
  const { data: updatedLoop, error: updateError } = await supabase
    .from("loops")
    .update({
      status: nextStatus,
      updated_at: now,
      ...(options.loopUpdates || {}),
    })
    .eq("id", options.loopId)
    .eq("status", resolvedLoopStatus)
    .select("id, status")
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updatedLoop) {
    return {
      reconciled: false,
      loopId: options.loopId,
      previousStatus: resolvedLoopStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const { error: eventError } = await supabase.from("loop_events").insert({
    loop_id: options.loopId,
    event_type: options.eventType || "loop.lifecycle_reconciled",
    from_status: resolvedLoopStatus,
    to_status: nextStatus,
    actor: options.actor,
    payload: {
      reason: options.reason,
      relation_type: "primary_execution",
      work_item_id: primaryExecution?.workItemId || null,
      work_item_status: primaryExecution?.status || null,
      ...(options.eventPayload || {}),
    },
    created_at: now,
  });

  if (eventError) throw eventError;

  return {
    reconciled: true,
    loopId: options.loopId,
    previousStatus: resolvedLoopStatus,
    nextStatus,
    workItemId: primaryExecution?.workItemId || null,
    workItemStatus: primaryExecution?.status || null,
  };
}
