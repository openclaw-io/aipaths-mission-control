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
  const restoredPayload = { ...payload };
  for (const key of [
    "dead_lettered_at",
    "dead_letter_reason",
    "wake_failure_limit",
    "stale_claim_requeue_count",
    "stale_claim_failed_at",
    "stale_claim_last_requeued_at",
    "stale_claim_max_requeues",
    "stale_claim_policy",
    "unclaimed_notify_requeue_count",
    "unclaimed_notify_failed_at",
    "unclaimed_notify_last_requeued_at",
    "unclaimed_notify_limit",
    "dispatch_session_id",
    "dispatch_session_key",
    "dispatch_session_started_at",
    "dispatch_wake_mode",
    "dispatch_cron_job_id",
    "dispatch_cron_run_id",
    "dispatch_escalation",
    "requires_system_attention",
    "operator_alert",
    "stale_claim_deferred_count",
    "stale_claim_last_deferred_at",
    "stale_claim_session_observation",
  ]) {
    delete restoredPayload[key];
  }

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
