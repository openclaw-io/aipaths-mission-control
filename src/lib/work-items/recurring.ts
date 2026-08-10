import type { SupabaseClient } from "@supabase/supabase-js";
import { query, withTransaction } from "@/lib/db/postgres";

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

export const STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_VERSION = "live_class_reporting_v1_2026_08_04";
export const STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_DATE = "2026-08-04";
// Relativa a propósito. Este valor se PERSISTE en el payload de cada work item generado
// (ver contract_path más abajo), y una ruta absoluta ahí es justo lo que ensució la base:
// GON-88 encontró 159 work_items con rutas de máquina adentro. Relativa al directorio de
// agentes es correcta en las dos máquinas y sobrevive a la migración de GON-71.
export const STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_PATH =
  "director-strategist/analytics/live-class-reporting-contract-2026-08-04.md";

export const STRATEGIST_LIVE_CLASS_REPORT_SECTIONS = [
  "edition_live_registrations",
  "top_3_acquisition_channels_by_signups",
  "global_funnel_views_clicks_signups_ventas",
  "community_new_members",
];

export const STRATEGIST_LIVE_CLASS_SOURCE_TABLES = [
  "academy.live_events",
  "academy.events",
  "academy.live_registrations",
  "academy.orders",
  "mission_control.ops_community_member_daily",
];

export const STRATEGIST_LIVE_CLASS_CANONICAL_FIELDS = {
  edition: {
    table: "academy.live_events",
    fields: ["id", "slug", "title", "starts_at", "status"],
    selection: "Use the live_events row for slug=tu-primer-agente-ia. If multiple editions are open, keep the chosen id/starts_at explicit.",
  },
  views: {
    table: "academy.events",
    event_type: "live_landing_view",
    time_field: "timestamp",
    fields: ["visitor_id", "session_id", "properties.event_id", "properties.event_slug", "page_url"],
    metric: "Unique live-class landing sessions in the reporting window.",
  },
  cta_clicks: {
    table: "academy.events",
    event_type: "live_registration_started",
    time_field: "timestamp",
    fields: ["visitor_id", "session_id", "properties.event_id", "properties.event_slug", "page_url"],
    metric: "Registration CTA/form-start clicks in the reporting window.",
  },
  live_registrations: {
    table: "academy.live_registrations",
    time_field: "registered_at",
    fields: ["id", "event_id", "status", "registered_at", "source", "ref", "first_ref", "last_ref", "visitor_id", "session_id"],
    metric: "Edition-specific registration rows created in the reporting window.",
  },
  acquisition_channels: {
    primary: "academy.live_registrations.first_ref normalized with derive_attribution_source",
    fallback: "academy.live_registrations.source, then ref/last_ref, labelled as fallback when first_ref is unavailable",
    ranking: "Rank only channels with at least one live registration; order by signup count and show count/share.",
  },
  ventas: {
    table: "academy.orders",
    time_field: "completed_at",
    fields: ["id", "status", "completed_at", "amount", "currency", "product_id", "current_ref", "first_ref", "last_ref", "visitor_id", "session_id"],
    attribution: "Completed paid orders attributable to the live-class/cohort path by registration visitor/session match or live-class ref evidence. If attribution coverage is incomplete, report N/D.",
  },
  community_new_members: {
    table: "mission_control.ops_community_member_daily",
    time_field: "date",
    fields: ["date", "new_human_members", "human_members_at_check", "total_members_at_check", "checked_at", "coverage"],
    metric: "sum(new_human_members)",
    window: "Sum closed Europe/London calendar dates inside the report window. For daily, require the previous complete local date row.",
    freshness: "Return N/D when the expected closed-date row is absent. Current totals belong to checked_at, not date.",
    backfill_note: "Rows with coverage=current_member_list_backfill are incomplete because members who departed before the first sync are unrecoverable.",
  },
};

const STRATEGIST_LIVE_CLASS_MISSING_COVERAGE_POLICY = {
  value: "N/D",
  rule: "Use N/D, not 0, when a source/table/field/window was not successfully checked for full coverage. Report zero only after successful full-window coverage.",
};

const STRATEGIST_REPORTING_METADATA_PASSTHROUGH_KEYS = [
  "mode",
  "category",
  "monthly_day",
  "weekly_weekday",
  "channel_reports",
  "channel_agent_log",
  "cleanup_backout",
];

