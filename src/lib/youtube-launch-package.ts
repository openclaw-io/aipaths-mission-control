import type { SupabaseClient } from "@supabase/supabase-js";

export type JsonRecord = Record<string, unknown>;

export type YouTubeLaunchPackageInput = {
  youtubeUrl?: string | null;
  videoId?: string | null;
  publishAt: string;
  title?: string | null;
  playlistContextUrl?: string | null;
  playlistId?: string | null;
  cta?: string | null;
  targetEmailSendAt?: string | null;
  emailTrackingRef?: string | null;
  optionalDiagnosticCta?: string | null;
  preparedAt?: string | null;
  refs?: unknown;
  requestedBy: string;
};

type PipelineItemRow = {
  id: string;
  title: string;
  pipeline_type: string;
  status: string;
  priority?: string | null;
  owner_agent?: string | null;
  requested_by?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  scheduled_for?: string | null;
  published_at?: string | null;
  current_url?: string | null;
  content_path?: string | null;
  content_format?: string | null;
  metadata?: JsonRecord | null;
  created_at?: string;
  updated_at?: string;
};

type WorkItemRow = {
  id: string;
  status: string;
  payload?: JsonRecord | null;
};

type LaunchWorkSpec = {
  relationType: string;
  mapRelationType: string;
  mapPipelineItemId: string;
  sourcePipelineItemId: string;
  pipelineType: string;
  title: string;
  instruction: string;
  ownerAgent: string;
  action: string;
  scheduledFor: string;
  priority?: string | null;
  payloadExtra?: JsonRecord;
};

export type ScheduledYouTubeLaunchWorkSpec = LaunchWorkSpec;

export type ScheduledYouTubeLaunchSpecContext = {
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl?: string | null;
  targetCommunityPublishAt: string;
  targetEmailSendAt: string;
  emailTrackingRef: string;
  optionalDiagnosticCta?: string | null;
  cta?: string | null;
  preparedAt?: string | null;
  videoPipelineItemId?: string | null;
  communityPipelineItemId?: string | null;
  marketingPipelineItemId?: string | null;
  pinnedCommentPipelineItemId?: string | null;
};

export type CommunityLaunchDraftValidationInput = {
  finalCopy?: string | null;
  status?: string | null;
  playlistContextUrl?: string | null;
  watchUrl?: string | null;
  suppressLinkPreviews?: boolean | null;
};

const TERMINAL_WORK_STATUSES = new Set(["done", "failed", "canceled", "cancelled"]);

