import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";

export const dynamic = "force-dynamic";

const COMMUNITY_STATUSES = [
  "ready_for_review",
  "changes_requested",
  "approved",
  "scheduled",
  "published",
  "live",
  "parked",
  "rejected",
  "archived",
] as const;

const ACTION_TARGET: Record<string, string> = {
  approve: "approved",
  request_changes: "changes_requested",
  reject: "rejected",
  park: "parked",
  mark_scheduled: "scheduled",
  mark_published: "published",
  archive: "archived",
};

const ALLOWED: Record<string, string[]> = {
  ready_for_review: ["approved", "changes_requested", "rejected", "parked"],
  changes_requested: ["ready_for_review", "rejected", "parked"],
  approved: ["scheduled", "published", "parked", "archived"],
  scheduled: ["published", "parked"],
  published: ["archived"],
  live: ["archived"],
  parked: ["ready_for_review", "rejected"],
};

async function notifyWorkItem(id: string, agent: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return;

  await fetch(`${baseUrl}/api/work-items/notify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workItemId: id, agent, action: "created" }),
  }).catch((err) => {
    console.error("[community.transition] Failed to notify work item", err);
  });
}

function getCommunityCopy(item: { metadata?: unknown }) {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const copy = (metadata.copy || {}) as Record<string, unknown>;
  return typeof copy.text === "string" ? copy.text.trim() : "";
}

function createRevisionInstruction(item: { title: string }, reviewNotes?: string) {
  return [
    `Community post item: ${item.title}`,
    "",
    "Task:",
    "- Revise the Discord/community announcement based on Gonza's review notes.",
    "- Save the revised copy back into the community post metadata/copy text if your tooling supports it.",
    "- When ready, move the item back to ready_for_review or complete this work item with the revised copy in the result.",
    "",
    "Review notes:",
    reviewNotes || "(missing)",
  ].join("\n");
}

function createScheduleInstruction(item: { id: string; title: string; metadata?: unknown }) {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const target = (metadata.target || {}) as Record<string, unknown>;
  const source = (metadata.source || {}) as Record<string, unknown>;
  const copy = getCommunityCopy(item);
  return [
    `Community post item: ${item.title}`,
    `Pipeline item ID: ${item.id}`,
    "",
    "Task:",
    "- Choose the publish date/time for this approved community post.",
    "- Do not publish now.",
    "- Complete this scheduling work item with scheduled_for as an ISO timestamp.",
    "- Mission Control will create/update the future publish work item in Work Queue from that scheduled_for value.",
    "",
    `Target: ${String(target.channel_name || target.channel_id || "Discord")}`,
    source.url ? `Source URL: ${String(source.url)}` : "Source URL: (none)",
    "",
    "Approved copy:",
    copy || "(missing)",
  ].join("\n");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const db = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { action, reviewNotes, current_url } = await request.json();
  const targetStatus = ACTION_TARGET[action];
  if (!targetStatus || !(COMMUNITY_STATUSES as readonly string[]).includes(targetStatus)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const { data: item, error: fetchError } = await db
    .from("pipeline_items")
    .select("*")
    .eq("id", id)
    .eq("pipeline_type", "community_post")
    .single();

  if (fetchError || !item) {
    return NextResponse.json({ error: fetchError?.message || "Community item not found" }, { status: 404 });
  }

  const allowedTargets = ALLOWED[item.status] || [];
  if (!allowedTargets.includes(targetStatus)) {
    return NextResponse.json({ error: `Action ${action} not allowed from ${item.status}` }, { status: 400 });
  }

  if (action === "request_changes" && (!reviewNotes || !String(reviewNotes).trim())) {
    return NextResponse.json({ error: "reviewNotes is required" }, { status: 400 });
  }

  if (action === "approve" && !getCommunityCopy(item)) {
    return NextResponse.json({ error: "Cannot approve a community post without copy text" }, { status: 400 });
  }

  const metadata = {
    ...(item.metadata || {}),
    review: {
      ...((item.metadata || {}).review || {}),
      ...(action === "request_changes"
        ? {
            notes: String(reviewNotes).trim(),
            last_requested_at: new Date().toISOString(),
            last_requested_by: user.email || user.id,
          }
        : {}),
      ...(action === "approve"
        ? {
            approved_at: new Date().toISOString(),
            approved_by: user.email || user.id,
          }
        : {}),
    },
  };

  let revisionWorkItemId: string | null = null;
  let scheduleWorkItemId: string | null = null;
  if (action === "request_changes") {
    try {
      const { workItem } = await createPipelineWorkItem(db, {
        pipelineItemId: item.id,
        pipelineType: "community_post",
        title: `Revise community announcement: ${item.title}`,
        instruction: createRevisionInstruction(item, String(reviewNotes).trim()),
        priority: item.priority || "medium",
        ownerAgent: "community",
        requestedBy: user.email || user.id,
        relationType: "distribute_community",
        action: "revise_community_announcement",
        trigger: "community_review_changes_requested",
        reviewNotes: String(reviewNotes).trim(),
      });
      revisionWorkItemId = workItem?.id || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[community.transition] Failed to create revision work item", err);
      return NextResponse.json({ error: `Failed to create revision work item: ${message}` }, { status: 500 });
    }
  }

  if (action === "approve") {
    try {
      const { workItem } = await createPipelineWorkItem(db, {
        pipelineItemId: item.id,
        pipelineType: "community_post",
        title: `Schedule community post: ${item.title}`,
        instruction: createScheduleInstruction(item),
        priority: item.priority || "medium",
        ownerAgent: "community",
        requestedBy: user.email || user.id,
        relationType: "schedule",
        action: "schedule_community_post",
        trigger: "community_review_approved",
      });
      scheduleWorkItemId = workItem?.id || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[community.transition] Failed to create schedule work item", err);
      return NextResponse.json({ error: `Failed to create schedule work item: ${message}` }, { status: 500 });
    }
  }

  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    metadata,
    updated_at: new Date().toISOString(),
  };

  if (current_url) updatePayload.current_url = current_url;
  if (action === "mark_published") updatePayload.published_at = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from("pipeline_items")
    .update(updatePayload)
    .eq("id", id)
    .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (revisionWorkItemId) void notifyWorkItem(revisionWorkItemId, "community");
  if (scheduleWorkItemId) void notifyWorkItem(scheduleWorkItemId, "community");

  await db.from("event_log").insert({
    domain: "community",
    event_type: `community_post.${action}`,
    entity_type: "pipeline_item",
    entity_id: id,
    actor: user.email || user.id,
    payload: {
      status: targetStatus,
      review_notes: action === "request_changes" ? String(reviewNotes).trim() : null,
      revision_work_item_id: revisionWorkItemId,
      schedule_work_item_id: scheduleWorkItemId,
    },
  });

  return NextResponse.json(updated);
}
