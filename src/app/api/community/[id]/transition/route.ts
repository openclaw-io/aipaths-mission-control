import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { createPipelineWorkItemLocal, getPipelineItemLocal, updatePipelineItemLocal } from "@/lib/db/pipeline-local";
import { query } from "@/lib/db/postgres";
import { resolveCommunityPublicationSlotLocal } from "@/lib/publication/scheduling-local";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { resolveCommunityPublicationSlot, getCommunityPublicationSegment } from "@/lib/publication/scheduling";
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

function communityPublishTarget(metadata: Record<string, unknown>) {
  const target = (metadata.target || {}) as Record<string, unknown>;
  const segment = getCommunityPublicationSegment(metadata);
  if (typeof target.channel_id === "string" && typeof target.channel_name === "string") {
    return { channelId: target.channel_id, channelName: target.channel_name };
  }
  if (segment === "content_launch") return { channelId: "1445797470662692864", channelName: "_📣anuncios" };
  if (segment === "poll") return { channelId: "1283759728798994533", channelName: "📔_encuestas" };
  if (segment === "tool_of_day") return { channelId: "1284277202073948181", channelName: "🦿_ai_tools" };
  if (segment === "startup_of_day") return { channelId: "1445800588561486007", channelName: "📢_presenta_tu_proyecto" };
  return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia" };
}

function createPublishInstruction(item: { id: string; title: string; metadata?: unknown }, scheduledFor: string | null) {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const source = (metadata.source || {}) as Record<string, unknown>;
  const sourceUrl = [source.url, source.video_url, source.playlist_url]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const allowsYouTubePreview = source.type === "video" && !!sourceUrl && /(?:youtube\.com|youtu\.be)/i.test(sourceUrl);
  const target = communityPublishTarget(metadata);
  const copy = getCommunityCopy(item);
  const youtubeGuard = allowsYouTubePreview
    ? [
        "",
        "Live/public YouTube guard:",
        "- Before publishing, verify the YouTube URL is live and public.",
        "- Prefer YouTube Data API when available: privacyStatus must be public; block private, unlisted, scheduled, removed, or members-only states.",
        "- If public/live status cannot be confirmed, mark this work item blocked with evidence and do not publish.",
      ]
    : [];
  return [
    `Community post item: ${item.title}`,
    `Pipeline item ID: ${item.id}`,
    "",
    "Task:",
    scheduledFor
      ? `- Publish this approved community post at/after its scheduled Work Queue time: ${scheduledFor}.`
      : "- Publish this approved content-launch announcement now.",
    `- Publish to <#${target.channelId}> (${target.channelName}).`,
    "- Use only the approved copy below; do not rewrite it unless required for formatting.",
    allowsYouTubePreview
      ? "- Keep the YouTube video URL raw/unwrapped (with playlist list= when available) so Discord shows the native preview."
      : "- Wrap raw URLs as <https://...> to suppress Discord embeds/previews.",
    "- Complete this work item with current_url/published_at after publishing.",
    "",
    source.url ? `Source URL: ${String(source.url)}` : "Source URL: (none)",
    ...youtubeGuard,
    "",
    "Approved copy:",
    copy || "(missing)",
  ].join("\n");
}