function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeIsoDate(value: string, fieldName: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${fieldName}`);
  return date.toISOString();
}

function addMilliseconds(isoDate: string, milliseconds: number) {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}

function addMinutes(isoDate: string, minutes: number) {
  return addMilliseconds(isoDate, minutes * 60 * 1000);
}

function maxIsoDate(a: string, b: string) {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function addDays(isoDate: string, days: number) {
  return addMilliseconds(isoDate, days * 24 * 60 * 60 * 1000);
}

function firstStringFromRecords(records: JsonRecord[], paths: string[][]) {
  for (const record of records) {
    for (const path of paths) {
      let current: unknown = record;
      for (const key of path) {
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          current = null;
          break;
        }
        current = (current as JsonRecord)[key];
      }
      const value = trimToNull(current);
      if (value) return value;
    }
  }
  return null;
}

export function extractYouTubeVideoId(value: string | null | undefined) {
  const raw = trimToNull(value);
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (host.endsWith("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) return watchId;
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) return parts[1];
    }
  } catch {
    return null;
  }

  return null;
}

export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function youtubePlaylistContextUrl(videoId: string, playlistId: string | null) {
  return playlistId ? `${youtubeWatchUrl(videoId)}&list=${playlistId}` : null;
}

export function validateCommunityLaunchDraftOutput(input: CommunityLaunchDraftValidationInput) {
  const finalCopy = trimToNull(input.finalCopy) || "";
  const playlistContextUrl = trimToNull(input.playlistContextUrl);
  const watchUrl = trimToNull(input.watchUrl);
  const status = trimToNull(input.status);
  const errors: string[] = [];

  if (status !== "ready_for_review") {
    errors.push("Community launch draft must finish with ready_for_review status.");
  }
  if (!finalCopy) {
    errors.push("Community launch draft must include final copy text.");
  }
  if (input.suppressLinkPreviews !== false) {
    errors.push("Video announcements must set suppress_link_previews=false so Discord can render the YouTube preview.");
  }
  if (playlistContextUrl) {
    if (!finalCopy.includes(playlistContextUrl)) {
      errors.push("Community final copy must include playlist_context_url when present.");
    }
    const trailingUrl = finalCopy.match(/https:\/\/www\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}(?:\s*)$/)?.[0]?.trim();
    if (watchUrl && trailingUrl === watchUrl) {
      errors.push("Community final copy must not end with the bare watch URL when playlist_context_url exists.");
    }
  } else if (watchUrl && !finalCopy.includes(watchUrl)) {
    errors.push("Community final copy must include the raw YouTube watch URL when no playlist_context_url exists.");
  }
  for (const url of [playlistContextUrl, watchUrl].filter(Boolean) as string[]) {
    if (finalCopy.includes(`<${url}>`)) {
      errors.push("YouTube URLs must be raw/unwrapped, not wrapped in angle brackets, so Discord embeds render.");
    }
  }

  return { ok: errors.length === 0, errors };
}

function livePublicGuardLines() {
  return [
    "Live/public YouTube guard:",
    "- Before any customer-facing publish/send/comment/website activation, verify the YouTube URL is live and public.",
    "- Prefer YouTube Data API when available: privacyStatus must be public; reject private, unlisted, scheduled, removed, or members-only states.",
    "- If you cannot confirm public/live status, mark this work item blocked with the verification evidence; do not perform the external action.",
    "- This public gate does not block prepublication internal drafts; it applies only to publish/send/comment/activation.",
  ];
}

function prepublicationDraftAuthorizationLines() {
  return [
    "Prepublication draft authorization:",
    "- Private/scheduled YouTube videos are allowed for this draft.",
    "- This is an internal artifact for Gonza review only.",
    "- Do not publish, send, schedule externally, or comment on YouTube from this draft task.",
    "- Public/live gate applies later only to publish/send/comment/website activation.",
  ];
}

function packageHeader(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; playlistContextUrl?: string | null }) {
  return [
    `Video: ${input.title}`,
    `YouTube URL: ${input.youtubeUrl}`,
    `Video ID: ${input.videoId}`,
    `Scheduled publish_at: ${input.publishAt}`,
    ...(input.playlistContextUrl ? [`Playlist context URL: ${input.playlistContextUrl}`] : []),
    "Newsletter: out of scope for V1.",
    "Marketing video announcement handoff: in scope; Marketing owns copy, segmentation, and send workflow.",
  ];
}

function liveCheckInstruction(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; playlistContextUrl?: string | null }) {
  return [
    ...packageHeader(input),
    "",
    "Task:",
    "- At publish_at+2m, verify the scheduled video is now public/live.",
    "- If public/live, activate the launch package: note the live URL, confirm title/thumbnail state, and flag any blockers for Community/Dev.",
    "- Do not mark the pipeline item published unless you have verified the public URL.",
    "- Complete with output.live_check = { status, checked_at, public_url, evidence }.",
    "",
    ...livePublicGuardLines(),
  ].join("\n");
}

function preflightInstruction(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; playlistContextUrl?: string | null }) {
  return [
    ...packageHeader(input),
    "",
    "Task:",
    "- Run the scheduled launch preflight at T-30m, or immediately if the launch is already inside that window.",
    "- Check title, thumbnail, description/chapters, CTA/ref links, playlist placement, and scheduled publish time.",
    "- This is a readiness check only; do not make external customer-facing changes without Gonza approval where applicable.",
    "- Complete with output.preflight = { status, checked_at, blockers, evidence }.",
  ].join("\n");
}

function communityDraftInstruction(input: ScheduledYouTubeLaunchSpecContext) {
  const structuredContext = {
    video_id: input.videoId,
    watch_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl || null,
    publish_at: input.publishAt,
    target_publish_at: input.targetCommunityPublishAt,
    cta: input.cta || null,
    suppress_link_previews: false,
    validation_requirements: {
      ready_for_review_status_required: true,
      playlist_context_url_required_when_present: true,
      raw_unwrapped_youtube_url_required: true,
      fail_if_final_copy_ends_with_bare_watch_url_when_playlist_exists: true,
    },
  };

  return [
    ...packageHeader(input),
    `Target community publish time after Gonza approval: ${input.targetCommunityPublishAt} (publish_at+30m).`,
    "",
    "Task:",
    "- Use the structured launch context below to draft a concise Spanish Discord/community launch announcement for this YouTube video.",
    "- Community Agent owns the current copy/formatting playbook; do not treat Strategist/Dev automation as the policy source of truth.",
    "- Produce Ready for Review copy only; do not publish, schedule, or send it yourself.",
    "- When completing the work item, include output.copy.text and output.status=ready_for_review so Mission Control can run lightweight launch validation.",
    "- After Gonza approves, Mission Control should schedule the publish task for the target time above; V1 must not auto-publish without approval.",
    "",
    "Structured launch context:",
    JSON.stringify(structuredContext, null, 2),
    "",
    ...prepublicationDraftAuthorizationLines(),
  ].join("\n");
}

function pinnedCommentDraftInstruction(input: ScheduledYouTubeLaunchSpecContext) {
  const structuredContext = {
    video_id: input.videoId,
    watch_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl || null,
    publish_at: input.publishAt,
    cta: input.cta || null,
    target_publication_rule: "after_gonza_approval_and_live_check_only",
  };

  return [
    ...packageHeader(input),
    "",
    "Task:",
    "- Draft a concise Spanish YouTube pinned comment for this scheduled launch.",
    "- Keep it useful, CTA-oriented, and ready for Gonza review.",
    "- Produce a pinned comment draft only; do not publish, pin, or call YouTube APIs.",
    "- Complete with output.pinned_comment_draft = { text, status: 'ready_for_review' }.",
    "",
    "Structured launch context:",
    JSON.stringify(structuredContext, null, 2),
    "",
    ...prepublicationDraftAuthorizationLines(),
  ].join("\n");
}

function websitePublishInstruction(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; playlistContextUrl?: string | null }) {
  return [
    ...packageHeader(input),
    "",
    "Task:",
    "- Publish/update the AIPaths website entry for this YouTube video at publish_at+15m.",
    "- Use the public YouTube URL/video ID above and preserve existing site conventions for video resources/pages.",
    "- Complete with current_url and a short summary of what changed.",
    "- Newsletter remains out of scope; do not create newsletter assets from this task.",
    "",
    ...livePublicGuardLines(),
  ].join("\n");
}

function marketingEmailInstruction(input: ScheduledYouTubeLaunchSpecContext) {
  const structuredContext = {
    video_id: input.videoId,
    watch_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl || null,
    publish_at: input.publishAt,
    target_send_at: input.targetEmailSendAt,
    email_tracking_ref: input.emailTrackingRef,
    optional_diagnostic_cta: input.optionalDiagnosticCta || null,
  };

  return [
    ...packageHeader(input),
    `Target email send time after Gonza approval: ${input.targetEmailSendAt} (default publish_at+3h).`,
    "",
    "Task:",
    "- Use the structured launch context below to draft a Spanish email campaign handoff for this YouTube video.",
    "- Marketing owns copy, segmentation, approval, and scheduling workflow; do not treat Strategist/Dev automation as the policy source of truth.",
    "- Produce a draft for Gonza approval only; do not send or schedule the email yourself.",
    "- Complete with output.email_draft containing subject, preview_text, and body_markdown so Mission Control can move the email campaign to ready_for_review.",
    "",
    "Structured launch context:",
    JSON.stringify(structuredContext, null, 2),
    "",
    ...prepublicationDraftAuthorizationLines(),
  ].join("\n");
}

function snapshotInstruction(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; label: string; playlistContextUrl?: string | null }) {
  return [
    ...packageHeader(input),
    `Snapshot window: ${input.label}`,
    "",
    "Task:",
    "- Collect a lightweight public YouTube performance snapshot for this video.",
    "- Capture views, likes, comments count, title/thumbnail state, and notable public comment signals if available.",
    "- Complete with output.youtube_snapshot including the numbers, checked_at, and source URL.",
    "",
    ...livePublicGuardLines(),
  ].join("\n");
}

async function findExistingVideoItem(db: SupabaseClient, videoId: string, youtubeUrl: string) {
  const selectors = [
    { column: "metadata->launch_package->>video_id", value: videoId },
    { column: "metadata->youtube_v0->>video_id", value: videoId },
    { column: "metadata->publication->>video_id", value: videoId },
    { column: "current_url", value: youtubeUrl },
  ];

  for (const selector of selectors) {
    const { data, error } = await db
      .from("pipeline_items")
      .select("*")
      .eq("pipeline_type", "video")
      .eq(selector.column, selector.value)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);

    if (error) throw error;
    if (data?.[0]) return data[0] as PipelineItemRow;
  }

  return null;
}

async function ensureVideoPipelineItem(db: SupabaseClient, input: Required<Pick<YouTubeLaunchPackageInput, "publishAt" | "requestedBy">> & {
  title: string;
  youtubeUrl: string;
  videoId: string;
  playlistContextUrl: string | null;
  targetCommunityPublishAt: string;
  targetEmailSendAt: string;
  emailTrackingRef: string;
  optionalDiagnosticCta: string | null;
  cta: string | null;
  refs: unknown;
}) {
  const now = new Date().toISOString();
  const existing = await findExistingVideoItem(db, input.videoId, input.youtubeUrl);
  const existingMetadata = toRecord(existing?.metadata);
  const existingLaunchPackage = toRecord(existingMetadata.launch_package);
  const existingYoutubeV0 = toRecord(existingMetadata.youtube_v0);
  const existingPublication = toRecord(existingMetadata.publication);
  const launchPackage = {
    ...existingLaunchPackage,
    kind: "scheduled_youtube_launch_package_v1",
    status: "scheduled",
    newsletter_scope: "excluded_v1",
    video_id: input.videoId,
    youtube_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl,
    publish_at: input.publishAt,
    target_community_publish_at: input.targetCommunityPublishAt,
    target_email_send_at: input.targetEmailSendAt,
    email_tracking_ref: input.emailTrackingRef,
    optional_diagnostic_cta: input.optionalDiagnosticCta,
    cta: input.cta,
    refs: input.refs ?? existingLaunchPackage.refs ?? null,
    requested_by: input.requestedBy,
    updated_at: now,
    created_at: existingLaunchPackage.created_at || now,
  };
  const metadata = {
    ...existingMetadata,
    youtube_v0: {
      ...existingYoutubeV0,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      scheduled_publish_at: input.publishAt,
      launch_package_status: "scheduled",
    },
    publication: {
      ...existingPublication,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      scheduled_publish_at: input.publishAt,
    },
    launch_package: launchPackage,
  };

  if (existing) {
    const { data, error } = await db
      .from("pipeline_items")
      .update({
        title: input.title || existing.title,
        status: existing.published_at || existing.status === "published" ? existing.status : existing.status || "editing",
        owner_agent: existing.owner_agent || "youtube",
        requested_by: existing.requested_by || input.requestedBy,
        scheduled_for: input.publishAt,
        current_url: input.youtubeUrl,
        metadata,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { item: data as PipelineItemRow, created: false };
  }

  const { data, error } = await db
    .from("pipeline_items")
    .insert({
      pipeline_type: "video",
      title: input.title,
      status: "editing",
      priority: "high",
      owner_agent: "youtube",
      requested_by: input.requestedBy,
      source_type: "service",
      source_id: `youtube:${input.videoId}`,
      scheduled_for: input.publishAt,
      current_url: input.youtubeUrl,
      content_format: "youtube_url",
      metadata,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return { item: data as PipelineItemRow, created: true };
}

async function ensureCommunityPipelineItem(db: SupabaseClient, input: {
  videoItem: PipelineItemRow;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  targetPublishAt: string;
  playlistContextUrl: string | null;
  cta: string | null;
  requestedBy: string;
}) {
  const { data: existingRows, error: existingError } = await db
    .from("pipeline_items")
    .select("*")
    .eq("pipeline_type", "community_post")
    .eq("metadata->source->>video_id", input.videoId)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(1);

  if (existingError) throw existingError;
  const existing = existingRows?.[0] as PipelineItemRow | undefined;
  const now = new Date().toISOString();
  const existingMetadata = toRecord(existing?.metadata);
  const metadata = {
    ...existingMetadata,
    kind: "video_launch_announcement",
    channel: "discord",
    target: { platform: "discord" },
    source: {
      ...toRecord(existingMetadata.source),
      type: "video",
      pipeline_item_id: input.videoItem.id,
      title: input.title,
      url: input.youtubeUrl,
      video_url: input.youtubeUrl,
      video_id: input.videoId,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
    },
    copy: toRecord(existingMetadata.copy),
    schedule: {
      ...toRecord(existingMetadata.schedule),
      target_publish_at: input.targetPublishAt,
      requires_approval: true,
      auto_publish: false,
      source: "youtube_launch_package_v1",
    },
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
      target_publish_at: input.targetPublishAt,
      cta: input.cta,
      suppress_link_previews: false,
      prepublication_draft_authorized: true,
      public_gate_applies_to: "publish_or_send_only",
      requires_gonza_approval: true,
      validation_requirements: {
        ready_for_review_status_required: true,
        playlist_context_url_required_when_present: true,
        raw_unwrapped_youtube_url_required: true,
        fail_if_final_copy_ends_with_bare_watch_url_when_playlist_exists: true,
      },
      newsletter_scope: "excluded_v1",
      updated_at: now,
    },
  };

  if (existing) {
    const { data, error } = await db
      .from("pipeline_items")
      .update({
        title: `Announce video: ${input.title}`,
        status: TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "draft",
        owner_agent: "community",
        requested_by: existing.requested_by || input.requestedBy,
        source_type: "manual",
        source_id: input.videoItem.id,
        metadata,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { item: data as PipelineItemRow, created: false };
  }

  const { data, error } = await db
    .from("pipeline_items")
    .insert({
      pipeline_type: "community_post",
      title: `Announce video: ${input.title}`,
      status: "draft",
      priority: input.videoItem.priority || "high",
      owner_agent: "community",
      requested_by: input.requestedBy,
      source_type: "manual",
      source_id: input.videoItem.id,
      metadata,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return { item: data as PipelineItemRow, created: true };
}

async function ensureMarketingEmailPipelineItem(db: SupabaseClient, input: {
  videoItem: PipelineItemRow;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl: string | null;
  targetSendAt: string;
  emailTrackingRef: string;
  optionalDiagnosticCta: string | null;
  requestedBy: string;
}) {
  const existingSelectors = [
    { column: "metadata->source->>video_id", value: input.videoId },
    { column: "metadata->>video_id", value: input.videoId },
    { column: "metadata->launch_package->>video_id", value: input.videoId },
    { column: "source_id", value: input.videoItem.id },
  ];
  let existing: PipelineItemRow | undefined;
  for (const selector of existingSelectors) {
    const { data: existingRows, error: existingError } = await db
      .from("pipeline_items")
      .select("*")
      .eq("pipeline_type", "email_campaign")
      .eq(selector.column, selector.value)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);

    if (existingError) throw existingError;
    if (existingRows?.[0]) {
      existing = existingRows[0] as PipelineItemRow;
      break;
    }
  }
  const now = new Date().toISOString();
  const existingMetadata = toRecord(existing?.metadata);
  const metadata = {
    ...existingMetadata,
    kind: "video_announcement",
    source: {
      ...toRecord(existingMetadata.source),
      type: "video",
      pipeline_item_id: input.videoItem.id,
      title: input.title,
      watch_url: input.youtubeUrl,
      video_url: input.youtubeUrl,
      video_id: input.videoId,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
    },
    schedule: {
      ...toRecord(existingMetadata.schedule),
      target_send_at: input.targetSendAt,
      requires_approval: true,
      auto_send: false,
      source: "youtube_launch_package_v1",
    },
    draft: toRecord(existingMetadata.draft),
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
      target_send_at: input.targetSendAt,
      email_tracking_ref: input.emailTrackingRef,
      optional_diagnostic_cta: input.optionalDiagnosticCta,
      requires_gonza_approval: true,
      prepublication_draft_authorized: true,
      public_gate_applies_to: "publish_or_send_only",
      newsletter_scope: "excluded_v1",
      updated_at: now,
    },
  };

  if (existing) {
    const { data, error } = await db
      .from("pipeline_items")
      .update({
        title: `Email announcement: ${input.title}`,
        status: TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "sent" ? existing.status : existing.status || "drafting",
        owner_agent: "marketing",
        requested_by: existing.requested_by || input.requestedBy,
        source_type: "manual",
        source_id: input.videoItem.id,
        scheduled_for: input.targetSendAt,
        metadata,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { item: data as PipelineItemRow, created: false };
  }

  const { data, error } = await db
    .from("pipeline_items")
    .insert({
      pipeline_type: "email_campaign",
      title: `Email announcement: ${input.title}`,
      status: "drafting",
      priority: input.videoItem.priority || "high",
      owner_agent: "marketing",
      requested_by: input.requestedBy,
      source_type: "manual",
      source_id: input.videoItem.id,
      scheduled_for: input.targetSendAt,
      metadata,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return { item: data as PipelineItemRow, created: true };
}

async function ensurePinnedCommentPipelineItem(db: SupabaseClient, input: {
  videoItem: PipelineItemRow;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl: string | null;
  cta: string | null;
  requestedBy: string;
}) {
  const { data: existingRows, error: existingError } = await db
    .from("pipeline_items")
    .select("*")
    .eq("pipeline_type", "youtube_pinned_comment")
    .eq("metadata->launch_package->>video_id", input.videoId)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(1);

  if (existingError) throw existingError;
  const existing = existingRows?.[0] as PipelineItemRow | undefined;
  const now = new Date().toISOString();
  const existingMetadata = toRecord(existing?.metadata);
  const metadata = {
    ...existingMetadata,
    kind: "youtube_pinned_comment",
    source: {
      ...toRecord(existingMetadata.source),
      type: "video",
      pipeline_item_id: input.videoItem.id,
      title: input.title,
      watch_url: input.youtubeUrl,
      video_url: input.youtubeUrl,
      video_id: input.videoId,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
    },
    draft: toRecord(existingMetadata.draft),
    review: toRecord(existingMetadata.review),
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      publish_at: input.publishAt,
      cta: input.cta,
      prepublication_draft_authorized: true,
      public_gate_applies_to: "publish_or_send_only",
      requires_gonza_approval: true,
      requires_live_check_passed: true,
      updated_at: now,
    },
  };

  if (existing) {
    const { data, error } = await db
      .from("pipeline_items")
      .update({
        title: `Pinned comment draft: ${input.title}`,
        status: TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "drafting",
        owner_agent: "youtube",
        requested_by: existing.requested_by || input.requestedBy,
        source_type: "manual",
        source_id: input.videoItem.id,
        metadata,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { item: data as PipelineItemRow, created: false };
  }

  const { data, error } = await db
    .from("pipeline_items")
    .insert({
      pipeline_type: "youtube_pinned_comment",
      title: `Pinned comment draft: ${input.title}`,
      status: "drafting",
      priority: input.videoItem.priority || "high",
      owner_agent: "youtube",
      requested_by: input.requestedBy,
      source_type: "manual",
      source_id: input.videoItem.id,
      metadata,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) throw error;
  return { item: data as PipelineItemRow, created: true };
}

async function findExistingWorkItemByVideoRelation(db: SupabaseClient, videoId: string, relationType: string) {
  const { data, error } = await db
    .from("work_items")
    .select("id,status,payload")
    .eq("payload->>video_id", videoId)
    .eq("payload->>relation_type", relationType)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return (data?.[0] || null) as WorkItemRow | null;
}

async function mapWorkItem(db: SupabaseClient, pipelineItemId: string, workItemId: string, relationType: string) {
  const { error } = await db.from("pipeline_work_map").insert({
    pipeline_item_id: pipelineItemId,
    work_item_id: workItemId,
    relation_type: relationType,
  });
  if (error && !String(error.message || "").includes("duplicate")) throw error;
}

async function upsertLaunchWorkItem(db: SupabaseClient, spec: LaunchWorkSpec, common: {
  videoId: string;
  videoPipelineItemId: string;
  youtubeUrl: string;
  publishAt: string;
  requestedBy: string;
}) {
  const now = new Date().toISOString();
  const existing = await findExistingWorkItemByVideoRelation(db, common.videoId, spec.relationType);
  const payload = {
    ...toRecord(existing?.payload),
    trigger: "youtube_launch_package_v1",
    pipeline_type: spec.pipelineType,
    pipeline_item_id: spec.sourcePipelineItemId,
    source_video_pipeline_item_id: common.videoPipelineItemId,
    relation_type: spec.relationType,
    map_relation_type: spec.mapRelationType,
    action: spec.action,
    schedule_kind: "youtube_launch_package",
    video_id: common.videoId,
    youtube_url: common.youtubeUrl,
    publish_at: common.publishAt,
    newsletter_scope: "excluded_v1",
    ...(spec.payloadExtra || {}),
  };

  if (existing?.id) {
    if (TERMINAL_WORK_STATUSES.has(existing.status)) {
      await mapWorkItem(db, spec.mapPipelineItemId, existing.id, spec.mapRelationType);
      return { workItem: existing, created: false, updated: false, skipped: true };
    }

    const { data, error } = await db
      .from("work_items")
      .update({
        title: spec.title,
        instruction: spec.instruction,
        status: existing.status === "in_progress" ? "in_progress" : "ready",
        scheduled_for: spec.scheduledFor,
        priority: spec.priority || "high",
        owner_agent: spec.ownerAgent,
        target_agent_id: spec.ownerAgent,
        requested_by: common.requestedBy,
        source_type: "pipeline_item",
        source_id: spec.sourcePipelineItemId,
        payload,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select("id,status,payload")
      .single();
    if (error) throw error;
    await mapWorkItem(db, spec.mapPipelineItemId, data.id, spec.mapRelationType);
    return { workItem: data as WorkItemRow, created: false, updated: true, skipped: false };
  }

  const { data, error } = await db
    .from("work_items")
    .insert({
      kind: "task",
      source_type: "pipeline_item",
      source_id: spec.sourcePipelineItemId,
      title: spec.title,
      instruction: spec.instruction,
      status: "ready",
      scheduled_for: spec.scheduledFor,
      priority: spec.priority || "high",
      owner_agent: spec.ownerAgent,
      target_agent_id: spec.ownerAgent,
      requested_by: common.requestedBy,
      payload,
    })
    .select("id,status,payload")
    .single();

  if (error) throw error;
  await mapWorkItem(db, spec.mapPipelineItemId, data.id, spec.mapRelationType);
  return { workItem: data as WorkItemRow, created: true, updated: false, skipped: false };
}

export function buildScheduledYouTubeLaunchWorkSpecs(context: ScheduledYouTubeLaunchSpecContext): ScheduledYouTubeLaunchWorkSpec[] {
  const videoPipelineItemId = context.videoPipelineItemId || "";
  const communityPipelineItemId = context.communityPipelineItemId || videoPipelineItemId;
  const marketingPipelineItemId = context.marketingPipelineItemId || videoPipelineItemId;
  const pinnedCommentPipelineItemId = context.pinnedCommentPipelineItemId || videoPipelineItemId;
  const preparedAt = normalizeIsoDate(context.preparedAt || new Date().toISOString(), "prepared_at");
  const commonInstructionInput = {
    title: context.title,
    youtubeUrl: context.youtubeUrl,
    videoId: context.videoId,
    publishAt: context.publishAt,
    playlistContextUrl: context.playlistContextUrl || null,
  };
  const preflightAt = maxIsoDate(addMinutes(context.publishAt, -30), preparedAt);
  const draftGatePayload = {
    prepublication_draft_authorized: true,
    public_gate_applies_to: "publish_or_send_only",
    requires_gonza_approval: true,
    customer_facing_guard: false,
  };
  const publicActionGatePayload = {
    customer_facing_guard: true,
    public_gate_applies_to: "activation_only",
    requires_live_check_passed: true,
    live_check_relation_type: "video_launch_activate",
  };

  return [
    {
      relationType: "youtube_launch_preflight",
      mapRelationType: "followup",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Preflight YouTube launch: ${context.title}`,
      instruction: preflightInstruction(commonInstructionInput),
      ownerAgent: "youtube",
      action: "youtube_launch_preflight",
      scheduledFor: preflightAt,
      payloadExtra: { launch_step: "preflight", scheduled_preflight_at: addMinutes(context.publishAt, -30), playlist_context_url: context.playlistContextUrl || null },
    },
    {
      relationType: "video_launch_activate",
      mapRelationType: "followup",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Live-check YouTube launch: ${context.title}`,
      instruction: liveCheckInstruction(commonInstructionInput),
      ownerAgent: "strategist",
      action: "video_launch_activate",
      scheduledFor: addMinutes(context.publishAt, 2),
      payloadExtra: { launch_step: "live_check", customer_facing_guard: true, playlist_context_url: context.playlistContextUrl || null },
    },
    {
      relationType: "launch_community_draft",
      mapRelationType: "distribute_community",
      mapPipelineItemId: communityPipelineItemId,
      sourcePipelineItemId: communityPipelineItemId,
      pipelineType: "community_post",
      title: `Draft community launch copy: ${context.title}`,
      instruction: communityDraftInstruction(context),
      ownerAgent: "community",
      action: "develop_community_post",
      scheduledFor: preparedAt,
      payloadExtra: {
        launch_step: "community_draft",
        ...draftGatePayload,
        target_publish_at_after_approval: context.targetCommunityPublishAt,
        playlist_context_url: context.playlistContextUrl || null,
        cta: context.cta || null,
        suppress_link_previews: false,
        validation_requirements: {
          ready_for_review_status_required: true,
          playlist_context_url_required_when_present: true,
          raw_unwrapped_youtube_url_required: true,
          fail_if_final_copy_ends_with_bare_watch_url_when_playlist_exists: true,
        },
      },
    },
    {
      relationType: "youtube_pinned_comment_draft",
      mapRelationType: "pinned_comment",
      mapPipelineItemId: pinnedCommentPipelineItemId,
      sourcePipelineItemId: pinnedCommentPipelineItemId,
      pipelineType: "youtube_pinned_comment",
      title: `Draft YouTube pinned comment: ${context.title}`,
      instruction: pinnedCommentDraftInstruction(context),
      ownerAgent: "youtube",
      action: "draft_youtube_pinned_comment",
      scheduledFor: preparedAt,
      payloadExtra: {
        launch_step: "pinned_comment_draft",
        ...draftGatePayload,
        playlist_context_url: context.playlistContextUrl || null,
        cta: context.cta || null,
      },
    },
    {
      relationType: "website_publish_video",
      mapRelationType: "publish",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Publish video on website: ${context.title}`,
      instruction: websitePublishInstruction(commonInstructionInput),
      ownerAgent: "dev",
      action: "website_publish_video",
      scheduledFor: addMinutes(context.publishAt, 15),
      payloadExtra: { launch_step: "website_publish", ...publicActionGatePayload, playlist_context_url: context.playlistContextUrl || null },
    },
    {
      relationType: "marketing_email_campaign",
      mapRelationType: "distribute_marketing",
      mapPipelineItemId: marketingPipelineItemId,
      sourcePipelineItemId: marketingPipelineItemId,
      pipelineType: "email_campaign",
      title: `Draft video announcement email: ${context.title}`,
      instruction: marketingEmailInstruction(context),
      ownerAgent: "marketing",
      action: "draft_video_announcement",
      scheduledFor: preparedAt,
      payloadExtra: {
        launch_step: "marketing_email_campaign",
        ...draftGatePayload,
        target_send_at: context.targetEmailSendAt,
        email_tracking_ref: context.emailTrackingRef,
        optional_diagnostic_cta: context.optionalDiagnosticCta || null,
        playlist_context_url: context.playlistContextUrl || null,
        email_campaign_kind: "video_announcement",
      },
    },
    {
      relationType: "youtube_snapshot_24h",
      mapRelationType: "followup",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Collect YouTube snapshot +24h: ${context.title}`,
      instruction: snapshotInstruction({ ...commonInstructionInput, label: "+24h" }),
      ownerAgent: "youtube",
      action: "collect_youtube_snapshot",
      scheduledFor: addDays(context.publishAt, 1),
      payloadExtra: { launch_step: "snapshot", snapshot_label: "+24h", playlist_context_url: context.playlistContextUrl || null },
    },
    {
      relationType: "youtube_snapshot_7d",
      mapRelationType: "followup",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Collect YouTube snapshot +7d: ${context.title}`,
      instruction: snapshotInstruction({ ...commonInstructionInput, label: "+7d" }),
      ownerAgent: "youtube",
      action: "collect_youtube_snapshot",
      scheduledFor: addDays(context.publishAt, 7),
      payloadExtra: { launch_step: "snapshot", snapshot_label: "+7d", playlist_context_url: context.playlistContextUrl || null },
    },
    {
      relationType: "youtube_snapshot_28d",
      mapRelationType: "followup",
      mapPipelineItemId: videoPipelineItemId,
      sourcePipelineItemId: videoPipelineItemId,
      pipelineType: "video",
      title: `Collect YouTube snapshot +28d: ${context.title}`,
      instruction: snapshotInstruction({ ...commonInstructionInput, label: "+28d" }),
      ownerAgent: "youtube",
      action: "collect_youtube_snapshot",
      scheduledFor: addDays(context.publishAt, 28),
      payloadExtra: { launch_step: "snapshot", snapshot_label: "+28d", playlist_context_url: context.playlistContextUrl || null },
    },
  ];
}

