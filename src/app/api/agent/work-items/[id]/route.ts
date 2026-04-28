import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyPublishedContent } from "@/lib/content/live-verification";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";
import { resolvePublicationSlot } from "@/lib/publication/scheduling";
import {
  YOUTUBE_GATE_ORDER,
  YOUTUBE_GATE_STATUSES,
  buildGateHistoryEntry,
  derivePipelineItemStatus,
  getGateEntry,
  getScores,
  getYouTubeMetadata,
  type YouTubeGateKey,
  type YouTubeGateStatus,
} from "@/lib/youtube-pipeline";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function extractCurrentUrl(body: Record<string, unknown>) {
  if (typeof body.current_url === "string" && body.current_url.trim()) return body.current_url.trim();
  const outputUrl = getNestedString(body.output, ["current_url"]);
  if (outputUrl) return outputUrl;
  const resultUrl = typeof body.result === "string" ? body.result.match(/https?:\/\/\S+/)?.[0] : null;
  return resultUrl?.replace(/[),.;]+$/, "") || null;
}

function extractCommunityCopy(body: Record<string, unknown>) {
  const outputCopy =
    getNestedString(body.output, ["copy", "text"]) ||
    getNestedString(body.output, ["copy"]) ||
    getNestedString(body.output, ["text"]);
  if (outputCopy) return outputCopy;
  if (typeof body.result === "string" && body.result.trim()) {
    const result = body.result.trim();
    const labeledDraft = result.match(/(?:Draft community\/news post \(Spanish\)|Draft community\/news post|Draft news post|Borrador(?: listo)?(?: para aprobaci[oó]n)?(?:\s*[—:-]\s*noticia comunidad)?|Copy|Final copy|Texto final)\s*[:\n]+([\s\S]+)/i)?.[1]?.trim();
    const candidate = (labeledDraft || result)
      .replace(/\n+Recommendation:[\s\S]*$/i, "")
      .replace(/\n+Recomendaci[oó]n:[\s\S]*$/i, "")
      .trim();
    const genericCompletionOnly = /^(drafted|sent|validated|recommendation|publish after|copy listo|borrador listo|no publicado|hecho|listo)[\s\S]{0,220}$/i.test(candidate);
    return genericCompletionOnly ? null : candidate;
  }
  return null;
}


function extractHeroImage(body: Record<string, unknown>) {
  const outputHero = body.output && typeof body.output === "object" ? (body.output as Record<string, unknown>).hero_image || (body.output as Record<string, unknown>).cover_image || (body.output as Record<string, unknown>).thumbnail : null;
  if (outputHero && typeof outputHero === "object" && !Array.isArray(outputHero)) return outputHero as JsonRecord;

  const directHero = body.hero_image || body.cover_image || body.thumbnail;
  if (directHero && typeof directHero === "object" && !Array.isArray(directHero)) return directHero as JsonRecord;

  const imageUrl =
    getNestedString(body.output, ["hero_image", "url"]) ||
    getNestedString(body.output, ["cover_image", "url"]) ||
    getNestedString(body.output, ["thumbnail", "url"]) ||
    getNestedString(body.output, ["image", "url"]);
  if (imageUrl) return { url: imageUrl };

  return null;
}

function extractCommunityScheduledFor(body: Record<string, unknown>) {
  if (typeof body.scheduled_for === "string" && body.scheduled_for.trim()) return body.scheduled_for.trim();
  const outputScheduledFor = getNestedString(body.output, ["scheduled_for"]) || getNestedString(body.output, ["schedule", "scheduled_for"]);
  if (outputScheduledFor) return outputScheduledFor;
  if (typeof body.result === "string") {
    const match = body.result.match(/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})/);
    if (match) return match[0];
  }
  return null;
}

function isYouTubeGateKey(value: unknown): value is YouTubeGateKey {
  return typeof value === "string" && (YOUTUBE_GATE_ORDER as readonly string[]).includes(value);
}

function isYouTubeGateStatus(value: unknown): value is YouTubeGateStatus {
  return typeof value === "string" && (YOUTUBE_GATE_STATUSES as readonly string[]).includes(value);
}

