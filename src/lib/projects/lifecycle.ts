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

type ProjectWorkItemRow = {
  project_id: string;
  work_item_id: string;
  work_items: WorkItemRow[] | WorkItemRow | null;
};

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

const OPEN_PRIMARY_EXECUTION_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);
const TERMINAL_PRIMARY_EXECUTION_STATUSES = new Set(["done", "failed", "canceled"]);

function normalizeWorkItem(row: ProjectWorkItemRow): PrimaryExecutionWorkItem | null {
  const joined = Array.isArray(row.work_items) ? row.work_items[0] : row.work_items;
  if (!joined) return null;

  return {
    projectId: row.project_id,
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

export async function listPrimaryExecutionWorkItems(
  supabase: ServiceClient,
  projectIds: string[]
): Promise<Map<string, PrimaryExecutionWorkItem>> {
  const byProject = new Map<string, PrimaryExecutionWorkItem>();

  if (!projectIds.length) return byProject;

  const { data, error } = await supabase
    .from("project_work_items")
    .select("project_id, work_item_id, work_items!inner(id,status,title,instruction,payload,started_at,completed_at,updated_at,created_at)")
    .in("project_id", projectIds)
    .eq("relation_type", "primary_execution");

  if (error) throw error;

  for (const row of (data || []) as ProjectWorkItemRow[]) {
    const candidate = normalizeWorkItem(row);
    if (!candidate) continue;
    byProject.set(candidate.projectId, pickPreferredWorkItem(byProject.get(candidate.projectId), candidate));
  }

  return byProject;
}

export async function getPrimaryExecutionWorkItem(
  supabase: ServiceClient,
  projectId: string
): Promise<PrimaryExecutionWorkItem | null> {
  return (await listPrimaryExecutionWorkItems(supabase, [projectId])).get(projectId) || null;
}

export async function supersedePrimaryExecutionLinks(
  supabase: ServiceClient,
  projectId: string,
  keepWorkItemId?: string | null,
  actor = "system"
): Promise<void> {
  const { data, error } = await supabase
    .from("project_work_items")
    .select("project_id, work_item_id, work_items!inner(payload)")
    .eq("project_id", projectId)
    .eq("relation_type", "primary_execution");

  if (error) throw error;

  const now = new Date().toISOString();
  for (const row of (data || []) as Array<{ project_id: string; work_item_id: string; work_items: { payload?: Record<string, unknown> }[] | { payload?: Record<string, unknown> } | null }>) {
    if (keepWorkItemId && row.work_item_id === keepWorkItemId) continue;
    const joined = Array.isArray(row.work_items) ? row.work_items[0] : row.work_items;
    const payload = {
      ...((joined?.payload || {}) as Record<string, unknown>),
      superseded_at: now,
      superseded_by: actor,
      superseded_for_project_id: projectId,
      superseded_in_relation: "primary_execution",
    };
    const { error: updateError } = await supabase
      .from("work_items")
      .update({ payload, updated_at: now })
      .eq("id", row.work_item_id);
    if (updateError) throw updateError;

    const { error: linkError } = await supabase
      .from("project_work_items")
      .update({ relation_type: "historical_primary_execution" })
      .eq("project_id", row.project_id)
      .eq("work_item_id", row.work_item_id)
      .eq("relation_type", "primary_execution");
    if (linkError) throw linkError;
  }
}

export async function reconcileProjectStatusWithPrimaryExecution(
  supabase: ServiceClient,
  options: ReconcileProjectStatusOptions
): Promise<ReconcileProjectStatusResult> {
  let projectStatus = options.projectStatus;

  if (!projectStatus) {
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, status")
      .eq("id", options.projectId)
      .maybeSingle();

    if (error) throw error;
    if (!project) {
      return {
        reconciled: false,
        projectId: options.projectId,
        previousStatus: null,
        nextStatus: null,
        workItemId: null,
        workItemStatus: null,
      };
    }

    projectStatus = project.status;
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
    ? await getPrimaryExecutionWorkItem(supabase, options.projectId)
    : options.primaryExecution;

  const nextStatus = getProjectStatusForPrimaryExecution(resolvedProjectStatus, primaryExecution?.status);
  if (!nextStatus || nextStatus === resolvedProjectStatus) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: resolvedProjectStatus,
      nextStatus: nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const now = options.now || new Date().toISOString();
  const { data: updatedProject, error: updateError } = await supabase
    .from("projects")
    .update({
      status: nextStatus,
      updated_at: now,
      ...(options.projectUpdates || {}),
    })
    .eq("id", options.projectId)
    .eq("status", resolvedProjectStatus)
    .select("id, status")
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updatedProject) {
    return {
      reconciled: false,
      projectId: options.projectId,
      previousStatus: resolvedProjectStatus,
      nextStatus,
      workItemId: primaryExecution?.workItemId || null,
      workItemStatus: primaryExecution?.status || null,
    };
  }

  const { error: eventError } = await supabase.from("project_events").insert({
    project_id: options.projectId,
    event_type: options.eventType || "project.lifecycle_reconciled",
    from_status: resolvedProjectStatus,
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
    projectId: options.projectId,
    previousStatus: resolvedProjectStatus,
    nextStatus,
    workItemId: primaryExecution?.workItemId || null,
    workItemStatus: primaryExecution?.status || null,
  };
}
