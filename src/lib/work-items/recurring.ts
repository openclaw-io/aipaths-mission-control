import type { SupabaseClient } from "@supabase/supabase-js";

export type RecurringWorkRule = {
  id: string;
  title: string;
  instruction: string;
  owner_agent: string;
  target_agent_id: string | null;
  requested_by: string | null;
  priority: string | null;
  cadence_unit: "days" | "weeks";
  cadence_interval: number;
  time_of_day: string;
  timezone: string;
  start_date: string;
  end_date: string | null;
  horizon_days: number;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  last_materialized_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type MaterializeDetail = {
  ruleId: string;
  title: string;
  occurrenceKey: string;
  scheduledFor: string;
  action: "created" | "exists" | "skipped";
  workItemId?: string;
  reason?: string;
};

type PlannedOccurrence = {
  occurrenceKey: string;
  scheduledFor: string;
  title: string;
  instruction: string;
  kind: string;
  payload: Record<string, unknown>;
};

const STRATEGIST_REPORTING_TABLES = [
  "ops_daily_snapshots",
  "academy_daily_kpis",
  "ops_youtube_video_daily",
  "ops_youtube_channel_daily",
  "ops_youtube_short_daily",
  "ops_community_daily",
  "ops_youtube_comments",
  "intel_items_raw",
  "intel_trend_daily",
];

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function zonedTimeToUtcIso(date: Date, timeOfDay: string, timeZone: string) {
  const [hourRaw, minuteRaw] = timeOfDay.split(":");
  const desired = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: Number(hourRaw || 0),
    minute: Number(minuteRaw || 0),
  };
  let utc = new Date(Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, 0, 0));

  // Convert a local wall-clock time in the rule timezone into UTC. One correction
  // pass is enough for normal offsets; a second pass protects DST boundaries.
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(utc);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const actualAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      0,
      0,
    );
    const desiredAsUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, 0, 0);
    const deltaMs = desiredAsUtc - actualAsUtc;
    if (deltaMs === 0) break;
    utc = new Date(utc.getTime() + deltaMs);
  }

  return utc.toISOString();
}

