import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : "manual_requeue_from_work_items_dashboard";

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("work_items")
    .select("id,title,status,payload,owner_agent,target_agent_id,source_type,source_id")
    .eq("id", id)
    .single();

  if (existingError || !existing) {
    return NextResponse.json({ error: existingError?.message || "Work item not found" }, { status: 404 });
  }

  if (!["failed", "blocked", "in_progress"].includes(existing.status)) {
    return NextResponse.json({ error: `Cannot requeue status: ${existing.status}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const payload = ((existing.payload || {}) as Record<string, unknown>) || {};
  const manualRequeueCount = Number(payload.manual_requeue_count || 0) + 1;
  const {
    dead_lettered_at: _deadLetteredAt,
    dead_letter_reason: _deadLetterReason,
    wake_failure_limit: _wakeFailureLimit,
    ...restoredPayload
  } = payload;

  const { data, error } = await supabaseAdmin
    .from("work_items")
    .update({
      status: "ready",
      started_at: null,
      completed_at: null,
      updated_at: now,
      payload: {
        ...restoredPayload,
        dispatch_state: "ready_after_manual_requeue",
        dispatch_failure_reason: reason,
        wake_failure_count: 0,
        dispatch_retry_scheduled_for: null,
        manual_requeue_count: manualRequeueCount,
        manual_requeued_at: now,
      },
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseAdmin.from("event_log").insert({
    domain: "work",
    event_type: "work_item.requeued_manual",
    entity_type: "work_item",
    entity_id: id,
    actor: "dashboard",
    payload: {
      reason,
      from_status: existing.status,
      to_status: "ready",
      title: existing.title,
      owner_agent: existing.owner_agent,
      target_agent_id: existing.target_agent_id,
      source_type: existing.source_type,
      source_id: existing.source_id,
      manual_requeue_count: manualRequeueCount,
    },
  });

  return NextResponse.json(data);
}