export async function createScheduledYouTubeLaunchPackage(db: SupabaseClient, input: YouTubeLaunchPackageInput) {
  const publishAt = normalizeIsoDate(input.publishAt, "publish_at");
  const videoId = trimToNull(input.videoId) || extractYouTubeVideoId(input.youtubeUrl);
  if (!videoId) throw new Error("A valid YouTube video_id or URL is required");
  const youtubeUrl = trimToNull(input.youtubeUrl) || youtubeWatchUrl(videoId);
  const title = trimToNull(input.title) || `Scheduled YouTube video ${videoId}`;
  const requestedBy = trimToNull(input.requestedBy) || "mission-control";
  const preparedAt = input.preparedAt ? normalizeIsoDate(input.preparedAt, "prepared_at") : new Date().toISOString();
  const targetCommunityPublishAt = addMinutes(publishAt, 30);
  const refs = toRecord(input.refs);
  const existingVideoContext = await findExistingVideoItem(db, videoId, youtubeUrl);
  const existingVideoMetadata = toRecord(existingVideoContext?.metadata);
  const playlistContextUrl =
    trimToNull(input.playlistContextUrl) ||
    firstStringFromRecords([refs], [
      ["playlist_context_url"],
      ["playlistContextUrl"],
      ["playlist_url"],
      ["playlistUrl"],
      ["playlist", "context_url"],
      ["playlist", "url"],
      ["source", "playlist_context_url"],
      ["source", "playlist_url"],
    ]) ||
    firstStringFromRecords([existingVideoMetadata], [
      ["launch_package", "playlist_context_url"],
      ["source", "playlist_context_url"],
      ["source", "playlist_url"],
      ["youtube_v0", "playlist_context_url"],
      ["publication", "playlist_context_url"],
    ]) ||
    youtubePlaylistContextUrl(videoId, trimToNull(input.playlistId) || firstStringFromRecords([refs], [["playlist_id"], ["playlistId"], ["playlist", "id"]]));
  const targetEmailSendAt = input.targetEmailSendAt ? normalizeIsoDate(input.targetEmailSendAt, "target_email_send_at") : addMilliseconds(publishAt, 3 * 60 * 60 * 1000);
  const emailTrackingRef = trimToNull(input.emailTrackingRef) || `email-youtube-${videoId}`;
  const optionalDiagnosticCta = trimToNull(input.optionalDiagnosticCta) || firstStringFromRecords([refs], [["optional_diagnostic_cta"], ["diagnostic_cta"]]);
  const cta = trimToNull(input.cta) || firstStringFromRecords([refs], [["cta"], ["community", "cta"]]);

  const video = await ensureVideoPipelineItem(db, {
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    targetCommunityPublishAt,
    targetEmailSendAt,
    emailTrackingRef,
    optionalDiagnosticCta,
    cta,
    refs: input.refs ?? null,
    requestedBy,
  });

  const community = await ensureCommunityPipelineItem(db, {
    videoItem: video.item,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    targetPublishAt: targetCommunityPublishAt,
    playlistContextUrl,
    cta,
    requestedBy,
  });

  const marketing = await ensureMarketingEmailPipelineItem(db, {
    videoItem: video.item,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    targetSendAt: targetEmailSendAt,
    emailTrackingRef,
    optionalDiagnosticCta,
    requestedBy,
  });

  const pinnedComment = await ensurePinnedCommentPipelineItem(db, {
    videoItem: video.item,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    cta,
    requestedBy,
  });

  const common = { videoId, videoPipelineItemId: video.item.id, youtubeUrl, publishAt, requestedBy };
  const specs = buildScheduledYouTubeLaunchWorkSpecs({
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    targetCommunityPublishAt,
    targetEmailSendAt,
    emailTrackingRef,
    optionalDiagnosticCta,
    cta,
    preparedAt,
    videoPipelineItemId: video.item.id,
    communityPipelineItemId: community.item.id,
    marketingPipelineItemId: marketing.item.id,
    pinnedCommentPipelineItemId: pinnedComment.item.id,
  });

  const workItems = [];
  for (const spec of specs) {
    workItems.push({ relationType: spec.relationType, ...(await upsertLaunchWorkItem(db, spec, common)) });
  }

  await db.from("pipeline_events").insert({
    pipeline_item_id: video.item.id,
    event_type: "pipeline_item.youtube_launch_package_prepared",
    actor: requestedBy,
    payload: {
      video_id: videoId,
      youtube_url: youtubeUrl,
      publish_at: publishAt,
      community_pipeline_item_id: community.item.id,
      marketing_pipeline_item_id: marketing.item.id,
      pinned_comment_pipeline_item_id: pinnedComment.item.id,
      prepared_at: preparedAt,
      work_item_ids: workItems.map((entry) => entry.workItem?.id).filter(Boolean),
      newsletter_scope: "excluded_v1",
      email_campaign_handoff: {
        enabled: true,
        target_send_at: targetEmailSendAt,
        email_tracking_ref: emailTrackingRef,
      },
    },
  });

  return {
    videoItem: video.item,
    videoItemCreated: video.created,
    communityItem: community.item,
    communityItemCreated: community.created,
    marketingItem: marketing.item,
    marketingItemCreated: marketing.created,
    pinnedCommentItem: pinnedComment.item,
    pinnedCommentItemCreated: pinnedComment.created,
    publishAt,
    targetCommunityPublishAt,
    targetEmailSendAt,
    playlistContextUrl,
    youtubeUrl,
    videoId,
    workItems,
  };
}