function hasPublicationRecord(item: { status?: string | null; published_at?: string | null; current_url?: string | null }) {
  return item.status === "published" || item.status === "live" || !!item.published_at || !!item.current_url;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const useLocalMode = isLocalAuthDisabled();
  const supabase = useLocalMode ? null : await createClient();
  const db = useLocalMode ? null : createServiceClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;

  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await supabase!.auth.getUser();
    user = authResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const actorIdentity = String(user.email || user.id || "local@mission-control");

  const { action, reviewNotes, current_url } = await request.json();
  const targetStatus = ACTION_TARGET[action];
  if (!targetStatus || !(COMMUNITY_STATUSES as readonly string[]).includes(targetStatus)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const item = useLocalMode
    ? await getPipelineItemLocal(id, "community_post")
    : await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .select("*")
          .eq("id", id)
          .eq("pipeline_type", "community_post")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!item) {
    return NextResponse.json({ error: "Community item not found" }, { status: 404 });
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

  if (action === "approve" && hasPublicationRecord(item)) {
    return NextResponse.json({ error: "Community post already has a publication record" }, { status: 409 });
  }

  const metadata = {
    ...(item.metadata || {}),
    review: {
      ...((item.metadata || {}).review || {}),
      ...(action === "request_changes"
        ? {
            notes: String(reviewNotes).trim(),
            last_requested_at: new Date().toISOString(),
            last_requested_by: actorIdentity,
          }
        : {}),
      ...(action === "approve"
        ? {
            approved_at: new Date().toISOString(),
            approved_by: actorIdentity,
          }
        : {}),
    },
  };

  let revisionWorkItemId: string | null = null;
  let publishWorkItemId: string | null = null;
  let approvedScheduledFor: string | null = null;
  let approvedScheduleSource: string | null = null;

  if (action === "request_changes") {
    try {
      const workInput = {
        pipelineItemId: item.id,
        pipelineType: "community_post",
        title: `Revise community announcement: ${item.title}`,
        instruction: createRevisionInstruction(item, String(reviewNotes).trim()),
        priority: item.priority || "medium",
        ownerAgent: "community",
        requestedBy: actorIdentity,
        relationType: "distribute_community",
        action: "revise_community_announcement",
        trigger: "community_review_changes_requested",
        reviewNotes: String(reviewNotes).trim(),
      };
      const { workItem } = useLocalMode
        ? await createPipelineWorkItemLocal(workInput)
        : await createPipelineWorkItem(db!, workInput);
      revisionWorkItemId = workItem?.id || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[community.transition] Failed to create revision work item", err);
      return NextResponse.json({ error: `Failed to create revision work item: ${message}` }, { status: 500 });
    }
  }

  if (action === "approve") {
    try {
      const metadataForSchedule = (item.metadata || {}) as Record<string, unknown>;
      const scheduleMetadata = (metadataForSchedule.schedule || {}) as Record<string, unknown>;
      const explicitLaunchSchedule = [scheduleMetadata.target_publish_at, scheduleMetadata.scheduled_for]
        .find((value) => typeof value === "string" && value.trim()) as string | undefined;
      const slot = useLocalMode
        ? await resolveCommunityPublicationSlotLocal({
            metadata: metadataForSchedule,
            explicitScheduledFor: explicitLaunchSchedule,
            pipelineItemId: item.id,
          })
        : await resolveCommunityPublicationSlot(db!, {
            metadata: metadataForSchedule,
            explicitScheduledFor: explicitLaunchSchedule,
            pipelineItemId: item.id,
          });
      approvedScheduledFor = slot?.scheduledFor || null;
      approvedScheduleSource = slot?.source || (slot === null ? "immediate_content_launch" : null);
      const target = communityPublishTarget(metadataForSchedule);
      const source = (metadataForSchedule.source || {}) as Record<string, unknown>;
      const sourceUrl = [source.url, source.video_url, source.playlist_url]
        .find((value) => typeof value === "string" && value.trim()) as string | undefined;
      const allowsYouTubePreview = source.type === "video" && !!sourceUrl && /(?:youtube\.com|youtu\.be)/i.test(sourceUrl);
      const workInput = {
        pipelineItemId: item.id,
        pipelineType: "community_post",
        title: `Publish community post: ${item.title}`,
        instruction: createPublishInstruction(item, approvedScheduledFor),
        priority: item.priority || "medium",
        ownerAgent: "community",
        requestedBy: actorIdentity,
        relationType: "publish",
        action: "publish_community_post",
        trigger: approvedScheduledFor ? "community_review_approved_scheduled" : "community_review_approved_immediate",
        scheduledFor: approvedScheduledFor,
        payloadExtra: {
          schedule_kind: "publication",
          community_segment: getCommunityPublicationSegment(metadataForSchedule),
          target_channel_id: target.channelId,
          target_channel_name: target.channelName,
          log_channel_id: "1473660854800224316",
          suppress_link_previews: !allowsYouTubePreview,
        },
      };
      const { workItem } = useLocalMode
        ? await createPipelineWorkItemLocal(workInput)
        : await createPipelineWorkItem(db!, workInput);
      publishWorkItemId = workItem?.id || null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[community.transition] Failed to create publish work item", err);
      return NextResponse.json({ error: `Failed to create publish work item: ${message}` }, { status: 500 });
    }
  }

  const nextStatus = action === "approve" && publishWorkItemId ? "scheduled" : targetStatus;
  const updatePayload: Record<string, unknown> = {
    status: nextStatus,
    metadata: action === "approve"
      ? {
          ...metadata,
          schedule: {
            ...((metadata.schedule || {}) as Record<string, unknown>),
            source: approvedScheduleSource,
            scheduled_at: new Date().toISOString(),
            scheduled_by: actorIdentity,
            scheduled_for: approvedScheduledFor,
            publish_work_item_id: publishWorkItemId,
          },
        }
      : metadata,
    updated_at: new Date().toISOString(),
  };

  if (current_url) updatePayload.current_url = current_url;
  if (action === "mark_published") updatePayload.published_at = new Date().toISOString();

  const updated = useLocalMode
    ? await updatePipelineItemLocal(id, updatePayload)
    : await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .update(updatePayload)
          .eq("id", id)
          .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!updated) {
    return NextResponse.json({ error: "Failed to update community item" }, { status: 500 });
  }

  if (revisionWorkItemId) void notifyWorkItem(revisionWorkItemId, "community");
  if (publishWorkItemId && !approvedScheduledFor) void notifyWorkItem(publishWorkItemId, "community");

  if (useLocalMode) {
    await query(
      `insert into event_log (domain, event_type, entity_type, entity_id, actor, payload)
       values ('community', $1, 'pipeline_item', $2, $3, $4::jsonb)`,
      [
        `community_post.${action}`,
        id,
        actorIdentity,
        JSON.stringify({
          status: nextStatus,
          review_notes: action === "request_changes" ? String(reviewNotes).trim() : null,
          revision_work_item_id: revisionWorkItemId,
          publish_work_item_id: publishWorkItemId,
          scheduled_for: approvedScheduledFor,
          schedule_source: approvedScheduleSource,
        }),
      ],
    );
  } else {
    await db!.from("event_log").insert({
      domain: "community",
      event_type: `community_post.${action}`,
      entity_type: "pipeline_item",
      entity_id: id,
      actor: actorIdentity,
      payload: {
        status: nextStatus,
        review_notes: action === "request_changes" ? String(reviewNotes).trim() : null,
        revision_work_item_id: revisionWorkItemId,
        publish_work_item_id: publishWorkItemId,
        scheduled_for: approvedScheduledFor,
        schedule_source: approvedScheduleSource,
      },
    });
  }

  return NextResponse.json(updated);
}
