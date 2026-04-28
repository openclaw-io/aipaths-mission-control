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
};

const OPEN_STATUSES = ["draft", "ready", "blocked", "in_progress"];

export async function findOpenPipelineWorkItem(
  db: SupabaseClient,
  pipelineItemId: string,
  relationType: string
) {
  const { data, error } = await db
    .from("work_items")
    .select("id, status, source_type, owner_agent, target_agent_id, payload")
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
  const existing = await findOpenPipelineWorkItem(db, input.pipelineItemId, payloadRelationType);
  if (existing) {
    return { workItem: existing, created: false };
  }

  const payload = {
    trigger: input.trigger,
    pipeline_type: input.pipelineType,
    pipeline_item_id: input.pipelineItemId,
    relation_type: payloadRelationType,
    map_relation_type: mapRelationType,
    action: input.action,
    review_notes: input.reviewNotes,
    ...(input.payloadExtra || {}),
  };

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
    .select("id, title, status, source_type, owner_agent, target_agent_id, payload")
    .single();

  if (error) throw error;

  const { error: mapError } = await db.from("pipeline_work_map").insert({
    pipeline_item_id: input.pipelineItemId,
    work_item_id: workItem.id,
    relation_type: mapRelationType,
  });
  if (mapError) throw mapError;

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
  if (eventError) throw eventError;

  return { workItem, created: true };
}
