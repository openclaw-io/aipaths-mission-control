import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function parseScheduledFor(value: unknown) {
  if (value === "now") return new Date().toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode === "run-now" ? "run-now" : "reschedule";
  const scheduledFor = parseScheduledFor(body?.scheduled_for || body?.scheduledFor);
  const reason = typeof body?.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : "manual_reschedule_from_work_items_dashboard";

  if (!scheduledFor) {
    return NextResponse.json({ error: "Invalid scheduled_for" }, { status: 400 });
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("work_items")
    .select("id,title,status,payload,owner_agent,target_agent_id,source_type,source_id,scheduled_for")
    .eq("id", id)
    .single();

  if (existingError || !existing) {
    return NextResponse.json({ error: existingError?.message || "Work item not found" }, { status: 404 });
  }

  if (!["ready", "draft", "blocked"].includes(existing.status)) {
    return NextResponse.json({ error: `Cannot reschedule status: ${existing.status}` }, { status: 400 });
  }

  if (mode === "run-now" && existing.status !== "ready") {
    return NextResponse.json({ error: `Cannot run now status: ${existing.status}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const payload = ((existing.payload || {}) as Record<string, unknown>) || {};
  const nextPayload = {
    ...payload,
    manual_rescheduled_at: now,
    manual_rescheduled_reason: reason,
    previous_scheduled_for: existing.scheduled_for,
  };

  const { data, error } = await supabaseAdmin
    .from("work_items")
    .update({
      scheduled_for: scheduledFor,
      updated_at: now,
      payload: nextPayload,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (existing.source_type === "pipeline_item" && existing.source_id) {
    await supabaseAdmin
      .from("pipeline_items")
      .update({ scheduled_for: scheduledFor, updated_at: now })
      .eq("id", existing.source_id);
  }

  await supabaseAdmin.from("event_log").insert({
    domain: "work",
    event_type: "work_item.rescheduled",
    entity_type: "work_item",
    entity_id: id,
    actor: "dashboard",
    payload: {
      reason,
      from_status: existing.status,
      title: existing.title,
      owner_agent: existing.owner_agent,
      target_agent_id: existing.target_agent_id,
      source_type: existing.source_type,
      source_id: existing.source_id,
      previous_scheduled_for: existing.scheduled_for,
      scheduled_for: scheduledFor,
      mode: mode === "run-now" ? "run_now" : "reschedule",
    },
  });

  return NextResponse.json(data);
}
