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

export function plannedOccurrences(rule: RecurringWorkRule, now = new Date()) {
  const horizon = addDays(now, rule.horizon_days || 28);
  const stepDays = cadenceStepDays(rule);
  const start = parseDateKey(rule.start_date);
  const end = rule.end_date ? parseDateKey(rule.end_date) : null;
  const occurrences: Array<{ occurrenceKey: string; scheduledFor: string }> = [];

  for (let day = start; day <= horizon; day = addDays(day, stepDays)) {
    if (end && day > end) break;
    const scheduledFor = scheduledIsoForLocalDate(day, rule.time_of_day || "02:30");
    if (new Date(scheduledFor).getTime() < now.getTime() - 60_000) continue;
    const key = `${rule.id}:${dateKey(day)}:${rule.time_of_day || "02:30"}`;
    occurrences.push({ occurrenceKey: key, scheduledFor });
  }

  return occurrences;
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
        details.push({ ruleId: rule.id, title: rule.title, occurrenceKey: occurrence.occurrenceKey, scheduledFor: occurrence.scheduledFor, action: "exists", workItemId: existingOccurrence.work_item_id });
        continue;
      }

      const payload = {
        ...(rule.metadata || {}),
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
          kind: "task",
          source_type: "recurring_rule",
          source_id: rule.id,
          title: rule.title,
          instruction: rule.instruction,
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
          title: rule.title,
          owner_agent: rule.owner_agent,
        },
      });

      created++;
      details.push({ ruleId: rule.id, title: rule.title, occurrenceKey: occurrence.occurrenceKey, scheduledFor: occurrence.scheduledFor, action: "created", workItemId: workItem.id });
    }

    await db.from("recurring_work_rules").update({ last_materialized_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", rule.id);
  }

  return { created, existing, rules: (rules || []).length, details };
}