function extractYouTubeGateStatus(body: Record<string, unknown>) {
  const explicit = body.gate_status || getNestedString(body.output, ["gate_status"]);
  return isYouTubeGateStatus(explicit) ? explicit : null;
}

function extractYouTubeEvidenceSummary(body: Record<string, unknown>) {
  return (
    getNestedString(body.output, ["evidence_summary"]) ||
    getNestedString(body.output, ["summary"]) ||
    getNestedString(body.output, ["recommendation"]) ||
    (typeof body.result === "string" && body.result.trim() ? body.result.trim().slice(0, 1800) : null)
  );
}

async function notifyWorkItem(workItemId: string, agent: string, title: string) {
  if (!process.env.AGENT_API_KEY) return;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
  await fetch(`${baseUrl}/api/work-items/notify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workItemId, agent, title, action: "created" }),
  }).catch(() => {});
}

function communityPublishTarget(metadata: JsonRecord) {
  const destinationKey = typeof metadata.intel_destination_key === "string" ? metadata.intel_destination_key : null;
  const destinationLabel = typeof metadata.destination_label === "string" ? metadata.destination_label.toLowerCase() : "";
  const kind = typeof metadata.kind === "string" ? metadata.kind : null;
  const source = (metadata.source || {}) as JsonRecord;
  const sourceType = typeof source.type === "string" ? source.type : null;

  if (destinationKey === "news" || destinationLabel === "news" || kind === "news" || metadata.intel) {
    return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia", label: "news/radar" };
  }
  if (destinationKey === "poll" || destinationLabel.includes("encuesta") || kind === "poll") {
    return { channelId: "1283759728798994533", channelName: "📔_encuestas", label: "poll" };
  }
  if (["blog", "guide", "doc", "video"].includes(String(sourceType || destinationKey || kind || ""))) {
    return { channelId: "1445797470662692864", channelName: "_📣anuncios", label: "content announcement" };
  }
  return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia", label: "default community update" };
}

async function ensureCommunityPublishWorkItem(db: ReturnType<typeof createServiceClient>, input: {
  pipelineItemId: string;
  title: string;
  scheduledFor: string;
  priority?: string | null;
  requestedBy?: string | null;
  metadata?: JsonRecord | null;
  copyText?: string | null;
}) {
  const openStatuses = ["draft", "ready", "blocked", "in_progress"];
  const { data: existingItems, error: existingError } = await db
    .from("work_items")
    .select("id, status, payload")
    .in("source_type", ["pipeline_item", "service"])
    .eq("source_id", input.pipelineItemId)
    .in("status", openStatuses)
    .order("created_at", { ascending: false });

  if (existingError) throw existingError;

  const existingPublish = (existingItems || []).find((item: { payload?: JsonRecord | null }) => {
    const payload = (item.payload || {}) as JsonRecord;
    return payload.action === "publish_community_post" || payload.relation_type === "publish";
  });

  const metadata = input.metadata || {};
  const target = communityPublishTarget(metadata);
  const instruction = [
    `Publish community post "${input.title}".`,
    `Pipeline item ID: ${input.pipelineItemId}.`,
    "",
    "Target channel contract:",
    `- Publish to <#${target.channelId}> (${target.channelName}) because this is a ${target.label}.`,
    "- Do not publish news/radar items in #anuncios. #anuncios is only for blogs, guides, videos, product/content announcements, or similar major content launches.",
    "- Polls/engagement questions go to #📔_encuestas when the post type is a poll.",
    "",
    "Message formatting contract:",
    "- Publish only the approved copy from the pipeline card, but wrap every raw URL as <https://...> so Discord suppresses link previews/embeds.",
    "- Do not add source-link previews or Discord embeds unless Gonza explicitly asks.",
    "",
    "After publishing:",
    "- Complete this work item with current_url/published_at if available.",
    "- Send the publication log/update to <#1473660854800224316>, not to the private director channel.",
    `- Suggested log format: Anuncio: ${input.title}\n\nLo publiqué en #${target.channelName} con el enfoque aprobado para comunidad.\n\nPost: [ver post](<POST_URL>)`,
    input.copyText ? "" : null,
    input.copyText ? "Approved copy:" : null,
    input.copyText || null,
  ].filter(Boolean).join("\n");

  if (existingPublish?.id) {
    const { data: updated, error } = await db
      .from("work_items")
      .update({
        title: `Publish community post: ${input.title}`,
        instruction,
        status: existingPublish.status === "in_progress" ? "in_progress" : "ready",
        priority: input.priority || "medium",
        owner_agent: "community",
        target_agent_id: "community",
        requested_by: input.requestedBy || "mission-control",
        scheduled_for: input.scheduledFor,
        payload: {
          ...((existingPublish.payload || {}) as JsonRecord),
          trigger: "community_schedule",
          pipeline_type: "community_post",
          pipeline_item_id: input.pipelineItemId,
          relation_type: "publish",
          action: "publish_community_post",
          schedule_kind: "publication",
          target_channel_id: target.channelId,
          target_channel_name: target.channelName,
          log_channel_id: "1473660854800224316",
          suppress_link_previews: true,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingPublish.id)
      .select("id")
      .single();
    if (error) throw error;
    return { id: updated.id as string, created: false };
  }

  const { data: inserted, error } = await db
    .from("work_items")
    .insert({
      kind: "task",
      source_type: "pipeline_item",
      source_id: input.pipelineItemId,
      title: `Publish community post: ${input.title}`,
      instruction,
      status: "ready",
      priority: input.priority || "medium",
      owner_agent: "community",
      target_agent_id: "community",
      requested_by: input.requestedBy || "mission-control",
      scheduled_for: input.scheduledFor,
      payload: {
        trigger: "community_schedule",
        pipeline_type: "community_post",
        pipeline_item_id: input.pipelineItemId,
        relation_type: "publish",
        action: "publish_community_post",
        schedule_kind: "publication",
        target_channel_id: target.channelId,
        target_channel_name: target.channelName,
        log_channel_id: "1473660854800224316",
        suppress_link_previews: true,
      },
    })
    .select("id")
    .single();

  if (error) throw error;

  const { error: mapError } = await db.from("pipeline_work_map").insert({
    pipeline_item_id: input.pipelineItemId,
    work_item_id: inserted.id,
    relation_type: "publish",
  });
  if (mapError && !String(mapError.message || "").includes("duplicate")) throw mapError;

  await db.from("pipeline_events").insert({
    pipeline_item_id: input.pipelineItemId,
    event_type: "pipeline_item.publish_work_scheduled",
    actor: "work-item-completion",
    payload: {
      work_item_id: inserted.id,
      relation_type: "publish",
      scheduled_for: input.scheduledFor,
      source: "work_items",
    },
  });

  return { id: inserted.id as string, created: true };
}

async function createCommunityAnnouncementForGuide(db: ReturnType<typeof createServiceClient>, input: {
  guide: JsonRecord;
  url: string;
  requestedBy: string | null;
}) {
  const { guide, url, requestedBy } = input;
  const guideTitle = typeof guide.title === "string" ? guide.title : "published guide";
  const guideSlug = typeof guide.slug === "string" ? guide.slug : null;
  const guidePriority = typeof guide.priority === "string" ? guide.priority : "medium";
  const guideRequestedBy = typeof guide.requested_by === "string" ? guide.requested_by : null;
  const guidePipelineType = typeof guide.pipeline_type === "string" ? guide.pipeline_type : "guide";

  const { data: existingCommunityItem } = await db
    .from("pipeline_items")
    .select("id, title, status")
    .eq("pipeline_type", "community_post")
    .eq("source_id", guide.id)
    .maybeSingle();

  const communityItem = existingCommunityItem || (await db
    .from("pipeline_items")
    .insert({
      pipeline_type: "community_post",
      title: `Announce guide: ${guideTitle}`,
      slug: guideSlug ? `announce-${guideSlug}` : null,
      status: "draft",
      priority: guidePriority,
      owner_agent: "community",
      requested_by: requestedBy || guideRequestedBy || "mission-control",
      source_type: "manual",
      source_id: guide.id,
      current_url: null,
      metadata: {
        kind: "guide_announcement",
        channel: "discord",
        target: { platform: "discord" },
        source: {
          type: guidePipelineType,
          pipeline_item_id: guide.id,
          url,
          title: guideTitle,
          slug: guideSlug,
        },
        copy: { text: "", poll_options: [] },
        automation: {
          trigger: "published_content_verified",
          created_at: new Date().toISOString(),
        },
      },
    })
    .select("id, title, status")
    .single()).data;

  if (!communityItem?.id) return null;

  const { workItem } = await createPipelineWorkItem(db, {
    pipelineItemId: communityItem.id,
    pipelineType: "community_post",
    title: `Draft Discord announcement: ${guide.title}`,
    instruction: [
      `Community post item: ${communityItem.title}`,
      "",
      "Task:",
      "- Draft a concise Discord announcement for this newly published guide.",
      "- Include the guide link and one clear reason the community should read it.",
      "- Keep it ready for Gonza review; do not publish directly.",
      "- When completing the work item, include the final announcement copy in the PATCH body as result or output.copy.text so Mission Control can save it for review.",
      "",
      `Guide: ${guideTitle}`,
      `URL: ${url}`,
    ].join("\n"),
    priority: guidePriority,
    ownerAgent: "community",
    requestedBy: requestedBy || guideRequestedBy || "mission-control",
    relationType: "distribute_community",
    action: "draft_guide_announcement",
    trigger: "published_content_verified",
  });

  if (workItem?.id) await notifyWorkItem(workItem.id, "community", guideTitle);

  return { communityItem, workItem };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { status, result, output, current_url, published_at, scheduled_for, payload_patch, payload_increment } = body;

  const validStatuses = ["draft", "ready", "blocked", "in_progress", "done", "failed", "canceled"];
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from("work_items")
    .select("*")
    .eq("id", id)
    .single();

  if (existingError || !existing) {
    return NextResponse.json({ error: existingError?.message || "Work item not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (status === "ready") {
    updates.started_at = null;
    updates.completed_at = null;
  }
  if (status === "in_progress") updates.started_at = new Date().toISOString();
  if (status === "done") updates.completed_at = new Date().toISOString();
  if (status === "failed") updates.completed_at = new Date().toISOString();
  if (typeof scheduled_for === "string" || scheduled_for === null) updates.scheduled_for = scheduled_for;
  if (result) updates.instruction = `${existing.instruction || ""}\n\nResult:\n${String(result)}`.trim();
  if (output) updates.payload = { ...(existing.payload || {}), output };
  if (payload_patch && typeof payload_patch === "object" && !Array.isArray(payload_patch)) {
    updates.payload = { ...(existing.payload || {}), ...((updates.payload as Record<string, unknown>) || {}), ...(payload_patch as Record<string, unknown>) };
  }
  if (payload_increment && typeof payload_increment === "object" && !Array.isArray(payload_increment)) {
    const basePayload = { ...(existing.payload || {}), ...((updates.payload as Record<string, unknown>) || {}) };
    for (const [key, rawDelta] of Object.entries(payload_increment as Record<string, unknown>)) {
      const delta = Number(rawDelta);
      if (!Number.isFinite(delta)) continue;
      basePayload[key] = Number(basePayload[key] || 0) + delta;
    }
    updates.payload = basePayload;
  }

  const { data, error } = await db
    .from("work_items")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload = (data.payload || {}) as Record<string, unknown>;
  const sourceBackedPipelineItemId = ["pipeline_item", "service"].includes(String(data.source_type || "")) && typeof data.source_id === "string"
    ? data.source_id
    : null;
  const inferredPipelineItemId = typeof payload.pipeline_item_id === "string" ? payload.pipeline_item_id : sourceBackedPipelineItemId;

  if (status === "done" && inferredPipelineItemId) {
    const pipelineItemId = inferredPipelineItemId;
    let pipelineType = String(payload.pipeline_type || "");
    let action = String(payload.action || "");

    if (!pipelineType || !action) {
      const { data: inferredPipelineItem } = await db
        .from("pipeline_items")
        .select("pipeline_type")
        .eq("id", pipelineItemId)
        .maybeSingle();
      pipelineType = pipelineType || String(inferredPipelineItem?.pipeline_type || "");

      const title = String(data.title || "").toLowerCase();
      const relationType = typeof payload.relation_type === "string" ? payload.relation_type : "";
      if (!action && pipelineType === "community_post") {
        if (relationType === "publish" || title.includes("publish")) action = "publish_community_post";
        else if (relationType === "schedule" || title.includes("schedule")) action = "schedule_community_post";
        else action = title.includes("revise") ? "revise_community_announcement" : "draft_guide_announcement";
      } else if (!action && (pipelineType === "blog" || pipelineType === "doc" || pipelineType === "guide")) {
        if (title.includes("publish")) action = pipelineType === "blog" ? "publish_blog" : "publish_guide";
        if (title.includes("localize")) action = pipelineType === "blog" ? "localize_blog_to_en" : "localize_guide_to_en";
      }
    }

    const isBlog = pipelineType === "blog";
    const isGuide = ["doc", "guide"].includes(pipelineType);
    const isCommunity = pipelineType === "community_post";
    const isLocalizeAction = action === "localize_blog_to_en" || action === "localize_guide_to_en";
    const isPublishAction = action === "publish_blog" || action === "publish_guide";
    const isCommunityDraftAction = action === "draft_guide_announcement" || action === "revise_community_announcement" || action === "draft_community_news" || action === "develop_community_post";
    const isCommunityScheduleAction = action === "schedule_community_post";
    const isCommunityPublishAction = action === "publish_community_post";
    const isVideo = pipelineType === "video";
    const isYouTubeGateAction = isVideo && action.startsWith("youtube_gate_");

    if (isYouTubeGateAction) {
      const relationType = typeof payload.relation_type === "string" ? payload.relation_type : action.replace("youtube_gate_", "");
      const gateKey = isYouTubeGateKey(relationType) ? relationType : null;
      const { data: videoItem } = await db
        .from("pipeline_items")
        .select("metadata,status,published_at")
        .eq("id", pipelineItemId)
        .eq("pipeline_type", "video")
        .maybeSingle();

      if (gateKey && videoItem) {
        const now = new Date().toISOString();
        const metadata = getYouTubeMetadata(videoItem.metadata);
        const previousGate = getGateEntry(metadata, gateKey);
        const scores = getScores(metadata);
        const evidenceSummary = extractYouTubeEvidenceSummary(body as Record<string, unknown>);
        const nextGateStatus = extractYouTubeGateStatus(body as Record<string, unknown>) || (previousGate.status === "not_started" || !previousGate.status ? "in_progress" : previousGate.status);
        const nextMetadata = {
          ...metadata,
          gates: {
            ...((metadata.gates || {}) as JsonRecord),
            [gateKey]: {
              ...previousGate,
              status: nextGateStatus,
              evidence_summary: evidenceSummary || previousGate.evidence_summary,
              work_item_id: data.id,
              updated_at: now,
              history: [
                ...((Array.isArray(previousGate.history) ? previousGate.history : []) || []),
                buildGateHistoryEntry({
                  at: now,
                  by: data.owner_agent || "youtube",
                  status: nextGateStatus,
                  reason: previousGate.reason || null,
                  evidenceSummary: evidenceSummary || previousGate.evidence_summary || null,
                  nextAction: previousGate.next_action || null,
                  scores,
                }),
              ],
            },
          },
          runtime_feedback: {
            ...((metadata.runtime_feedback || {}) as JsonRecord),
            last_status: "youtube_gate_work_completed",
            last_work_item_id: data.id,
            last_gate_key: gateKey,
            updated_at: now,
          },
        };

        await db
          .from("pipeline_items")
          .update({
            status: derivePipelineItemStatus(nextMetadata, { currentStatus: videoItem.status, publishedAt: videoItem.published_at }),
            metadata: nextMetadata,
            updated_at: now,
          })
          .eq("id", pipelineItemId);
      }
    }

    if (isCommunity && isCommunityPublishAction) {
      const publishUrl = extractCurrentUrl(body as Record<string, unknown>);
      const { data: communityItem } = await db
        .from("pipeline_items")
        .select("metadata")
        .eq("id", pipelineItemId)
        .eq("pipeline_type", "community_post")
        .maybeSingle();

      const communityMetadata = ((communityItem?.metadata || {}) as JsonRecord) || {};
      await db
        .from("pipeline_items")
        .update({
          status: "published",
          published_at: published_at || new Date().toISOString(),
          current_url: publishUrl || current_url || null,
          metadata: {
            ...communityMetadata,
            runtime_feedback: {
              ...((communityMetadata.runtime_feedback || {}) as JsonRecord),
              last_status: "published",
              last_work_item_id: data.id,
              updated_at: new Date().toISOString(),
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", pipelineItemId);
    }

    if (isCommunity && isCommunityDraftAction) {
      const copyText = extractCommunityCopy(body as Record<string, unknown>);
      const { data: communityItem } = await db
        .from("pipeline_items")
        .select("metadata")
        .eq("id", pipelineItemId)
        .eq("pipeline_type", "community_post")
        .maybeSingle();

      if (communityItem) {
        const communityMetadata = (communityItem.metadata || {}) as JsonRecord;
        const copyMetadata = (communityMetadata.copy || {}) as JsonRecord;
        const nextStatus = copyText ? "ready_for_review" : "draft";
        await db
          .from("pipeline_items")
          .update({
            status: nextStatus,
            metadata: {
              ...communityMetadata,
              copy: {
                ...copyMetadata,
                text: copyText || copyMetadata.text || "",
              },
              review: copyText
                ? communityMetadata.review
                : {
                    ...((communityMetadata.review || {}) as JsonRecord),
                    notes: "Community work item completed without announcement copy. Needs a clean re-draft before review.",
                    last_requested_at: new Date().toISOString(),
                    last_requested_by: "system",
                  },
              runtime_feedback: {
                ...((communityMetadata.runtime_feedback || {}) as JsonRecord),
                last_status: copyText ? "copy_saved" : "completed_without_copy",
                last_work_item_id: data.id,
                updated_at: new Date().toISOString(),
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", pipelineItemId);
      }
    }

    if (isCommunity && isCommunityScheduleAction) {
      const scheduledFor = extractCommunityScheduledFor(body as Record<string, unknown>);
      const { data: communityItem } = await db
        .from("pipeline_items")
        .select("metadata, title, priority, requested_by")
        .eq("id", pipelineItemId)
        .eq("pipeline_type", "community_post")
        .maybeSingle();

      if (communityItem) {
        const communityMetadata = (communityItem.metadata || {}) as JsonRecord;
        const copyMetadata = (communityMetadata.copy || {}) as JsonRecord;
        const finalScheduledFor = scheduledFor;
        const publishWork = finalScheduledFor
          ? await ensureCommunityPublishWorkItem(db, {
              pipelineItemId,
              title: String(communityItem.title || data.title || "Community post"),
              scheduledFor: finalScheduledFor,
              priority: typeof communityItem.priority === "string" ? communityItem.priority : data.priority,
              requestedBy: typeof communityItem.requested_by === "string" ? communityItem.requested_by : data.requested_by,
              metadata: communityMetadata,
              copyText: typeof copyMetadata.text === "string" ? copyMetadata.text : null,
            })
          : null;

        await db
          .from("pipeline_items")
          .update({
            status: finalScheduledFor ? "scheduled" : "approved",
            scheduled_for: null,
            metadata: {
              ...communityMetadata,
              schedule: {
                ...((communityMetadata.schedule || {}) as JsonRecord),
                scheduled_for: finalScheduledFor,
                scheduled_at: new Date().toISOString(),
                scheduled_by: data.owner_agent || "community",
                source: "work_items",
                publish_work_item_id: publishWork?.id || null,
              },
              runtime_feedback: {
                ...((communityMetadata.runtime_feedback || {}) as JsonRecord),
                last_status: finalScheduledFor ? "publish_work_item_scheduled" : "schedule_missing_date",
                last_work_item_id: data.id,
                publish_work_item_id: publishWork?.id || null,
                updated_at: new Date().toISOString(),
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", pipelineItemId);
      }
    }

    if ((isBlog || isGuide) && isLocalizeAction) {
      const label = isGuide ? "guide" : "blog";
      const publishAction = isGuide ? "publish_guide" : "publish_blog";
      const { data: pipelineItem } = await db
        .from("pipeline_items")
        .select("metadata, title, priority, scheduled_for, slug, requested_by")
        .eq("id", pipelineItemId)
        .single();

      const pipelineMetadata = (pipelineItem?.metadata || {}) as Record<string, unknown>;
      const localizationMetadata = (pipelineMetadata.localization || {}) as Record<string, unknown>;
      const heroImage = isBlog ? extractHeroImage(body as Record<string, unknown>) : null;
      const now = new Date().toISOString();
      const guideSchedule = isGuide
        ? await resolvePublicationSlot(db, {
            existingScheduledFor: pipelineItem?.scheduled_for || getNestedString(pipelineMetadata, ["schedule", "scheduled_for"]),
            pipelineItemId,
          })
        : null;
      const guideScheduledFor = guideSchedule?.scheduledFor || null;

      await db
        .from("pipeline_items")
        .update({
          status: isBlog ? "final_check" : "scheduled",
          ...(isGuide && guideScheduledFor ? { scheduled_for: guideScheduledFor } : {}),
          metadata: {
            ...pipelineMetadata,
            localization: {
              ...localizationMetadata,
              en_ready: true,
              translated_at: now,
            },
            ...(isGuide && guideScheduledFor
              ? {
                  schedule: {
                    ...(((pipelineMetadata.schedule || {}) as JsonRecord)),
                    scheduled_for: guideScheduledFor,
                    scheduled_at: now,
                    scheduled_by: data.owner_agent || "content",
                    source: guideSchedule?.source || "auto_allocated",
                  },
                }
              : {}),
            ...(isBlog
              ? {
                  final_check: {
                    ...(((pipelineMetadata.final_check || {}) as JsonRecord)),
                    status: "ready",
                    ready_at: now,
                    source_work_item_id: data.id,
                  },
                  ...(heroImage
                    ? {
                        hero_image: {
                          ...(((pipelineMetadata.hero_image || {}) as JsonRecord)),
                          ...heroImage,
                          status: (heroImage.status as string) || "generated",
                          updated_at: now,
                        },
                      }
                    : {}),
                }
              : {}),
          },
          updated_at: now,
        })
        .eq("id", pipelineItemId);

      if (!isBlog) {
        const { data: publishWorkItem } = await db
          .from("work_items")
          .insert({
            kind: "task",
            source_type: "service",
            source_id: pipelineItemId,
            title: `Publish ${label}: ${pipelineItem?.title || existing.title}`,
            instruction: [
              `Pipeline ${label} item: ${pipelineItem?.title || existing.title}`,
              "",
              "Task:",
              `- Publish the ${label} to the website`,
              "- When done, update the work item with current_url and optional notes",
              "- Mission Control will mark the pipeline item live and store published_at/current_url",
            ].join("\n"),
            // Publication work items are scheduled work. The scheduler should
            // dispatch them only after a publication date is set and due; do not
            // wake dev immediately from the localization completion hook.
            status: "ready",
            scheduled_for: guideScheduledFor,
            priority: pipelineItem?.priority || existing.priority || "medium",
            owner_agent: "dev",
            target_agent_id: "dev",
            requested_by: existing.requested_by,
            payload: {
              trigger: "work_item_completion",
              pipeline_type: pipelineType,
              pipeline_item_id: pipelineItemId,
              relation_type: "publish",
              action: publishAction,
              schedule_kind: "publication",
            },
          })
          .select("id")
          .single();

        if (publishWorkItem?.id) {
          const { error: mapError } = await db.from("pipeline_work_map").insert({
            pipeline_item_id: pipelineItemId,
            work_item_id: publishWorkItem.id,
            relation_type: "publish",
          });
          if (mapError && !String(mapError.message || "").includes("duplicate")) throw mapError;

          await db.from("event_log").insert({
            domain: "work",
            event_type: "work_item.publication_scheduled",
            entity_type: "work_item",
            entity_id: publishWorkItem.id,
            actor: "pipeline-publication",
            payload: {
              pipeline_type: pipelineType,
              pipeline_item_id: pipelineItemId,
              action: publishAction,
              scheduled_for: guideScheduledFor,
            },
          });
        }
      }
    }

    if ((isBlog || isGuide) && isPublishAction) {
      const publishUrl = extractCurrentUrl(body as Record<string, unknown>);
      const { data: pipelineItem, error: pipelineError } = await db
        .from("pipeline_items")
        .select("*")
        .eq("id", pipelineItemId)
        .single();

      if (!pipelineError && pipelineItem) {
        const pipelineMetadata = (pipelineItem.metadata || {}) as JsonRecord;
        const expectedDescription =
          getNestedString(pipelineMetadata, ["seo", "meta_description"]) ||
          getNestedString(pipelineMetadata, ["draft_summary"]) ||
          getNestedString(pipelineMetadata, ["summary"]);

        const verification = await verifyPublishedContent({
          type: isGuide ? "guide" : "blog",
          url: publishUrl || "",
          expectedTitle: pipelineItem.title,
          expectedSlug: pipelineItem.slug,
          expectedDescription,
        });

        const verificationMetadata = {
          ...(pipelineMetadata.publication_verification || {}),
          checked_at: new Date().toISOString(),
          work_item_id: data.id,
          url: publishUrl || null,
          result: verification,
        };

        if (verification.ok) {
          const liveUrl = verification.finalUrl || publishUrl;
          await db
            .from("pipeline_items")
            .update({
              status: "live",
              published_at: published_at || new Date().toISOString(),
              current_url: liveUrl,
              metadata: {
                ...pipelineMetadata,
                publication_verification: verificationMetadata,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", pipelineItemId);

          if (isGuide) {
            await createCommunityAnnouncementForGuide(db, {
              guide: { ...pipelineItem, current_url: liveUrl },
              url: liveUrl || publishUrl || "",
              requestedBy: existing.requested_by || data.requested_by || null,
            });
          }
        } else {
          await db
            .from("pipeline_items")
            .update({
              metadata: {
                ...pipelineMetadata,
                publication_verification: verificationMetadata,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", pipelineItemId);

          await db.from("event_log").insert({
            domain: "content",
            event_type: "published_content.verification_failed",
            entity_type: "pipeline_item",
            entity_id: pipelineItemId,
            actor: data.owner_agent || "dev",
            payload: {
              pipeline_type: pipelineType,
              action,
              work_item_id: data.id,
              verification,
            },
          });
        }
      }
    }
  }

  await db.from("event_log").insert({
    domain: "work",
    event_type: `work_item.${status || 'updated'}`,
    entity_type: "work_item",
    entity_id: data.id,
    actor: data.owner_agent || "unknown",
    payload: {
      status: data.status,
      requested_by: data.requested_by,
      source_type: data.source_type,
      source_id: data.source_id,
      pipeline_type: typeof payload.pipeline_type === "string" ? payload.pipeline_type : null,
      pipeline_item_id: typeof payload.pipeline_item_id === "string" ? payload.pipeline_item_id : null,
      action: typeof payload.action === "string" ? payload.action : null,
      current_url: current_url || null,
      scheduled_for: typeof scheduled_for === "string" || scheduled_for === null ? scheduled_for : undefined,
    },
  });

  return NextResponse.json(data);
}
