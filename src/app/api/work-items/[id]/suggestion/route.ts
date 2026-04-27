import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type SuggestionAction = "approve" | "dismiss";

function parseAction(value: unknown): SuggestionAction | null {
  return value === "approve" || value === "dismiss" ? value : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const action = parseAction(body?.action);
  const reason = typeof body?.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : action === "approve"
      ? "manual_suggestion_approval"
      : "manual_suggestion_dismissal";

  if (!action) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("work_items")
    .select("*")
    .eq("id", id)
    .single();

  if (existingError || !existing) {
    return NextResponse.json({ error: existingError?.message || "Work item not found" }, { status: 404 });
  }

  const payload = ((existing.payload || {}) as Record<string, unknown>) || {};
  if (payload.requires_human_approval !== true) {
    return NextResponse.json({ error: "Work item is not an approval suggestion" }, { status: 400 });
  }

  if (!["blocked", "draft"].includes(existing.status)) {
    return NextResponse.json({ error: `Cannot ${action} status: ${existing.status}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const nextPayload = {
    ...payload,
    requires_human_approval: false,
    suggestion_resolved_at: now,
    suggestion_resolution: action,
    suggestion_resolution_reason: reason,
    approved_by: action === "approve" ? "dashboard" : payload.approved_by,
    dismissed_by: action === "dismiss" ? "dashboard" : payload.dismissed_by,
  };

  const patch = action === "approve"
    ? {
        status: "ready",
        scheduled_for: existing.scheduled_for || now,
        updated_at: now,
        payload: nextPayload,
      }
    : {
        status: "canceled",
        completed_at: now,
        updated_at: now,
        payload: nextPayload,
      };

  const { data, error } = await supabaseAdmin
    .from("work_items")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseAdmin.from("event_log").insert({
    domain: "work",
    event_type: action === "approve" ? "work_item.suggestion_approved" : "work_item.suggestion_dismissed",
    entity_type: "work_item",
    entity_id: id,
    actor: "dashboard",
    payload: {
      reason,
      title: existing.title,
      owner_agent: existing.owner_agent,
      target_agent_id: existing.target_agent_id,
      source_type: existing.source_type,
      source_id: existing.source_id,
      proposed_action: payload.proposed_action,
      risk: payload.risk,
    },
  });

  return NextResponse.json(data);
}
