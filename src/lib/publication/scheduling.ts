import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicationKind = "blog" | "guide" | "doc" | "community_post" | "video" | string;

export type PublicationSlotResult = {
  scheduledFor: string;
  source: "explicit" | "existing" | "auto_allocated";
};

const DEFAULT_PUBLISH_HOURS_UTC = [9, 14, 17];
const OPEN_PUBLICATION_STATUSES = ["draft", "ready", "blocked", "in_progress"];

function isWeekend(date: Date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function moveToNextWeekday(date: Date) {
  while (isWeekend(date)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
}

function slotKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function buildCandidateSlots(now = new Date(), days = 30) {
  const slots: string[] = [];
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(0, 0, 0, 0);

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + offset);
    if (isWeekend(day)) continue;

    for (const hour of DEFAULT_PUBLISH_HOURS_UTC) {
      const slot = new Date(day);
      slot.setUTCHours(hour, 0, 0, 0);
      if (slot.getTime() > now.getTime()) slots.push(slot.toISOString());
    }
  }

  return slots;
}

function getPayloadString(payload: Record<string, unknown> | null | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

export function isPublicationWorkItem(item: { payload?: Record<string, unknown> | null }) {
  const payload = item.payload || {};
  const relationType = getPayloadString(payload, "relation_type");
  const scheduleKind = getPayloadString(payload, "schedule_kind");
  const action = getPayloadString(payload, "action");
  return scheduleKind === "publication" || relationType === "publish" || action === "publish_blog" || action === "publish_guide" || action === "publish_community_post";
}

export async function resolvePublicationSlot(
  db: SupabaseClient,
  input: {
    explicitScheduledFor?: string | null;
    existingScheduledFor?: string | null;
    pipelineItemId?: string | null;
    now?: Date;
  } = {}
): Promise<PublicationSlotResult> {
  if (input.explicitScheduledFor) {
    return { scheduledFor: input.explicitScheduledFor, source: "explicit" };
  }

  if (input.existingScheduledFor) {
    return { scheduledFor: input.existingScheduledFor, source: "existing" };
  }

  const now = input.now || new Date();
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  horizon.setUTCHours(23, 59, 59, 999);

  const { data, error } = await db
    .from("work_items")
    .select("id, source_id, scheduled_for, payload, status")
    .in("status", OPEN_PUBLICATION_STATUSES)
    .not("scheduled_for", "is", null)
    .gte("scheduled_for", now.toISOString())
    .lte("scheduled_for", horizon.toISOString());

  if (error) throw error;

  const occupied = new Set<string>();
  for (const item of data || []) {
    if (input.pipelineItemId && item.source_id === input.pipelineItemId) continue;
    if (!isPublicationWorkItem(item as { payload?: Record<string, unknown> | null })) continue;
    if (item.scheduled_for) occupied.add(slotKey(item.scheduled_for));
  }

  for (const candidate of buildCandidateSlots(now)) {
    if (!occupied.has(slotKey(candidate))) {
      return { scheduledFor: candidate, source: "auto_allocated" };
    }
  }

  const fallback = moveToNextWeekday(new Date(horizon));
  fallback.setUTCHours(DEFAULT_PUBLISH_HOURS_UTC[0], 0, 0, 0);
  return { scheduledFor: fallback.toISOString(), source: "auto_allocated" };
}
