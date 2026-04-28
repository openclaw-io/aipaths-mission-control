import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { materializeRecurringWork } from "@/lib/work-items/recurring";

export const dynamic = "force-dynamic";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("recurring_work_rules")
    .select("*, recurring_work_occurrences(id, scheduled_for, work_item_id, status)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rules: data || [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const title = cleanText(body.title);
  const instruction = cleanText(body.instruction);
  const ownerAgent = cleanText(body.owner_agent || body.ownerAgent);
  const cadenceUnit = cleanText(body.cadence_unit || body.cadenceUnit) || "days";
  const cadenceInterval = Number(body.cadence_interval || body.cadenceInterval || 1);
  const timeOfDay = cleanText(body.time_of_day || body.timeOfDay) || "02:30";
  const startDate = cleanText(body.start_date || body.startDate) || new Date().toISOString().slice(0, 10);

  if (!title || !instruction || !ownerAgent) {
    return NextResponse.json({ error: "title, instruction and owner_agent are required" }, { status: 400 });
  }
  if (!["days", "weeks"].includes(cadenceUnit)) {
    return NextResponse.json({ error: "cadence_unit must be days or weeks" }, { status: 400 });
  }
  if (!Number.isFinite(cadenceInterval) || cadenceInterval <= 0) {
    return NextResponse.json({ error: "cadence_interval must be positive" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("recurring_work_rules")
    .insert({
      title,
      instruction,
      owner_agent: ownerAgent,
      target_agent_id: cleanText(body.target_agent_id || body.targetAgentId) || ownerAgent,
      requested_by: cleanText(body.requested_by || body.requestedBy) || "dashboard",
      priority: cleanText(body.priority) || "medium",
      cadence_unit: cadenceUnit,
      cadence_interval: cadenceInterval,
      time_of_day: timeOfDay,
      timezone: cleanText(body.timezone) || "Europe/London",
      start_date: startDate,
      horizon_days: Number(body.horizon_days || body.horizonDays || 28),
      enabled: body.enabled !== false,
      metadata: typeof body.metadata === "object" && body.metadata ? body.metadata : {},
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseAdmin.from("event_log").insert({
    domain: "work",
    event_type: "recurring_work.rule_created",
    entity_type: "recurring_work_rule",
    entity_id: data.id,
    actor: "dashboard",
    payload: { title, owner_agent: ownerAgent, cadence_unit: cadenceUnit, cadence_interval: cadenceInterval, time_of_day: timeOfDay },
  });

  return NextResponse.json(data);
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const id = cleanText(body.id);
  const enabled = body.enabled;

  if (!id || typeof enabled !== "boolean") {
    return NextResponse.json({ error: "id and enabled boolean are required" }, { status: 400 });
  }

  const { data: rule, error: ruleError } = await supabaseAdmin
    .from("recurring_work_rules")
    .select("id,title,enabled")
    .eq("id", id)
    .single();

  if (ruleError || !rule) return NextResponse.json({ error: ruleError?.message || "rule_not_found" }, { status: 404 });

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("recurring_work_rules")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  let removedFutureWorkItems = 0;
  let removedFutureOccurrences = 0;
  let skippedFutureOccurrences = 0;
  let materialized: Awaited<ReturnType<typeof materializeRecurringWork>> | null = null;

  if (!enabled) {
    const { data: futureOccurrences, error: occurrenceError } = await supabaseAdmin
      .from("recurring_work_occurrences")
      .select("id,work_item_id,scheduled_for,work_items(id,status,started_at,completed_at)")
      .eq("rule_id", id)
      .gte("scheduled_for", new Date().toISOString());

    if (occurrenceError) return NextResponse.json({ error: occurrenceError.message }, { status: 500 });

    const safeOccurrences = (futureOccurrences || []).filter((occurrence) => {
      const item = Array.isArray(occurrence.work_items) ? occurrence.work_items[0] : occurrence.work_items;
      return occurrence.work_item_id && item?.status === "ready" && !item.started_at && !item.completed_at;
    });
    skippedFutureOccurrences = (futureOccurrences || []).length - safeOccurrences.length;

    const occurrenceIds = safeOccurrences.map((occurrence) => occurrence.id).filter(Boolean);
    const workItemIds = safeOccurrences.map((occurrence) => occurrence.work_item_id).filter(Boolean);

    if (occurrenceIds.length) {
      const { error } = await supabaseAdmin.from("recurring_work_occurrences").delete().in("id", occurrenceIds);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      removedFutureOccurrences = occurrenceIds.length;
    }

    if (workItemIds.length) {
      const { error } = await supabaseAdmin.from("work_items").delete().in("id", workItemIds);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      removedFutureWorkItems = workItemIds.length;
    }
  } else {
    materialized = await materializeRecurringWork(supabaseAdmin, "dashboard");
  }

  await supabaseAdmin.from("event_log").insert({
    domain: "work",
    event_type: enabled ? "recurring_work.rule_resumed" : "recurring_work.rule_paused",
    entity_type: "recurring_work_rule",
    entity_id: id,
    actor: "dashboard",
    payload: {
      title: rule.title,
      previous_enabled: rule.enabled,
      enabled,
      removed_future_occurrences: removedFutureOccurrences,
      removed_future_work_items: removedFutureWorkItems,
      skipped_future_occurrences: skippedFutureOccurrences,
      materialized_created: materialized?.created,
      materialized_existing: materialized?.existing,
    },
  });

  return NextResponse.json({
    rule: updated,
    removed_future_occurrences: removedFutureOccurrences,
    removed_future_work_items: removedFutureWorkItems,
    skipped_future_occurrences: skippedFutureOccurrences,
    materialized,
  });
}
