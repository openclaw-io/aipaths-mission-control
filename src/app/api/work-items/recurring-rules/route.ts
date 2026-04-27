import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

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
