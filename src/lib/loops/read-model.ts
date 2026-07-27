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
};

function hasOpenClarifications(loop: LoopRow): boolean {
  return (loop.clarification_questions || []).some((q) => q.status === "open");
}

function isReadyForApproval(loop: LoopRow): boolean {
  if (loop.status !== "planning") return false;
  if (hasOpenClarifications(loop)) return false;

  const metadata = (loop.metadata || {}) as Record<string, unknown>;
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

  return (loop.plan || []).length > 0;
}

async function autoPromotePlanningLoops(rows: LoopRow[]) {
  const ready = rows.filter(isReadyForApproval);
  if (ready.length === 0) return;

  const ids = ready.map((loop) => loop.id);
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("loops")
    .update({ status: "needs_approval", updated_at: now })
    .in("id", ids)
    .eq("status", "planning");

  if (error) throw error;

  const events = ready.map((loop) => ({
    loop_id: loop.id,
    event_type: "loop.ready_for_approval",
    from_status: "planning",
    to_status: "needs_approval",
    actor: "system:auto",
    payload: { source: "read_model_auto_promotion", guarded: true },
  }));

  const { error: eventError } = await supabaseAdmin.from("loop_events").insert(events);
  if (eventError) throw eventError;

  for (const loop of ready) {
    loop.status = "needs_approval";
  }
}

function deriveNeedsMyAttention(loop: LoopRow): boolean {
  if (["needs_clarification", "needs_approval", "blocked"].includes(loop.status)) {
    return true;
  }
  return hasOpenClarifications(loop);
}

function deriveReadyForApproval(loop: LoopRow): boolean {
  return isReadyForApproval(loop);
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

function deriveProgress(loop: LoopRow): { progressPercent: number | null; progressLabel: string | null } {
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

export async function listLoopGalleryCards(): Promise<LoopGalleryCard[]> {
  if (isLocalAuthDisabled()) {
    const loopsRes = await query<LoopRow>(
      `select id, name, description, summary, status, priority, owner_agent, deferred_until, plan, clarification_questions, approval_scope, updated_at, metadata
       from loops
       order by updated_at desc`,
    );

    const rows = normalizeRows((loopsRes.rows as LoopRow[])).filter((loop) => !isArchivedFromMainList(loop));
    const ready = rows.filter(isReadyForApproval);
    if (ready.length) {
      const ids = ready.map((loop) => loop.id);
      const now = new Date().toISOString();
      await query(`update loops set status = 'needs_approval', updated_at = $1 where id = any($2::uuid[]) and status = 'planning'`, [now, ids]);
      for (const loop of ready) {
        await query(
          `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
           values ($1, 'loop.ready_for_approval', 'planning', 'needs_approval', 'system:auto', $2::jsonb, $3)`,
          [loop.id, JSON.stringify({ source: 'read_model_auto_promotion', guarded: true }), now],
        );
        loop.status = 'needs_approval';
      }
    }

    const loopIds = rows.map((p) => p.id);
    const [workLinksRes, primaryExecutionByLoop] = await Promise.all([
      loopIds.length ? query<{ loop_id: string }>(`select loop_id from loop_work_items`) : Promise.resolve({ rows: [] as { loop_id: string }[] }),
      listPrimaryExecutionWorkItemsLocal(loopIds),
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
      const { progressPercent, progressLabel } = deriveProgress(loop);
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
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,plan,clarification_questions,approval_scope,updated_at,metadata")
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const rows = ((loops || []) as LoopRow[]).filter((loop) => !isArchivedFromMainList(loop));
  await autoPromotePlanningLoops(rows);
  const loopIds = rows.map((p) => p.id);

  const [workLinks, primaryExecutionByLoop] = await Promise.all([
    loopIds.length ? supabaseAdmin.from("loop_work_items").select("loop_id") : Promise.resolve({ data: [], error: null }),
    listPrimaryExecutionWorkItems(supabaseAdmin, loopIds),
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
    const { progressPercent, progressLabel } = deriveProgress(loop);
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
      `select id, name, description, summary, status, priority, owner_agent, deferred_until, target_outcome, acceptance_criteria, plan, clarification_questions, approval_scope, notes, metadata, updated_at
       from loops
       where id = $1
       limit 1`,
      [loopId],
    );
    const row = loopRes.rows[0] ? normalizeRows([loopRes.rows[0] as LoopRow])[0] : null;
    if (!row) return null;

    if (isReadyForApproval(row)) {
      const now = new Date().toISOString();
      await query(`update loops set status = 'needs_approval', updated_at = $1 where id = $2 and status = 'planning'`, [now, loopId]);
      await query(
        `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
         values ($1, 'loop.ready_for_approval', 'planning', 'needs_approval', 'system:auto', $2::jsonb, $3)`,
        [loopId, JSON.stringify({ source: 'read_model_auto_promotion', guarded: true }), now],
      );
      row.status = 'needs_approval';
    }

    const primaryExecution = await getPrimaryExecutionWorkItemLocal(loopId);
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
    .select("id,name,description,summary,status,priority,owner_agent,deferred_until,target_outcome,acceptance_criteria,plan,clarification_questions,approval_scope,notes,metadata,updated_at")
    .eq("id", loopId)
    .maybeSingle();

  if (error) throw error;
  if (!loop) return null;

  const row = loop as LoopRow;

  if (isReadyForApproval(row)) {
    await autoPromotePlanningLoops([row]);
  }

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
