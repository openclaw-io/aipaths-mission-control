import type { SupabaseClient } from "@supabase/supabase-js";

export const OPEN_SUGGESTION_STATUSES = ["draft", "blocked", "ready", "in_progress"] as const;

export type SuggestionRisk = "low" | "medium" | "high";

export interface WorkItemSuggestionInput {
  title: string;
  instruction: string;
  dedupeKey: string;
  ownerAgent?: string;
  targetAgentId?: string;
  requestedBy?: string;
  priority?: string;
  risk?: SuggestionRisk;
  proposedAction?: string;
  approvalPrompt?: string;
  sourceType?: string;
  sourceId?: string;
  kind?: string;
  status?: "draft" | "blocked";
  scheduledFor?: string | null;
  payload?: Record<string, unknown>;
}

export interface DedupedSuggestionResult {
  id: string;
  title: string;
  status: string;
  created: boolean;
  dedupe_key: string;
}

export async function createDedupedSuggestion(
  db: SupabaseClient,
  input: WorkItemSuggestionInput
): Promise<DedupedSuggestionResult> {
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey) throw new Error("dedupeKey is required");

  const { data: existing, error: existingError } = await db
    .from("work_items")
    .select("id,title,status")
    .eq("payload->>dedupe_key", dedupeKey)
    .in("status", [...OPEN_SUGGESTION_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.id) {
    return {
      id: String(existing.id),
      title: String(existing.title || input.title),
      status: String(existing.status),
      created: false,
      dedupe_key: dedupeKey,
    };
  }

  const payload = {
    ...(input.payload || {}),
    requires_human_approval: true,
    dedupe_key: dedupeKey,
    risk: input.risk || "medium",
    proposed_action: input.proposedAction || input.title,
    approval_prompt: input.approvalPrompt || input.instruction,
    suggestion_source: input.payload?.suggestion_source || "mission_control",
  };

  const { data: inserted, error: insertError } = await db
    .from("work_items")
    .insert({
      kind: input.kind || "task",
      source_type: input.sourceType || "service",
      source_id: input.sourceId || null,
      title: input.title,
      instruction: input.instruction,
      status: input.status || "draft",
      priority: input.priority || "medium",
      owner_agent: input.ownerAgent || input.targetAgentId || "systems",
      target_agent_id: input.targetAgentId || input.ownerAgent || "systems",
      requested_by: input.requestedBy || "mission-control-suggestions",
      scheduled_for: input.scheduledFor ?? null,
      payload,
    })
    .select("id,title,status")
    .single();

  if (insertError || !inserted) throw insertError || new Error("suggestion_insert_failed");

  await db.from("event_log").insert({
    domain: "work",
    event_type: "work_item.suggestion_created",
    entity_type: "work_item",
    entity_id: inserted.id,
    actor: input.requestedBy || "mission-control-suggestions",
    payload: {
      dedupe_key: dedupeKey,
      title: input.title,
      owner_agent: input.ownerAgent || input.targetAgentId || "systems",
      target_agent_id: input.targetAgentId || input.ownerAgent || "systems",
      proposed_action: payload.proposed_action,
      risk: payload.risk,
      source_type: input.sourceType || "service",
      source_id: input.sourceId || null,
    },
  });

  return {
    id: String(inserted.id),
    title: String(inserted.title || input.title),
    status: String(inserted.status),
    created: true,
    dedupe_key: dedupeKey,
  };
}