function scheduledIsoForLocalDate(date: Date, timeOfDay: string) {
  const [hourRaw, minuteRaw] = timeOfDay.split(":");
  const hour = Number(hourRaw || 0);
  const minute = Number(minuteRaw || 0);
  const scheduled = new Date(date);
  scheduled.setHours(Number.isFinite(hour) ? hour : 2, Number.isFinite(minute) ? minute : 30, 0, 0);
  return scheduled.toISOString();
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function cadenceStepDays(rule: Pick<RecurringWorkRule, "cadence_unit" | "cadence_interval">) {
  return rule.cadence_unit === "weeks" ? rule.cadence_interval * 7 : rule.cadence_interval;
}

function isCadenceRouterRule(rule: RecurringWorkRule) {
  return rule.metadata?.mode === "cadence_router";
}

function reportTypeForDate(date: Date, rule: RecurringWorkRule) {
  const monthlyDay = Number(rule.metadata?.monthly_day || 1);
  const weeklyWeekday = Number(rule.metadata?.weekly_weekday || 1);
  if (date.getDate() === monthlyDay) return "monthly_review";
  if (date.getDay() === weeklyWeekday) return "weekly_review";
  return "daily_review";
}

function previousMonthWindow(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const end = new Date(date.getFullYear(), date.getMonth(), 0);
  return { month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`, month_start: dateKey(start), month_end: dateKey(end) };
}

function previousWeekWindow(date: Date) {
  const weekStart = addDays(date, -7);
  const weekEnd = addDays(date, -1);
  return { week_start: dateKey(weekStart), week_end: dateKey(weekEnd), window_days: 7 };
}

function strategistReportOccurrence(rule: RecurringWorkRule, day: Date, scheduledFor: string, occurrenceKey: string): PlannedOccurrence {
  const reportType = reportTypeForDate(day, rule);
  const reportDate = dateKey(day);
  const typeLabel = reportType === "monthly_review" ? "Monthly" : reportType === "weekly_review" ? "Weekly" : "Daily";
  const titleDate = reportType === "monthly_review" ? previousMonthWindow(day).month : reportDate;
  const title = `${typeLabel} review — ${titleDate}`;
  const instruction = [
    `Prepare the ${typeLabel.toLowerCase()} strategist report for ${titleDate}.`,
    "Use Mission Control canonical reporting tables only; do not read Academy legacy daily_digest or legacy recurrence tables.",
    "Keep com.aipaths.daily-scrape as the data ingestion source, then post the finished report through the normal strategist reporting path and close this work item.",
  ].join("\n\n");
  const payload: Record<string, unknown> = {
    category: rule.metadata?.category || "strategist_reporting",
    report_type: reportType,
    report_date: reportDate,
    source_tables: STRATEGIST_REPORTING_TABLES,
    legacy_sources_deprecated: ["recurrence_rules", "recurrence_materializations", "daily_digest"],
  };

  if (reportType === "weekly_review") Object.assign(payload, previousWeekWindow(day));
  if (reportType === "monthly_review") Object.assign(payload, previousMonthWindow(day));

  return { occurrenceKey, scheduledFor, title, instruction, kind: "report", payload };
}

export function plannedOccurrences(rule: RecurringWorkRule, now = new Date()): PlannedOccurrence[] {
  const isRouter = isCadenceRouterRule(rule);
  const horizonDays = rule.horizon_days || 28;
  const horizon = addDays(now, isRouter ? horizonDays + 1 : horizonDays);
  const stepDays = isRouter ? 1 : cadenceStepDays(rule);
  const start = parseDateKey(rule.start_date);
  const end = rule.end_date ? parseDateKey(rule.end_date) : null;
  const occurrences: PlannedOccurrence[] = [];

  for (let day = start; day <= horizon; day = addDays(day, stepDays)) {
    if (end && day > end) break;
    const scheduledFor = rule.timezone
      ? zonedTimeToUtcIso(day, rule.time_of_day || "02:30", rule.timezone)
      : scheduledIsoForLocalDate(day, rule.time_of_day || "02:30");
    if (new Date(scheduledFor).getTime() < now.getTime() - 60_000) continue;
    const key = `${rule.id}:${dateKey(day)}:${rule.time_of_day || "02:30"}`;
    if (isRouter && rule.metadata?.category === "strategist_reporting") {
      occurrences.push(strategistReportOccurrence(rule, day, scheduledFor, key));
      if (occurrences.length >= horizonDays) break;
    } else {
      occurrences.push({
        occurrenceKey: key,
        scheduledFor,
        title: rule.title,
        instruction: rule.instruction,
        kind: "task",
        payload: {},
      });
    }
  }

  return occurrences;
}

export function plannedOccurrenceDryRun(rule: RecurringWorkRule, now = new Date()) {
  return plannedOccurrences(rule, now).map((occurrence) => ({
    localDate: dateKeyInTimeZone(new Date(occurrence.scheduledFor), rule.timezone || "Europe/London"),
    title: occurrence.title,
    scheduledFor: occurrence.scheduledFor,
    reportType: typeof occurrence.payload.report_type === "string" ? occurrence.payload.report_type : null,
  }));
}

export async function materializeRecurringWork(db: SupabaseClient, requestedBy = "recurring-work-materializer") {
  const { data: rules, error } = await db
    .from("recurring_work_rules")
    .select("*")
    .eq("enabled", true)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const details: MaterializeDetail[] = [];
  let created = 0;
  let existing = 0;

  for (const rule of (rules || []) as RecurringWorkRule[]) {
    const occurrences = plannedOccurrences(rule);
    for (const occurrence of occurrences) {
      const { data: existingOccurrence, error: existingError } = await db
        .from("recurring_work_occurrences")
        .select("id, work_item_id")
        .eq("rule_id", rule.id)
        .eq("occurrence_key", occurrence.occurrenceKey)
        .maybeSingle();

      if (existingError) throw existingError;
      if (existingOccurrence?.work_item_id) {
        existing++;
        details.push({ ruleId: rule.id, title: occurrence.title, occurrenceKey: occurrence.occurrenceKey, scheduledFor: occurrence.scheduledFor, action: "exists", workItemId: existingOccurrence.work_item_id });
        continue;
      }

      const payload = {
        ...(rule.metadata || {}),
        ...occurrence.payload,
        trigger: "recurring_work_rule",
        recurring_rule_id: rule.id,
        occurrence_key: occurrence.occurrenceKey,
        cadence_unit: rule.cadence_unit,
        cadence_interval: rule.cadence_interval,
        timezone: rule.timezone,
      };

      const { data: workItem, error: workItemError } = await db
        .from("work_items")
        .insert({
          kind: occurrence.kind,
          source_type: "service",
          source_id: rule.id,
          title: occurrence.title,
          instruction: occurrence.instruction,
          status: "ready",
          priority: rule.priority || "medium",
          owner_agent: rule.owner_agent,
          target_agent_id: rule.target_agent_id || rule.owner_agent,
          requested_by: rule.requested_by || requestedBy,
          scheduled_for: occurrence.scheduledFor,
          payload,
        })
        .select("id")
        .single();

      if (workItemError || !workItem) throw workItemError || new Error("work_item_insert_failed");

      const { error: occurrenceError } = await db.from("recurring_work_occurrences").insert({
        rule_id: rule.id,
        occurrence_key: occurrence.occurrenceKey,
        scheduled_for: occurrence.scheduledFor,
        work_item_id: workItem.id,
      });

      if (occurrenceError) throw occurrenceError;

      await db.from("event_log").insert({
        domain: "work",
        event_type: "recurring_work.materialized",
        entity_type: "work_item",
        entity_id: workItem.id,
        actor: requestedBy,
        payload: {
          recurring_rule_id: rule.id,
          occurrence_key: occurrence.occurrenceKey,
          scheduled_for: occurrence.scheduledFor,
          title: occurrence.title,
          owner_agent: rule.owner_agent,
        },
      });

      created++;
      details.push({ ruleId: rule.id, title: occurrence.title, occurrenceKey: occurrence.occurrenceKey, scheduledFor: occurrence.scheduledFor, action: "created", workItemId: workItem.id });
    }

    await db.from("recurring_work_rules").update({ last_materialized_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", rule.id);
  }

  return { created, existing, rules: (rules || []).length, details };
}
