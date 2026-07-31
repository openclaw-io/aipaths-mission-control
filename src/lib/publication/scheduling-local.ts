import type { PoolClient } from "pg";
import { query } from "@/lib/db/postgres";
import { getCommunityPublicationSegment, isPublicationWorkItem, type CommunityPublicationSegment, type PublicationSlotResult } from "@/lib/publication/scheduling";

type OccupiedPublicationRow = {
  id: string;
  source_id: string | null;
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
  status: string;
};

const DEFAULT_PUBLISH_HOURS_UTC = [12, 19];
const OPEN_PUBLICATION_STATUSES = ["draft", "ready", "blocked", "in_progress"];
const LONDON_TZ = "Europe/London";
type QueryClient = Pick<PoolClient, "query">;

function isWeekend(date: Date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function moveToNextWeekday(date: Date) {
  while (isWeekend(date)) date.setUTCDate(date.getUTCDate() + 1);
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

async function getOccupiedPublicationSlotsLocal(now: Date, horizon: Date, client?: QueryClient) {
  const sql = `select id, source_id, scheduled_for, payload, status
       from work_items
      where status = any($1::text[])
        and scheduled_for is not null
        and scheduled_for >= $2
        and scheduled_for <= $3`;
  const params = [OPEN_PUBLICATION_STATUSES, now.toISOString(), horizon.toISOString()];
  const { rows } = client
    ? await client.query<OccupiedPublicationRow>(sql, params)
    : await query<OccupiedPublicationRow>(sql, params);
  return rows;
}

export async function resolvePublicationSlotLocal(input: {
  explicitScheduledFor?: string | null;
  existingScheduledFor?: string | null;
  pipelineItemId?: string | null;
  now?: Date;
  client?: QueryClient;
} = {}): Promise<PublicationSlotResult> {
  if (input.explicitScheduledFor) return { scheduledFor: input.explicitScheduledFor, source: "explicit" };
  if (input.existingScheduledFor) return { scheduledFor: input.existingScheduledFor, source: "existing" };

  const now = input.now || new Date();
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  horizon.setUTCHours(23, 59, 59, 999);

  const data = await getOccupiedPublicationSlotsLocal(now, horizon, input.client);
  const occupied = new Set<string>();

  for (const item of data) {
    if (input.pipelineItemId && item.source_id === input.pipelineItemId) continue;
    if (!isPublicationWorkItem(item)) continue;
    if (item.scheduled_for) occupied.add(slotKey(item.scheduled_for));
  }

  for (const candidate of buildCandidateSlots(now)) {
    if (!occupied.has(slotKey(candidate))) return { scheduledFor: candidate, source: "auto_allocated" };
  }

  const fallback = moveToNextWeekday(new Date(horizon));
  fallback.setUTCHours(DEFAULT_PUBLISH_HOURS_UTC[0], 0, 0, 0);
  return { scheduledFor: fallback.toISOString(), source: "auto_allocated" };
}

export async function resolveCommunityPublicationSlotLocal(input: {
  metadata?: Record<string, unknown> | null;
  explicitScheduledFor?: string | null;
  existingScheduledFor?: string | null;
  pipelineItemId?: string | null;
  now?: Date;
  client?: QueryClient;
} = {}): Promise<PublicationSlotResult | null> {
  if (input.explicitScheduledFor) return { scheduledFor: input.explicitScheduledFor, source: "explicit" };
  if (input.existingScheduledFor) return { scheduledFor: input.existingScheduledFor, source: "existing" };

  const segment = getCommunityPublicationSegment(input.metadata);
  if (segment === "content_launch") return null;

  const now = input.now || new Date();
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  horizon.setUTCHours(23, 59, 59, 999);

  const occupiedItems = await getOccupiedPublicationSlotsLocal(now, horizon, input.client);
  const occupied = new Set<string>();
  const weeklyCounts = new Map<string, number>();

  for (const item of occupiedItems) {
    if (input.pipelineItemId && item.source_id === input.pipelineItemId) continue;
    if (!isPublicationWorkItem(item)) continue;
    if (!item.scheduled_for) continue;
    occupied.add(slotKey(item.scheduled_for));
    const itemSegment = getPayloadString(item.payload, "community_segment") as CommunityPublicationSegment | null;
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
