import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";

export const dynamic = "force-dynamic";

const GUIDE_STATUSES = [
  "draft",
  "parked",
  "rejected",
  "researching",
  "ready_for_review",
  "changes_requested",
  "approved",
  "localizing",
  "scheduled",
  "live",
  "archived",
] as const;

const ACTION_TARGET: Record<string, string> = {
  promote: "researching",
  park: "parked",
  unpark: "draft",
  reject: "rejected",
  approve: "localizing",
  request_changes: "changes_requested",
  move_to_review: "ready_for_review",
  mark_scheduled: "scheduled",
  mark_live: "live",
  archive: "archived",
};

const ALLOWED: Record<string, string[]> = {
  draft: ["parked", "rejected", "researching"],
  parked: ["draft", "rejected", "researching"],
  researching: ["ready_for_review", "parked", "rejected"],
  ready_for_review: ["changes_requested", "localizing", "rejected"],
  changes_requested: ["ready_for_review", "rejected"],
  localizing: ["scheduled", "ready_for_review"],
  scheduled: ["live"],
  live: ["archived"],
};

function createWorkItemTitle(action: string, title: string) {
  switch (action) {
    case "promote":
      return `Develop guide draft: ${title}`;
    case "request_changes":
      return `Revise guide draft: ${title}`;
    case "approve":
      return `Localize guide to EN: ${title}`;
    default:
      return `Work on guide: ${title}`;
  }
}

function createWorkItemInstruction(action: string, item: { title: string }, reviewNotes?: string) {
  switch (action) {
    case "promote":
      return [
        `Pipeline guide item: ${item.title}`,
        "",
        "Task:",
        "- Review the source material and cited sources",
        "- Research the story further and improve the framing",
        "- Produce a real guide draft suitable for editorial review",
        "- When ready, move the pipeline item to ready_for_review",
      ].join("\n");
    case "request_changes":
      return [
        `Pipeline guide item: ${item.title}`,
        "",
        "Task:",
        "- Revise the guide draft based on editorial feedback",
        "- When ready, move the pipeline item back to ready_for_review",
        "",
        "Review notes:",
        reviewNotes || "(missing)",
      ].join("\n");
    case "approve":
      return [
        `Pipeline guide item: ${item.title}`,
        "",
        "Task:",
        "- Create the English translation/localized version of the approved guide",
        "- Preserve meaning and quality, not just literal translation",
        "- When localization is complete, move the pipeline item to scheduled",
      ].join("\n");
    default:
      return `Work on guide item: ${item.title}`;
  }
}

async function notifyWorkItem(id: string, agent: string, title: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return;

  await fetch(`${baseUrl}/api/work-items/notify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workItemId: id, agent, title, action: "created" }),
  }).catch((err) => {
    console.error("[guides.transition] Failed to notify work item", err);
  });
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
  if (!targetStatus || !(GUIDE_STATUSES as readonly string[]).includes(targetStatus)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const { data: item, error: fetchError } = await db
    .from("pipeline_items")
    .select("*")
    .eq("id", id)
    .in("pipeline_type", ["doc", "guide"])
    .single();

  if (fetchError || !item) {
    return NextResponse.json({ error: fetchError?.message || "Guide item not found" }, { status: 404 });
  }

  const allowedTargets = ALLOWED[item.status] || [];
  if (!allowedTargets.includes(targetStatus)) {
    return NextResponse.json({ error: `Action ${action} not allowed from ${item.status}` }, { status: 400 });
  }

  if (action === "request_changes" && (!reviewNotes || !String(reviewNotes).trim())) {
    return NextResponse.json({ error: "reviewNotes is required" }, { status: 400 });
  }

  const metadata = {
    ...(item.metadata || {}),
    ...(action === "request_changes"
      ? {
          review: {
            notes: String(reviewNotes).trim(),
            last_requested_at: new Date().toISOString(),
            last_requested_by: user.email || user.id,
          },
        }
      : {}),
  };

  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    owner_agent: action === "approve" ? "content" : item.owner_agent || "content",
    metadata,
    updated_at: new Date().toISOString(),
  };

  if (action === "mark_live") {
    updatePayload.published_at = new Date().toISOString();
    updatePayload.current_url = current_url || null;
  }

  const { data: updated, error: updateError } = await db
    .from("pipeline_items")
    .update(updatePayload)
    .eq("id", id)
    .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, published_at, current_url, metadata, created_at, updated_at")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (["promote", "request_changes", "approve"].includes(action)) {
    const owner_agent = "content";
    const relationType = action === "approve" ? "followup" : action === "promote" ? "investigate" : "followup";
    const actionName = action === "approve" ? "localize_guide_to_en" : action === "promote" ? "develop_guide_draft" : "revise_guide_draft";

    const { workItem } = await createPipelineWorkItem(db, {
      pipelineItemId: item.id,
      pipelineType: item.pipeline_type || "doc",
      title: createWorkItemTitle(action, item.title),
      instruction: createWorkItemInstruction(action, item, reviewNotes),
      priority: item.priority || "medium",
      ownerAgent: owner_agent,
      requestedBy: user.email || user.id,
      relationType,
      action: actionName,
      trigger: "manual_transition",
      reviewNotes: action === "request_changes" ? String(reviewNotes).trim() : undefined,
    });

    if (workItem?.id) {
      void notifyWorkItem(workItem.id, owner_agent, item.title);
    }
  }

  return NextResponse.json(updated);
}
