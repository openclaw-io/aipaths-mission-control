import type { SupabaseClient } from "@supabase/supabase-js";

export type PipelineWorkInput = {
  pipelineItemId: string;
  pipelineType: string;
  title: string;
  instruction: string;
  priority?: string | null;
  ownerAgent: string;
  requestedBy: string;
  relationType: string;
  action: string;
  trigger: string;
  reviewNotes?: string;
  mapRelationType?: string;
  payloadRelationType?: string;
  scheduledFor?: string | null;
  payloadExtra?: Record<string, unknown>;
  updateExisting?: boolean;
};

const OPEN_STATUSES = ["draft", "ready", "blocked", "in_progress"];

function shouldPreserveBlockedLiveGate(item: { status?: string | null; payload?: Record<string, unknown> | null }) {
  if (item.status !== "blocked") return false;
  const payload = (item.payload || {}) as Record<string, unknown>;
  return payload.requires_live_check_passed === true
    || payload.dispatch_state === "blocked_live_gate"
    || typeof payload.public_gate_applies_to === "string";
}

function updateExistingStatus(item: { status?: string | null; payload?: Record<string, unknown> | null }, scheduledFor?: string | null) {
  if (scheduledFor) return "ready";
  if (item.status === "in_progress") return "in_progress";
  if (shouldPreserveBlockedLiveGate(item)) return "blocked";
  return "ready";
}

export async function findOpenPipelineWorkItem(
  db: SupabaseClient,
  pipelineItemId: string,
  relationType: string
) {
  const { data, error } = await db
    .from("work_items")
    .select("id, title, instruction, status, source_type, owner_agent, target_agent_id, scheduled_for, payload")
    .in("source_type", ["pipeline_item", "service"])
    .eq("source_id", pipelineItemId)
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data || []).find((item: { payload?: { relation_type?: string } | null }) => item?.payload?.relation_type === relationType) || null;
}

export async function createPipelineWorkItem(db: SupabaseClient, input: PipelineWorkInput) {
  const payloadRelationType = input.payloadRelationType || input.relationType;
  const mapRelationType = input.mapRelationType || input.relationType;
  const payload: Record<string, unknown> = {
    trigger: input.trigger,
    pipeline_type: input.pipelineType,
    pipeline_item_id: input.pipelineItemId,
    relation_type: payloadRelationType,
    map_relation_type: mapRelationType,
    action: input.action,
    review_notes: input.reviewNotes,
    ...(input.payloadExtra || {}),
  };
  const existing = await findOpenPipelineWorkItem(db, input.pipelineItemId, payloadRelationType);
  if (existing) {
    if (input.updateExisting) {
      const nextStatus = updateExistingStatus(existing, input.scheduledFor);
      const existingPayload = (existing.payload || {}) as Record<string, unknown>;
      const nextPayload = { ...existingPayload, ...payload };
      if (input.scheduledFor && existingPayload.dispatch_state === "blocked_live_gate") {
        nextPayload.previous_dispatch_state = "blocked_live_gate";
        nextPayload.dispatch_state = "ready_after_explicit_schedule";
      }
      const patch: Record<string, unknown> = {
        title: input.title,
        instruction: input.instruction,
        status: nextStatus,
        priority: input.priority || "medium",
        owner_agent: input.ownerAgent,
        target_agent_id: input.ownerAgent,
        requested_by: input.requestedBy,
        scheduled_for: input.scheduledFor || null,
        updated_at: new Date().toISOString(),
        payload: nextPayload,
      };
      if (nextStatus === "ready") {
        patch.started_at = null;
        patch.completed_at = null;
      }

      const { data: updated, error } = await db
        .from("work_items")
        .update(patch)
        .eq("id", existing.id)
        .select("id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload")
        .single();

      if (error) throw error;
      return { workItem: updated, created: false, updatedExisting: true };
    }
    return { workItem: existing, created: false };
  }

  const { data: workItem, error } = await db
    .from("work_items")
    .insert({
      kind: "task",
      source_type: "pipeline_item",
      source_id: input.pipelineItemId,
      title: input.title,
      instruction: input.instruction,
      status: "ready",
      priority: input.priority || "medium",
      owner_agent: input.ownerAgent,
      target_agent_id: input.ownerAgent,
      requested_by: input.requestedBy,
      scheduled_for: input.scheduledFor || null,
      payload,
    })
    .select("id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload")
    .single();

  if (error) throw error;

  const { error: mapError } = await db.from("pipeline_work_map").insert({
    pipeline_item_id: input.pipelineItemId,
    work_item_id: workItem.id,
    relation_type: mapRelationType,
  });
  if (mapError) {
    // Mapping is useful for pipeline traceability, but it must not make the
    // caller partially fail after the work item has already been created.
    // Some legacy relation_type constraints can reject newer workflow labels.
    console.error("[pipeline-materializer] Failed to insert pipeline_work_map", {
      pipelineItemId: input.pipelineItemId,
      workItemId: workItem.id,
      relationType: mapRelationType,
      error: mapError.message,
    });
  }

  const { error: eventError } = await db.from("pipeline_events").insert({
    pipeline_item_id: input.pipelineItemId,
    event_type: "pipeline_item.work_item_created",
    actor: "pipeline-materializer",
    from_status: null,
    to_status: null,
    payload: {
      work_item_id: workItem.id,
      relation_type: payloadRelationType,
      map_relation_type: mapRelationType,
      source_type: "pipeline_item",
      target_agent_id: input.ownerAgent,
      trigger: input.trigger,
      action: input.action,
    },
  });
  if (eventError) {
    console.error("[pipeline-materializer] Failed to insert pipeline_events", {
      pipelineItemId: input.pipelineItemId,
      workItemId: workItem.id,
      relationType: payloadRelationType,
      error: eventError.message,
    });
  }

  return { workItem, created: true };
}