function strategistReportingMetadata(metadata: Record<string, unknown> | null) {
  const safeMetadata: Record<string, unknown> = {};
  for (const key of STRATEGIST_REPORTING_METADATA_PASSTHROUGH_KEYS) {
    if (metadata && Object.prototype.hasOwnProperty.call(metadata, key)) {
      safeMetadata[key] = metadata[key];
    }
  }
  return safeMetadata;
}

function strategistLiveClassInstruction(typeLabel: string, titleDate: string) {
  return [
    `Prepare the ${typeLabel.toLowerCase()} strategist report for ${titleDate}.`,
    "Use the live-class reporting contract. The report must contain only: (1) edition-specific live class registrations, (2) top 3 acquisition channels that produced those registrations, ordered by signups with count/share, (3) global funnel Views -> Clicks -> Signups -> Ventas, and (4) new Community members.",
    "Canonical fields: views from academy.events event_type=live_landing_view; CTA clicks from academy.events event_type=live_registration_started; signups from academy.live_registrations by event_id and registered_at; ventas from academy.orders completed orders attributable to the live-class/cohort path; Community joins from mission_control.ops_community_member_daily by date, summing new_human_members for closed Europe/London days.",
    "Use first-touch acquisition when available: live_registrations.first_ref normalized with derive_attribution_source. If first_ref is unavailable, use source/ref/last_ref as a labelled fallback.",
    "Never report a false zero. Use N/D when source coverage or tracking is missing; report 0 only when the relevant source was checked for the full reporting window.",
    "Keep the report strictly to those four sections; no extra analysis, broad rankings, broad platform metrics, tasks, commentary, or fan-out.",
    "Do not read Academy legacy daily_digest or legacy recurrence tables.",
    "Keep com.aipaths.daily-scrape as the data ingestion source, then post the finished report through the normal strategist reporting path and close this work item.",
  ].join("\n\n");
}

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
  const instruction = strategistLiveClassInstruction(typeLabel, titleDate);
  const payload: Record<string, unknown> = {
    category: rule.metadata?.category || "strategist_reporting",
    contract_version: STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_VERSION,
    contract_decision_date: STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_DATE,
    contract_path: STRATEGIST_LIVE_CLASS_REPORTING_CONTRACT_PATH,
    report_type: reportType,
    report_date: reportDate,
    report_sections: STRATEGIST_LIVE_CLASS_REPORT_SECTIONS,
    source_tables: STRATEGIST_LIVE_CLASS_SOURCE_TABLES,
    canonical_fields: STRATEGIST_LIVE_CLASS_CANONICAL_FIELDS,
    acquisition_attribution: STRATEGIST_LIVE_CLASS_CANONICAL_FIELDS.acquisition_channels,
    missing_coverage_policy: STRATEGIST_LIVE_CLASS_MISSING_COVERAGE_POLICY,
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
    contract_version: typeof occurrence.payload.contract_version === "string" ? occurrence.payload.contract_version : null,
    contract_decision_date: typeof occurrence.payload.contract_decision_date === "string" ? occurrence.payload.contract_decision_date : null,
    contract_path: typeof occurrence.payload.contract_path === "string" ? occurrence.payload.contract_path : null,
    reportType: typeof occurrence.payload.report_type === "string" ? occurrence.payload.report_type : null,
    instruction: occurrence.instruction,
    source_tables: Array.isArray(occurrence.payload.source_tables) ? occurrence.payload.source_tables : null,
    report_sections: Array.isArray(occurrence.payload.report_sections) ? occurrence.payload.report_sections : null,
    canonical_fields: occurrence.payload.canonical_fields && typeof occurrence.payload.canonical_fields === "object" ? occurrence.payload.canonical_fields : null,
    missing_coverage_policy: occurrence.payload.missing_coverage_policy && typeof occurrence.payload.missing_coverage_policy === "object" ? occurrence.payload.missing_coverage_policy : null,
  }));
}

