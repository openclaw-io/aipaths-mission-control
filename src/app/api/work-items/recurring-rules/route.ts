import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRow, normalizeRows } from "@/lib/db/mission-control";
import { query, withTransaction } from "@/lib/db/postgres";
import { materializeRecurringWork, materializeRecurringWorkLocal } from "@/lib/work-items/recurring";

export const dynamic = "force-dynamic";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  if (isLocalAuthDisabled()) {
    const { rows } = await query(`
      select r.*,
             coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'id', o.id,
                   'scheduled_for', o.scheduled_for,
                   'work_item_id', o.work_item_id,
                   'status', o.status
                 ) order by o.scheduled_for
               ) filter (where o.id is not null),
               '[]'::jsonb
             ) as recurring_work_occurrences
        from public.recurring_work_rules r
        left join public.recurring_work_occurrences o on o.rule_id = r.id
       group by r.id
       order by r.created_at desc
    `);
    return NextResponse.json({ rules: normalizeRows(rows) });
  }

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

  if (isLocalAuthDisabled()) {
    const data = await withTransaction(async (client) => {
      const inserted = await client.query(
        `insert into public.recurring_work_rules (
           title, instruction, owner_agent, target_agent_id, requested_by, priority,
           cadence_unit, cadence_interval, time_of_day, timezone, start_date,
           horizon_days, enabled, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14::jsonb)
         returning *`,
        [
          title,
          instruction,
          ownerAgent,
          cleanText(body.target_agent_id || body.targetAgentId) || ownerAgent,
          cleanText(body.requested_by || body.requestedBy) || "dashboard",
          cleanText(body.priority) || "medium",
          cadenceUnit,
          cadenceInterval,
          timeOfDay,
          cleanText(body.timezone) || "Europe/London",
          startDate,
          Number(body.horizon_days || body.horizonDays || 28),
          body.enabled !== false,
          JSON.stringify(typeof body.metadata === "object" && body.metadata ? body.metadata : {}),
        ],
      );
      const row = inserted.rows[0];
      await client.query(
        `insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
         values ('work', 'recurring_work.rule_created', 'recurring_work_rule', $1, 'dashboard', $2::jsonb)`,
        [row.id, JSON.stringify({ title, owner_agent: ownerAgent, cadence_unit: cadenceUnit, cadence_interval: cadenceInterval, time_of_day: timeOfDay })],
      );
      return normalizeRow(row);
    });
    return NextResponse.json(data);
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

  if (isLocalAuthDisabled()) {
    const transition = await withTransaction(async (client) => {
      const ruleResult = await client.query(
        `select id, title, enabled from public.recurring_work_rules where id = $1 for update`,
        [id],
      );
      const rule = ruleResult.rows[0];
      if (!rule) return null;

      const updatedResult = await client.query(
        `update public.recurring_work_rules
            set enabled = $1, updated_at = now()
          where id = $2
          returning *`,
        [enabled, id],
      );

      let removedFutureWorkItems = 0;
      let removedFutureOccurrences = 0;
      let skippedFutureOccurrences = 0;
      if (!enabled) {
        const allFuture = await client.query<{ count: string }>(
          `select count(*)::text as count
             from public.recurring_work_occurrences
            where rule_id = $1 and scheduled_for >= now()`,
          [id],
        );
        const safeFuture = await client.query<{ id: string; work_item_id: string }>(
          `select o.id, o.work_item_id
             from public.recurring_work_occurrences o
             join public.work_items w on w.id = o.work_item_id
            where o.rule_id = $1
              and o.scheduled_for >= now()
              and w.status = 'ready'
              and w.started_at is null
              and w.completed_at is null
            for update of o, w`,
          [id],
        );
        const occurrenceIds = safeFuture.rows.map((row) => row.id);
        const workItemIds = safeFuture.rows.map((row) => row.work_item_id);
        skippedFutureOccurrences = Number(allFuture.rows[0]?.count || 0) - occurrenceIds.length;

        if (occurrenceIds.length) {
          const deleted = await client.query(
            `delete from public.recurring_work_occurrences where id = any($1::uuid[]) returning id`,
            [occurrenceIds],
          );
          removedFutureOccurrences = deleted.rowCount || 0;
        }
        if (workItemIds.length) {
          const deleted = await client.query(
            `delete from public.work_items
              where id = any($1::uuid[])
                and status = 'ready'
                and started_at is null
                and completed_at is null
              returning id`,
            [workItemIds],
          );
          removedFutureWorkItems = deleted.rowCount || 0;
        }

        await client.query(
          `insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
           values ('work', 'recurring_work.rule_paused', 'recurring_work_rule', $1, 'dashboard', $2::jsonb)`,
          [id, JSON.stringify({
            title: rule.title,
            previous_enabled: rule.enabled,
            enabled,
            removed_future_occurrences: removedFutureOccurrences,
            removed_future_work_items: removedFutureWorkItems,
            skipped_future_occurrences: skippedFutureOccurrences,
          })],
        );
      }

      return {
        rule: normalizeRow(updatedResult.rows[0]),
        title: String(rule.title || ""),
        previousEnabled: Boolean(rule.enabled),
        removedFutureOccurrences,
        removedFutureWorkItems,
        skippedFutureOccurrences,
      };
    });

    if (!transition) return NextResponse.json({ error: "rule_not_found" }, { status: 404 });

    const materialized = enabled ? await materializeRecurringWorkLocal("dashboard") : null;
    if (enabled) {
      await query(
        `insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
         values ('work', 'recurring_work.rule_resumed', 'recurring_work_rule', $1, 'dashboard', $2::jsonb)`,
        [id, JSON.stringify({
          title: transition.title,
          previous_enabled: transition.previousEnabled,
          enabled,
          removed_future_occurrences: 0,
          removed_future_work_items: 0,
          skipped_future_occurrences: 0,
          materialized_created: materialized?.created,
          materialized_existing: materialized?.existing,
        })],
      );
    }

    return NextResponse.json({
      rule: transition.rule,
      removed_future_occurrences: transition.removedFutureOccurrences,
      removed_future_work_items: transition.removedFutureWorkItems,
      skipped_future_occurrences: transition.skippedFutureOccurrences,
      materialized,
    });
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
