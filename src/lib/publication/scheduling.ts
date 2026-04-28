import type { SupabaseClient } from "@supabase/supabase-js";

export type PublicationKind = "blog" | "guide" | "doc" | "community_post" | "video" | string;

export type PublicationSlotResult = {
  scheduledFor: string;
  source: "explicit" | "existing" | "auto_allocated";
};

export type CommunityPublicationSegment = "content_launch" | "news" | "poll" | "tool_of_day" | "startup_of_day" | "default";

// Default content publication slots: 13:00 and 20:00 Europe/London during BST.
// Stored as UTC ISO timestamps for the Work Queue scheduler.
const DEFAULT_PUBLISH_HOURS_UTC = [12, 19];
const OPEN_PUBLICATION_STATUSES = ["draft", "ready", "blocked", "in_progress"];
const LONDON_TZ = "Europe/London";

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
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function getPayloadString(payload: Record<string, unknown> | null | undefined, key: string) {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function londonParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayMap[get("weekday")] ?? date.getUTCDay(),
  };
}

function timeZoneOffsetMs(date: Date, timeZone = LONDON_TZ) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - date.getTime();
}

function londonLocalToUtc(year: number, month: number, day: number, hour: number, minute = 0) {
  const approximate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset = timeZoneOffsetMs(approximate, LONDON_TZ);
  return new Date(approximate.getTime() - offset);
}

function addLondonDays(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  const london = londonParts(date);
  return { year: london.year, month: london.month, day: london.day, weekday: london.weekday };
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

export function isPublicationWorkItem(item: { payload?: Record<string, unknown> | null }) {
  const payload = item.payload || {};
  const relationType = getPayloadString(payload, "relation_type");
  const scheduleKind = getPayloadString(payload, "schedule_kind");
  const action = getPayloadString(payload, "action");
  return scheduleKind === "publication" || relationType === "publish" || action === "publish_blog" || action === "publish_guide" || action === "publish_community_post";
}

export function getCommunityPublicationSegment(metadata: Record<string, unknown> | null | undefined): CommunityPublicationSegment {
  const meta = metadata || {};
  const source = (meta.source || {}) as Record<string, unknown>;
  const raw = [
    meta.intel_destination_key,
    meta.destination_label,
    meta.kind,
    source.type,
    source.kind,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/\b(blog|guide|doc|video)\b/.test(raw) || raw.includes("announcement")) return "content_launch";
  if (raw.includes("tool") || raw.includes("herramienta")) return "tool_of_day";
  if (raw.includes("startup")) return "startup_of_day";
  if (raw.includes("poll") || raw.includes("encuesta")) return "poll";
  if (raw.includes("news") || raw.includes("noticia") || raw.includes("radar") || meta.intel) return "news";
  return "default";
}

function communitySlotDefinition(segment: CommunityPublicationSegment) {
  switch (segment) {
    case "news":
      return { weekdays: [1, 2, 3, 4, 5, 6, 0], hours: [12, 16, 20], maxPerWeek: null };
    case "poll":
      return { weekdays: [1], hours: [12], maxPerWeek: 1 };
    case "tool_of_day":
      return { weekdays: [2, 4], hours: [12], maxPerWeek: 2 };
    case "startup_of_day":
      return { weekdays: [3, 5], hours: [12], maxPerWeek: 2 };
    default:
      return { weekdays: [1, 2, 3, 4, 5], hours: [12], maxPerWeek: null };
  }
}

function weekKey(date: Date) {
  const london = londonParts(date);
  const localNoon = londonLocalToUtc(london.year, london.month, london.day, 12, 0);
  const day = londonParts(localNoon).weekday || 7;
  const monday = new Date(localNoon);
  monday.setUTCDate(monday.getUTCDate() - (day - 1));
  const mondayParts = londonParts(monday);
  return `${mondayParts.year}-${String(mondayParts.month).padStart(2, "0")}-${String(mondayParts.day).padStart(2, "0")}`;
}

async function getOccupiedPublicationSlots(db: SupabaseClient, now: Date, horizon: Date) {
  const { data, error } = await db
    .from("work_items")
    .select("id, source_id, scheduled_for, payload, status")
    .in("status", OPEN_PUBLICATION_STATUSES)
    .not("scheduled_for", "is", null)
    .gte("scheduled_for", now.toISOString())
    .lte("scheduled_for", horizon.toISOString());

  if (error) throw error;
  return data || [];
}

export async function resolveCommunityPublicationSlot(
  db: SupabaseClient,
  input: {
    metadata?: Record<string, unknown> | null;
    explicitScheduledFor?: string | null;
    existingScheduledFor?: string | null;
    pipelineItemId?: string | null;
    now?: Date;
  } = {}
): Promise<PublicationSlotResult | null> {
  const segment = getCommunityPublicationSegment(input.metadata);
  if (segment === "content_launch") return null;

  if (input.explicitScheduledFor) return { scheduledFor: input.explicitScheduledFor, source: "explicit" };
  if (input.existingScheduledFor) return { scheduledFor: input.existingScheduledFor, source: "existing" };

  const now = input.now || new Date();
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  horizon.setUTCHours(23, 59, 59, 999);

  const occupiedItems = await getOccupiedPublicationSlots(db, now, horizon);
  const occupied = new Set<string>();
  const weeklyCounts = new Map<string, number>();

  for (const item of occupiedItems) {
    if (input.pipelineItemId && item.source_id === input.pipelineItemId) continue;
    if (!isPublicationWorkItem(item as { payload?: Record<string, unknown> | null })) continue;
    if (!item.scheduled_for) continue;
    occupied.add(slotKey(item.scheduled_for));
    const itemSegment = getPayloadString(item.payload as Record<string, unknown> | null, "community_segment") as CommunityPublicationSegment | null;
    if (itemSegment === segment) {
      const key = `${segment}:${weekKey(new Date(item.scheduled_for))}`;
      weeklyCounts.set(key, (weeklyCounts.get(key) || 0) + 1);
    }
  }

  const definition = communitySlotDefinition(segment);
  const today = londonParts(now);

  for (let offset = 0; offset < 60; offset += 1) {
    const day = addLondonDays({ year: today.year, month: today.month, day: today.day }, offset);
    if (!definition.weekdays.includes(day.weekday)) continue;
    const weekCount = weeklyCounts.get(`${segment}:${weekKey(londonLocalToUtc(day.year, day.month, day.day, 12, 0))}`) || 0;
    if (definition.maxPerWeek !== null && weekCount >= definition.maxPerWeek) continue;

    for (const hour of definition.hours) {
      const candidate = londonLocalToUtc(day.year, day.month, day.day, hour, 0);
      if (candidate.getTime() <= now.getTime()) continue;
      if (occupied.has(slotKey(candidate))) continue;
      return { scheduledFor: candidate.toISOString(), source: "auto_allocated" };
    }
  }

  const fallback = new Date(horizon);
  fallback.setUTCHours(12, 0, 0, 0);
  return { scheduledFor: fallback.toISOString(), source: "auto_allocated" };
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

  const data = await getOccupiedPublicationSlots(db, now, horizon);

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