export function buildRecurringWorkPayload(rule: RecurringWorkRule, occurrence: PlannedOccurrence) {
  const metadata = isCadenceRouterRule(rule) && rule.metadata?.category === "strategist_reporting"
    ? strategistReportingMetadata(rule.metadata)
    : { ...(rule.metadata || {}) };

  return {
    ...metadata,
    ...occurrence.payload,
    trigger: "recurring_work_rule",
    recurring_rule_id: rule.id,
    occurrence_key: occurrence.occurrenceKey,
    cadence_unit: rule.cadence_unit,
    cadence_interval: rule.cadence_interval,
    timezone: rule.timezone,
  };
}

export async function listEnabledRecurringWorkRulesLocal() {
  const { rows } = await query(`
    SELECT
      id::text,
      title,
      instruction,
      owner_agent,
      target_agent_id,
      requested_by,
      priority,
      cadence_unit,
      cadence_interval,
      time_of_day,
      timezone,
      start_date::text,
      end_date::text,
      horizon_days,
      enabled,
      metadata,
      last_materialized_at::text,
      created_at::text,
      updated_at::text
    FROM public.recurring_work_rules
    WHERE enabled = true
    ORDER BY created_at ASC
  `);

  return rows as RecurringWorkRule[];
}

export async function materializeRecurringWorkLocal(requestedBy = "recurring-work-materializer") {
  const rules = await listEnabledRecurringWorkRulesLocal();
  const details: MaterializeDetail[] = [];
  let created = 0;
  let existing = 0;

  for (const rule of rules) {
    const occurrences = plannedOccurrences(rule);

    for (const occurrence of occurrences) {
      const result = await withTransaction(async (client) => {
        const existingOccurrence = await client.query<{ id: string; work_item_id: string | null }>(`
          SELECT id, work_item_id
          FROM public.recurring_work_occurrences
          WHERE rule_id = $1
            AND occurrence_key = $2
          LIMIT 1
        `, [rule.id, occurrence.occurrenceKey]);

        if (existingOccurrence.rows[0]?.work_item_id) {
          return {
            action: "exists" as const,
            workItemId: existingOccurrence.rows[0].work_item_id,
          };
        }

        const payload = buildRecurringWorkPayload(rule, occurrence);

        const workItem = await client.query<{ id: string }>(`
          INSERT INTO public.work_items (
            kind, source_type, source_id, title, instruction, status, priority,
            owner_agent, target_agent_id, requested_by, scheduled_for, payload
          ) VALUES ($1, 'service', $2, $3, $4, 'ready', $5, $6, $7, $8, $9::timestamptz, $10::jsonb)
          RETURNING id
        `, [
          occurrence.kind,
          rule.id,
          occurrence.title,
          occurrence.instruction,
          rule.priority || "medium",
          rule.owner_agent,
          rule.target_agent_id || rule.owner_agent,
          rule.requested_by || requestedBy,
          occurrence.scheduledFor,
          JSON.stringify(payload),
        ]);

        const workItemId = workItem.rows[0]?.id;
        if (!workItemId) throw new Error("work_item_insert_failed");

        await client.query(`
          INSERT INTO public.recurring_work_occurrences (rule_id, occurrence_key, scheduled_for, work_item_id)
          VALUES ($1, $2, $3::timestamptz, $4)
        `, [rule.id, occurrence.occurrenceKey, occurrence.scheduledFor, workItemId]);

        await client.query(`
          INSERT INTO public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
          VALUES ('work', 'recurring_work.materialized', 'work_item', $1, $2, $3::jsonb)
        `, [
          workItemId,
          requestedBy,
          JSON.stringify({
            recurring_rule_id: rule.id,
            occurrence_key: occurrence.occurrenceKey,
            scheduled_for: occurrence.scheduledFor,
            title: occurrence.title,
            owner_agent: rule.owner_agent,
          }),
        ]);

        return { action: "created" as const, workItemId };
      });

      if (result.action === "exists") {
        existing++;
      } else {
        created++;
      }

      details.push({
        ruleId: rule.id,
        title: occurrence.title,
        occurrenceKey: occurrence.occurrenceKey,
        scheduledFor: occurrence.scheduledFor,
        action: result.action,
        workItemId: result.workItemId,
      });
    }

    await query(`
      UPDATE public.recurring_work_rules
      SET last_materialized_at = now(),
          updated_at = now()
      WHERE id = $1
    `, [rule.id]);
  }

  return { created, existing, rules: rules.length, details };
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

      const payload = buildRecurringWorkPayload(rule, occurrence);

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
