import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type JsonRecord = Record<string, unknown>;

export type YouTubeLaunchPackageInput = {
  pipelineItemId?: string | null;
  youtubeUrl?: string | null;
  videoId?: string | null;
  publishAt: string;
  title?: string | null;
  playlistContextUrl?: string | null;
  playlistId?: string | null;
  requireGovernedPlaylist?: boolean;
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
  launchGeneration?: string | null;
  playlistContextUrl?: string | null;
  playlistId?: string | null;
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
  videoId?: string | null;
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

const GENERATION_SCOPED_WORK_PAYLOAD_KEYS = new Set([
  "runtime_retry_state", "dead_letter_reason", "dead_lettered_at", "remediation",
  "external_delivery_claim", "external_delivery_result", "external_delivery_idempotency_key",
  "dispatch_state", "dispatch_failure_class", "dispatch_failure_reason", "scheduled_launch_failure_class",
  "wake_failure_count", "last_wake_failed_at", "last_wake_error", "preflight_attempt_count",
  "output", "result", "live_gate_checked_at", "live_gate_failures", "live_gate_remediation",
  "dispatch_session_id", "execution_attempt_id", "attempt_id", "wake_attempt",
]);

function reusablePayloadForLaunchGeneration(payload: JsonRecord, launchGeneration: string) {
  if (trimToNull(payload.launch_generation) === launchGeneration) return payload;
  const reusable: JsonRecord = {};
  for (const [key, value] of Object.entries(payload)) {
    if (GENERATION_SCOPED_WORK_PAYLOAD_KEYS.has(key) || key.startsWith("generic_notify_")) continue;
    reusable[key] = value;
  }
  return reusable;
}

function normalizeIsoDate(value: string, fieldName: string) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`A timezone-qualified ${fieldName} is required`);
  }
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
  const exactVideoId = (candidate: string | null | undefined) => {
    const normalized = trimToNull(candidate);
    return normalized && /^[a-zA-Z0-9_-]{11}$/.test(normalized) ? normalized : null;
  };
  const rawVideoId = exactVideoId(raw);
  if (rawVideoId) return rawVideoId;

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length === 1 && url.pathname === `/${parts[0]}` ? exactVideoId(parts[0]) : null;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") return exactVideoId(url.searchParams.get("v"));
      if (parts.length === 2
        && ["shorts", "embed", "live"].includes(parts[0])
        && url.pathname === `/${parts[0]}/${parts[1]}`) return exactVideoId(parts[1]);
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

function playlistIdFromYouTubeUrl(videoId: string, value: string, allowPlaylistOnly: boolean) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol !== "https:" || (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com"))) return null;
    const playlistId = trimToNull(url.searchParams.get("list"));
    if (!playlistId) return null;

    if (host === "youtu.be") {
      const pathVideoId = trimToNull(url.pathname.split("/").filter(Boolean)[0]);
      return pathVideoId === videoId ? playlistId : null;
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") {
      return url.searchParams.get("v") === videoId ? playlistId : null;
    }
    if (["embed", "shorts", "live"].includes(pathParts[0]) && pathParts[1] === videoId) {
      return playlistId;
    }
    if (allowPlaylistOnly && url.pathname === "/playlist") return playlistId;
  } catch {
    return null;
  }

  return null;
}

export function resolveYouTubePlaylistContextUrl(videoId: string, value: string | null | undefined, options: { allowRawPlaylistId?: boolean; allowPlaylistOnly?: boolean } = {}) {
  const raw = trimToNull(value);
  if (!raw) return null;
  const playlistId =
    playlistIdFromYouTubeUrl(videoId, raw, options.allowPlaylistOnly === true) ||
    (options.allowRawPlaylistId === true && /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null);
  return youtubePlaylistContextUrl(videoId, playlistId);
}

export function firstPlaylistContextUrlFromRecords(videoId: string, records: JsonRecord[], paths: string[][], options: { allowRawPlaylistId?: boolean; allowPlaylistOnly?: boolean } = {}) {
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
      const resolved = resolveYouTubePlaylistContextUrl(videoId, trimToNull(current), options);
      if (resolved) return resolved;
    }
  }
  return null;
}

function playlistIdFromContextUrl(videoId: string, value: string | null | undefined) {
  const raw = trimToNull(value);
  return raw ? playlistIdFromYouTubeUrl(videoId, raw, true) : null;
}

function reusableLaunchGenerationFromMetadata(input: {
  videoItem: PipelineItemRow | null | undefined;
  videoId: string;
  publishAt: string;
}) {
  if (!input.videoItem || input.videoItem.published_at || input.videoItem.status !== "scheduled") return null;
  const launch = toRecord(toRecord(input.videoItem.metadata).launch_package);
  const generation = trimToNull(launch.launch_generation);
  if (launch.kind !== "scheduled_youtube_launch_package_v1"
    || launch.status !== "scheduled"
    || launch.video_id !== input.videoId
    || launch.publish_at !== input.publishAt
    || !generation) return null;
  return generation;
}

function newLaunchGeneration(videoId: string, publishAt: string) {
  return `youtube-launch-v1:${videoId}:${publishAt}:${randomUUID()}`;
}

export function requireCommunityPlaylistContextUrl(videoId: string, value: string | null | undefined) {
  const playlistContextUrl = trimToNull(value);
  if (!playlistContextUrl) {
    throw new Error("playlist_context_url is required for AIPaths community video announcements");
  }

  try {
    const url = new URL(playlistContextUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com"].includes(host)
      || url.pathname !== "/watch" || url.searchParams.get("v") !== videoId) {
      throw new Error("invalid watch URL");
    }
    if (!trimToNull(url.searchParams.get("list"))) {
      throw new Error("missing playlist");
    }
  } catch {
    throw new Error("playlist_context_url must be a YouTube watch URL for this video and include list=");
  }

  return playlistContextUrl;
}

export function validateCommunityLaunchDraftOutput(input: CommunityLaunchDraftValidationInput) {
  const finalCopy = trimToNull(input.finalCopy) || "";
  const playlistContextUrl = trimToNull(input.playlistContextUrl);
  const watchUrl = trimToNull(input.watchUrl);
  const videoId = trimToNull(input.videoId) || extractYouTubeVideoId(watchUrl);
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
  if (!playlistContextUrl) {
    errors.push("playlist_context_url is required for AIPaths community video announcements.");
  } else {
    if (!videoId) {
      errors.push("A valid video_id is required to validate playlist_context_url.");
    } else {
      try {
        requireCommunityPlaylistContextUrl(videoId, playlistContextUrl);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!finalCopy.includes(playlistContextUrl)) {
      errors.push("Community final copy must include playlist_context_url.");
    }
    const trailingUrl = finalCopy.match(/https:\/\/www\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}(?:\s*)$/)?.[0]?.trim();
    if (watchUrl && trailingUrl === watchUrl) {
      errors.push("Community final copy must not end with the bare watch URL when playlist_context_url exists.");
    }
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

function packageHeader(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; launchGeneration?: string | null; playlistContextUrl?: string | null }) {
  return [
    `Video: ${input.title}`,
    `YouTube URL: ${input.youtubeUrl}`,
    `Video ID: ${input.videoId}`,
    `Scheduled publish_at: ${input.publishAt}`,
    ...(input.launchGeneration ? [`Launch generation: ${input.launchGeneration}`] : []),
    ...(input.playlistContextUrl ? [`Playlist context URL: ${input.playlistContextUrl}`] : []),
    "Newsletter: out of scope for V1.",
    "Marketing video announcement handoff: in scope; Marketing owns copy, segmentation, and send workflow.",
  ];
}

function liveCheckInstruction(input: { title: string; youtubeUrl: string; videoId: string; publishAt: string; launchGeneration?: string | null; playlistContextUrl?: string | null }) {
  return [
    ...packageHeader(input),
    "",
    "Task:",
    "- At publish_at+2m, verify the scheduled video is now public/live.",
    "- If public/live, activate the launch package: note the live URL, confirm title/thumbnail state, and flag any blockers for Community/Dev.",
    "- Do not mark the pipeline item published unless you have verified the public URL.",
    "- Complete with output.live_check = { status, checked_at, public_url, launch_generation, evidence }.",
    "- evidence must be { source: 'youtube_data_api' | 'youtube_watch_page', video_id, visibility: 'public', public_url } and must describe the same expected video.",
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
    playlist_id: input.playlistId || null,
    publish_at: input.publishAt,
    target_publish_at: input.targetCommunityPublishAt,
    cta: input.cta || null,
    suppress_link_previews: false,
    validation_requirements: {
      ready_for_review_status_required: true,
      playlist_context_url_required: true,
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
    playlist_id: input.playlistId || null,
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
    playlist_id: input.playlistId || null,
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

export const YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS: Record<string, string> = {
  strategist: "1474045438989697115",
  youtube: "1473373627750682664",
  content: "1473373703197691934",
  marketing: "1473373756557623481",
  dev: "1473373777755639982",
  community: "1473373793375490058",
  systems: "1493166685543206924",
};

function privateChannelForAgent(agent: string) {
  return YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS[agent] || YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.systems;
}

function stableLaunchHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function launchDeliveryIdempotencyKey(
  context: Pick<ScheduledYouTubeLaunchSpecContext, "videoId" | "publishAt" | "launchGeneration">,
  action: string,
  destination: string,
) {
  const seed = [
    context.launchGeneration || `youtube-launch-v1:${context.videoId}:${context.publishAt}`,
    action,
    destination,
  ].join("|");
  return `ytlaunch:${context.videoId}:${stableLaunchHash(seed)}`;
}

function launchRetryContract(
  context: Pick<ScheduledYouTubeLaunchSpecContext, "videoId" | "publishAt" | "launchGeneration">,
  action: string,
  destination: string,
) {
  return {
    runtime_retry_contract: "scheduled_launch_v2_retry_v1",
    retry_policy: {
      retryable_delays_minutes: [1, 5, 15],
      retryable_failure_classes: ["runtime_unavailable", "provider_timeout", "transient_network"],
      nonretryable_gate_failures_dead_letter: true,
    },
    external_delivery_idempotency_key: launchDeliveryIdempotencyKey(context, action, destination),
    idempotency_scope: {
      launch_generation: context.launchGeneration || null,
      action,
      destination,
    },
  };
}

export function buildScheduledLaunchPublicActionPayload(input: {
  metadata?: unknown;
  ownerAgent: string;
  action: string;
  destination: string;
}) {
  const metadata = toRecord(input.metadata);
  const launchPackage = toRecord(metadata.launch_package);
  if (launchPackage.kind !== "scheduled_youtube_launch_package_v1") return {};

  const videoId = trimToNull(launchPackage.video_id);
  const publishAt = trimToNull(launchPackage.publish_at);
  const launchGeneration = trimToNull(launchPackage.launch_generation);
  const sourceVideoPipelineItemId = trimToNull(launchPackage.source_video_pipeline_item_id);
  if (!videoId || !publishAt || !launchGeneration || !sourceVideoPipelineItemId) return {};
  const review = toRecord(metadata.review);
  const schedule = toRecord(metadata.schedule);
  const reviewStatus = trimToNull(review.status);
  const approved = reviewStatus === "approved"
    || Boolean(trimToNull(review.approved_by))
    || Boolean(trimToNull(schedule.approved_by));

  return {
    launch_state_contract: "scheduled_launch_v2",
    launch_generation: launchGeneration,
    source_video_pipeline_item_id: sourceVideoPipelineItemId,
    publish_at: publishAt,
    youtube_url: trimToNull(launchPackage.youtube_url),
    playlist_context_url: trimToNull(launchPackage.playlist_context_url),
    playlist_id: trimToNull(launchPackage.playlist_id),
    customer_facing_guard: true,
    public_gate_applies_to: "publish_or_send_only",
    requires_preflight_passed: true,
    preflight_relation_type: "youtube_launch_preflight",
    requires_live_check_passed: true,
    live_check_relation_type: "video_launch_activate",
    requires_gonza_approval: true,
    approval_status: approved ? "approved" : reviewStatus,
    notify_project_thread: false,
    suppress_task_router_webhook: true,
    failure_alert_destination: "responsible_agent_private_channel",
    private_director_channel_id: privateChannelForAgent(input.ownerAgent),
    ...launchRetryContract({ videoId, publishAt, launchGeneration }, input.action, input.destination),
  };
}

function approvalReminderInstruction(input: ScheduledYouTubeLaunchSpecContext & {
  artifact: "community announcement" | "email campaign" | "pinned comment draft";
  privateChannelId: string;
  approvalPath: string;
}) {
  return [
    ...packageHeader(input),
    "",
    "Task:",
    `- Check whether Gonza approval is already recorded for the ${input.artifact}.`,
    "- If approval is still missing, remind Gonza from this responsible agent profile in the private director channel only.",
    `- Private director channel: <#${input.privateChannelId}>.`,
    "- Never post this reminder to the project thread or public/community channels.",
    `- Approval path to inspect: ${input.approvalPath}.`,
    "- Complete with output.approval_reminder = { status, reminded_at, destination_channel_id, approval_status }.",
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

async function findExactVideoItem(db: SupabaseClient, pipelineItemId: string) {
  const { data, error } = await db
    .from("pipeline_items")
    .select("*")
    .eq("id", pipelineItemId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Video pipeline item not found");
  if (data.pipeline_type !== "video") throw new Error("pipelineItemId must reference a video pipeline item");
  return data as PipelineItemRow;
}

async function ensureVideoPipelineItem(db: SupabaseClient, input: Required<Pick<YouTubeLaunchPackageInput, "publishAt" | "requestedBy">> & {
  pipelineItemId: string | null;
  launchGeneration: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  playlistContextUrl: string | null;
  playlistId: string | null;
  targetCommunityPublishAt: string;
  targetEmailSendAt: string;
  emailTrackingRef: string;
  optionalDiagnosticCta: string | null;
  cta: string | null;
  refs: unknown;
}) {
  const now = new Date().toISOString();
  const existing = input.pipelineItemId
    ? await findExactVideoItem(db, input.pipelineItemId)
    : await findExistingVideoItem(db, input.videoId, input.youtubeUrl);
  const existingMetadata = toRecord(existing?.metadata);
  const existingLaunchPackage = toRecord(existingMetadata.launch_package);
  const existingYoutubeV0 = toRecord(existingMetadata.youtube_v0);
  const existingPublication = toRecord(existingMetadata.publication);
  if (existing && (Boolean(existing.published_at) || !["recorded", "editing", "scheduled"].includes(existing.status))) {
    throw new Error(`Cannot schedule video in ${existing.status || "unknown"} state`);
  }
  const launchPackage: JsonRecord = {
    ...existingLaunchPackage,
    kind: "scheduled_youtube_launch_package_v1",
    status: "scheduled",
    launch_state: "awaiting_approval",
    launch_generation: input.launchGeneration,
    newsletter_scope: "excluded_v1",
    video_id: input.videoId,
    youtube_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl,
    playlist_id: input.playlistId,
    publish_at: input.publishAt,
    approval_deadline_at: addMinutes(input.publishAt, -60),
    preflight_required_at: addMinutes(input.publishAt, -30),
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
  const scheduleIdentityChanged = Boolean(existing)
    && (trimToNull(existingLaunchPackage.launch_generation) !== input.launchGeneration
      || trimToNull(existingLaunchPackage.publish_at) !== input.publishAt);
  if (scheduleIdentityChanged) {
    for (const key of ["preflight", "live_check", "public_verified", "activated_at", "activation_evidence"]) {
      delete launchPackage[key];
    }
  }
  const metadata = {
    ...existingMetadata,
    youtube_v0: {
      ...existingYoutubeV0,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      playlist_id: input.playlistId,
      scheduled_publish_at: input.publishAt,
      stage: "scheduled",
      launch_package_status: "scheduled",
      launch_state: "awaiting_approval",
    },
    publication: {
      ...existingPublication,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      playlist_id: input.playlistId,
      scheduled_publish_at: input.publishAt,
    },
    launch_package: launchPackage,
  };

  if (existing) {
    const { data, error } = await db
      .from("pipeline_items")
      .update({
        title: input.title || existing.title,
        status: "scheduled",
        owner_agent: existing.owner_agent || "youtube",
        requested_by: existing.requested_by || input.requestedBy,
        scheduled_for: input.publishAt,
        current_url: null,
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
      status: "scheduled",
      priority: "high",
      owner_agent: "youtube",
      requested_by: input.requestedBy,
      source_type: "service",
      source_id: `youtube:${input.videoId}`,
      scheduled_for: input.publishAt,
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
  launchGeneration: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  targetPublishAt: string;
  playlistContextUrl: string | null;
  playlistId: string | null;
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
  const sameLaunchGeneration = trimToNull(toRecord(existingMetadata.launch_package).launch_generation) === input.launchGeneration;
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
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
    },
    copy: toRecord(existingMetadata.copy),
    review: sameLaunchGeneration ? toRecord(existingMetadata.review) : {},
    schedule: {
      ...(sameLaunchGeneration ? toRecord(existingMetadata.schedule) : {}),
      target_publish_at: input.targetPublishAt,
      requires_approval: true,
      auto_publish: false,
      source: "youtube_launch_package_v1",
    },
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      launch_generation: input.launchGeneration,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
      launch_state: "awaiting_approval",
      approval_deadline_at: addMinutes(input.publishAt, -60),
      preflight_required_at: addMinutes(input.publishAt, -30),
      target_publish_at: input.targetPublishAt,
      cta: input.cta,
      suppress_link_previews: false,
      prepublication_draft_authorized: true,
      public_gate_applies_to: "publish_or_send_only",
      requires_gonza_approval: true,
      validation_requirements: {
        ready_for_review_status_required: true,
        playlist_context_url_required: true,
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
        status: sameLaunchGeneration
          ? (TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "draft")
          : "draft",
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
  launchGeneration: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl: string | null;
  playlistId: string | null;
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
  const sameLaunchGeneration = trimToNull(toRecord(existingMetadata.launch_package).launch_generation) === input.launchGeneration;
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
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
    },
    review: sameLaunchGeneration ? toRecord(existingMetadata.review) : {},
    schedule: {
      ...(sameLaunchGeneration ? toRecord(existingMetadata.schedule) : {}),
      target_send_at: input.targetSendAt,
      requires_approval: true,
      auto_send: false,
      source: "youtube_launch_package_v1",
    },
    draft: toRecord(existingMetadata.draft),
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      launch_generation: input.launchGeneration,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
      launch_state: "awaiting_approval",
      approval_deadline_at: addMinutes(input.publishAt, -60),
      preflight_required_at: addMinutes(input.publishAt, -30),
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
        status: sameLaunchGeneration
          ? (TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "sent" ? existing.status : existing.status || "drafting")
          : "drafting",
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
  launchGeneration: string;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl: string | null;
  playlistId: string | null;
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
  const sameLaunchGeneration = trimToNull(toRecord(existingMetadata.launch_package).launch_generation) === input.launchGeneration;
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
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
    },
    draft: toRecord(existingMetadata.draft),
    review: sameLaunchGeneration ? toRecord(existingMetadata.review) : {},
    launch_package: {
      ...toRecord(existingMetadata.launch_package),
      source_video_pipeline_item_id: input.videoItem.id,
      launch_generation: input.launchGeneration,
      video_id: input.videoId,
      youtube_url: input.youtubeUrl,
      playlist_context_url: input.playlistContextUrl,
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
      launch_state: "awaiting_approval",
      approval_deadline_at: addMinutes(input.publishAt, -60),
      preflight_required_at: addMinutes(input.publishAt, -30),
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
        status: sameLaunchGeneration
          ? (TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "drafting")
          : "drafting",
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

async function findExistingWorkItemByVideoRelation(db: SupabaseClient, input: {
  videoPipelineItemId: string;
  videoId: string;
  relationType: string;
  launchGeneration: string;
  publishAt: string;
  allowLegacyVideoFallback: boolean;
}) {
  const exact = await db
    .from("work_items")
    .select("id,status,payload")
    .eq("payload->>source_video_pipeline_item_id", input.videoPipelineItemId)
    .eq("payload->>relation_type", input.relationType)
    .order("created_at", { ascending: false });
  if (exact.error) throw exact.error;
  const exactItems = (exact.data || []) as WorkItemRow[];
  const exactOpen = exactItems.filter((item) => !TERMINAL_WORK_STATUSES.has(item.status));
  if (exactOpen.length > 1) throw new Error(`Duplicate open YouTube launch work for ${input.relationType}`);
  if (exactOpen[0]) return exactOpen[0];
  const exactTerminal = exactItems.find((item) => {
    const itemPayload = toRecord(item.payload);
    return itemPayload.launch_generation === input.launchGeneration
      || (!itemPayload.launch_generation && itemPayload.publish_at === input.publishAt);
  });
  if (exactTerminal) return exactTerminal;
  if (!input.allowLegacyVideoFallback) return null;

  const { data, error } = await db
    .from("work_items")
    .select("id,status,payload")
    .eq("payload->>video_id", input.videoId)
    .eq("payload->>relation_type", input.relationType)
    .order("created_at", { ascending: false });

  if (error) throw error;
  const legacyItems = ((data || []) as WorkItemRow[]).filter((item) => !toRecord(item.payload).source_video_pipeline_item_id);
  const legacyOpen = legacyItems.filter((item) => !TERMINAL_WORK_STATUSES.has(item.status));
  if (legacyOpen.length > 1) throw new Error(`Duplicate open legacy YouTube launch work for ${input.relationType}`);
  if (legacyOpen[0]) return legacyOpen[0];
  return legacyItems.find((item) => {
    const itemPayload = toRecord(item.payload);
    return itemPayload.launch_generation === input.launchGeneration
      || (!itemPayload.launch_generation && itemPayload.publish_at === input.publishAt);
  }) || null;
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
  playlistContextUrl: string | null;
  playlistId: string | null;
  publishAt: string;
  launchGeneration: string;
  requestedBy: string;
  allowLegacyVideoFallback: boolean;
}) {
  const now = new Date().toISOString();
  const existing = await findExistingWorkItemByVideoRelation(db, {
    videoPipelineItemId: common.videoPipelineItemId,
    videoId: common.videoId,
    relationType: spec.relationType,
    launchGeneration: common.launchGeneration,
    publishAt: common.publishAt,
    allowLegacyVideoFallback: common.allowLegacyVideoFallback,
  });
  const payload = {
    ...reusablePayloadForLaunchGeneration(toRecord(existing?.payload), common.launchGeneration),
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
    playlist_context_url: common.playlistContextUrl,
    playlist_id: common.playlistId,
    publish_at: common.publishAt,
    launch_generation: common.launchGeneration,
    newsletter_scope: "excluded_v1",
    ...(spec.payloadExtra || {}),
  };

  if (existing?.id) {
    if (existing.status === "in_progress") {
      throw new Error("Cannot reschedule a YouTube launch while launch work is in_progress");
    }
    if (TERMINAL_WORK_STATUSES.has(existing.status)) {
      await mapWorkItem(db, spec.mapPipelineItemId, existing.id, spec.mapRelationType);
      return { workItem: existing, created: false, updated: false, skipped: true };
    }

    const { data, error } = await db
      .from("work_items")
      .update({
        title: spec.title,
        instruction: spec.instruction,
        status: "ready",
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
  requireCommunityPlaylistContextUrl(context.videoId, context.playlistContextUrl);
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
    launchGeneration: context.launchGeneration || null,
    playlistContextUrl: context.playlistContextUrl || null,
  };
  const preflightAt = maxIsoDate(addMinutes(context.publishAt, -30), preparedAt);
  const approvalReminderAt = maxIsoDate(addMinutes(context.publishAt, -60), preparedAt);
  const baseLaunchPayload = {
    launch_state_contract: "scheduled_launch_v2",
    launch_generation: context.launchGeneration || null,
    notify_project_thread: false,
    suppress_task_router_webhook: true,
    completion_log_destination: "responsible_agent_private_channel",
    failure_alert_destination: "responsible_agent_private_channel",
  };
  const draftGatePayload = {
    ...baseLaunchPayload,
    prepublication_draft_authorized: true,
    public_gate_applies_to: "publish_or_send_only",
    requires_gonza_approval: true,
    customer_facing_guard: false,
  };
  const publicActionGatePayload = {
    ...baseLaunchPayload,
    customer_facing_guard: true,
    public_gate_applies_to: "activation_only",
    requires_preflight_passed: true,
    preflight_relation_type: "youtube_launch_preflight",
    requires_live_check_passed: true,
    live_check_relation_type: "video_launch_activate",
  };

  const specs: ScheduledYouTubeLaunchWorkSpec[] = [
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
      payloadExtra: {
        ...baseLaunchPayload,
        launch_step: "preflight",
        t_minus_minutes: 30,
        scheduled_preflight_at: addMinutes(context.publishAt, -30),
        playlist_context_url: context.playlistContextUrl || null,
        preflight_validates: [
          "canonical_video_identity",
          "scheduled_visibility",
          "required_playlist_membership",
          "gonza_approvals",
          "runtime_health",
        ],
      },
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
      payloadExtra: {
        ...baseLaunchPayload,
        launch_step: "live_check",
        customer_facing_guard: true,
        public_gate_applies_to: "activation_only",
        requires_preflight_passed: true,
        preflight_relation_type: "youtube_launch_preflight",
        playlist_context_url: context.playlistContextUrl || null,
      },
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
          playlist_context_url_required: true,
          raw_unwrapped_youtube_url_required: true,
          fail_if_final_copy_ends_with_bare_watch_url_when_playlist_exists: true,
        },
      },
    },
    {
      relationType: "community_approval_reminder",
      mapRelationType: "followup",
      mapPipelineItemId: communityPipelineItemId,
      sourcePipelineItemId: communityPipelineItemId,
      pipelineType: "community_post",
      title: `Reminder: approve community launch copy: ${context.title}`,
      instruction: approvalReminderInstruction({
        ...context,
        artifact: "community announcement",
        privateChannelId: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.community,
        approvalPath: "community_post.metadata.review.status or metadata.schedule.approved_by",
      }),
      ownerAgent: "community",
      action: "launch_approval_reminder",
      scheduledFor: approvalReminderAt,
      payloadExtra: {
        ...baseLaunchPayload,
        launch_step: "community_approval_reminder",
        approval_target_relation_type: "launch_community_draft",
        approval_target_pipeline_item_id: communityPipelineItemId,
        private_director_channel_id: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.community,
        completion_log_destination: "responsible_agent_private_channel",
        suppress_task_router_webhook: true,
        requires_gonza_approval: true,
        reminder_deadline: addMinutes(context.publishAt, -60),
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
        youtube_pinned_comment_publishing: "manual_out_of_scope",
        auto_publish_forbidden: true,
        playlist_context_url: context.playlistContextUrl || null,
        cta: context.cta || null,
      },
    },
    {
      relationType: "pinned_comment_approval_reminder",
      mapRelationType: "followup",
      mapPipelineItemId: pinnedCommentPipelineItemId,
      sourcePipelineItemId: pinnedCommentPipelineItemId,
      pipelineType: "youtube_pinned_comment",
      title: `Reminder: review pinned comment draft: ${context.title}`,
      instruction: approvalReminderInstruction({
        ...context,
        artifact: "pinned comment draft",
        privateChannelId: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.youtube,
        approvalPath: "youtube_pinned_comment.metadata.review.status; publishing remains manual/out of scope",
      }),
      ownerAgent: "youtube",
      action: "launch_approval_reminder",
      scheduledFor: approvalReminderAt,
      payloadExtra: {
        ...baseLaunchPayload,
        launch_step: "pinned_comment_approval_reminder",
        approval_target_relation_type: "youtube_pinned_comment_draft",
        approval_target_pipeline_item_id: pinnedCommentPipelineItemId,
        private_director_channel_id: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.youtube,
        completion_log_destination: "responsible_agent_private_channel",
        suppress_task_router_webhook: true,
        requires_gonza_approval: true,
        approval_manual_out_of_scope: true,
        youtube_pinned_comment_publishing: "manual_out_of_scope",
        auto_publish_forbidden: true,
        reminder_deadline: addMinutes(context.publishAt, -60),
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
      payloadExtra: {
        launch_step: "website_publish",
        ...publicActionGatePayload,
        ...launchRetryContract(context, "website_publish_video", "aipaths_website"),
        playlist_context_url: context.playlistContextUrl || null,
      },
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
      relationType: "marketing_approval_reminder",
      mapRelationType: "followup",
      mapPipelineItemId: marketingPipelineItemId,
      sourcePipelineItemId: marketingPipelineItemId,
      pipelineType: "email_campaign",
      title: `Reminder: approve launch email: ${context.title}`,
      instruction: approvalReminderInstruction({
        ...context,
        artifact: "email campaign",
        privateChannelId: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.marketing,
        approvalPath: "email_campaign.metadata.review.status",
      }),
      ownerAgent: "marketing",
      action: "launch_approval_reminder",
      scheduledFor: approvalReminderAt,
      payloadExtra: {
        ...baseLaunchPayload,
        launch_step: "marketing_approval_reminder",
        approval_target_relation_type: "marketing_email_campaign",
        approval_target_pipeline_item_id: marketingPipelineItemId,
        private_director_channel_id: YOUTUBE_LAUNCH_RESPONSIBLE_PRIVATE_CHANNELS.marketing,
        completion_log_destination: "responsible_agent_private_channel",
        suppress_task_router_webhook: true,
        requires_gonza_approval: true,
        reminder_deadline: addMinutes(context.publishAt, -60),
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
  return specs.map((spec) => ({
    ...spec,
    payloadExtra: {
      ...baseLaunchPayload,
      ...(spec.payloadExtra || {}),
      private_director_channel_id: privateChannelForAgent(spec.ownerAgent),
      log_channel_id: privateChannelForAgent(spec.ownerAgent),
      playlist_id: context.playlistId || null,
    },
  }));
}

export async function createScheduledYouTubeLaunchPackage(db: SupabaseClient, input: YouTubeLaunchPackageInput) {
  const publishAt = normalizeIsoDate(input.publishAt, "publish_at");
  const pipelineItemId = trimToNull(input.pipelineItemId);
  const videoId = trimToNull(input.videoId) || extractYouTubeVideoId(input.youtubeUrl);
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) throw new Error("A valid YouTube video_id or URL is required");
  const suppliedYoutubeUrl = trimToNull(input.youtubeUrl);
  if (suppliedYoutubeUrl && extractYouTubeVideoId(suppliedYoutubeUrl) !== videoId) {
    throw new Error("YouTube URL must use HTTPS on youtube.com, a youtube.com subdomain, or youtu.be and match video_id");
  }
  const youtubeUrl = suppliedYoutubeUrl || youtubeWatchUrl(videoId);
  const title = trimToNull(input.title) || `Scheduled YouTube video ${videoId}`;
  const requestedBy = trimToNull(input.requestedBy) || "mission-control";
  const preparedAt = input.preparedAt ? normalizeIsoDate(input.preparedAt, "prepared_at") : new Date().toISOString();
  const targetCommunityPublishAt = addMinutes(publishAt, 30);
  const refs = toRecord(input.refs);
  const existingVideoContext = pipelineItemId
    ? await findExactVideoItem(db, pipelineItemId)
    : await findExistingVideoItem(db, videoId, youtubeUrl);
  const existingVideoMetadata = toRecord(existingVideoContext?.metadata);
  const playlistContextUrl =
    resolveYouTubePlaylistContextUrl(videoId, input.playlistContextUrl, { allowPlaylistOnly: true }) ||
    firstPlaylistContextUrlFromRecords(videoId, [refs], [
      ["playlist_context_url"],
      ["playlistContextUrl"],
      ["playlist_url"],
      ["playlistUrl"],
      ["playlist", "context_url"],
      ["playlist", "url"],
      ["source", "playlist_context_url"],
      ["source", "playlist_url"],
    ], { allowPlaylistOnly: true }) ||
    firstPlaylistContextUrlFromRecords(videoId, [existingVideoMetadata], [
      ["launch_package", "playlist_context_url"],
      ["launch_package", "playlist_url"],
      ["source", "playlist_context_url"],
      ["source", "playlist_url"],
      ["youtube_v0", "playlist_context_url"],
      ["youtube_v0", "playlist_url"],
      ["publication", "playlist_context_url"],
      ["publication", "playlist_url"],
    ], { allowPlaylistOnly: true }) ||
    resolveYouTubePlaylistContextUrl(videoId, youtubeUrl) ||
    resolveYouTubePlaylistContextUrl(videoId, trimToNull(input.playlistId) || firstStringFromRecords([refs], [["playlist_id"], ["playlistId"], ["playlist", "id"]]), { allowRawPlaylistId: true });
  requireCommunityPlaylistContextUrl(videoId, playlistContextUrl);
  const playlistId = playlistIdFromContextUrl(videoId, playlistContextUrl);
  const targetEmailSendAt = input.targetEmailSendAt ? normalizeIsoDate(input.targetEmailSendAt, "target_email_send_at") : addMilliseconds(publishAt, 3 * 60 * 60 * 1000);
  const emailTrackingRef = trimToNull(input.emailTrackingRef) || `email-youtube-${videoId}`;
  const optionalDiagnosticCta = trimToNull(input.optionalDiagnosticCta) || firstStringFromRecords([refs], [["optional_diagnostic_cta"], ["diagnostic_cta"]]);
  const cta = trimToNull(input.cta) || firstStringFromRecords([refs], [["cta"], ["community", "cta"]]);
  const launchGeneration = reusableLaunchGenerationFromMetadata({
    videoItem: existingVideoContext,
    videoId,
    publishAt,
  }) || newLaunchGeneration(videoId, publishAt);

  const video = await ensureVideoPipelineItem(db, {
    pipelineItemId,
    launchGeneration,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    playlistId,
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
    launchGeneration,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    targetPublishAt: targetCommunityPublishAt,
    playlistContextUrl,
    playlistId,
    cta,
    requestedBy,
  });

  const marketing = await ensureMarketingEmailPipelineItem(db, {
    videoItem: video.item,
    launchGeneration,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    playlistId,
    targetSendAt: targetEmailSendAt,
    emailTrackingRef,
    optionalDiagnosticCta,
    requestedBy,
  });

  const pinnedComment = await ensurePinnedCommentPipelineItem(db, {
    videoItem: video.item,
    launchGeneration,
    title,
    youtubeUrl,
    videoId,
    publishAt,
    playlistContextUrl,
    playlistId,
    cta,
    requestedBy,
  });

  const common = {
    videoId,
    videoPipelineItemId: video.item.id,
    youtubeUrl,
    playlistContextUrl,
    playlistId,
    publishAt,
    launchGeneration,
    requestedBy,
    allowLegacyVideoFallback: !pipelineItemId,
  };
  const specs = buildScheduledYouTubeLaunchWorkSpecs({
    title,
    youtubeUrl,
    videoId,
    publishAt,
    launchGeneration,
    playlistContextUrl,
    playlistId,
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
  const activationWorkItemId = workItems.find((entry) => entry.relationType === "video_launch_activate")?.workItem?.id;
  if (!activationWorkItemId || workItems.length !== 12) {
    throw new Error("YouTube launch package did not reconcile exactly twelve current work items");
  }
  const { data: activationRows, error: activationError } = await db
    .from("work_items")
    .select("id,status,source_type,source_id,payload")
    .eq("payload->>source_video_pipeline_item_id", video.item.id)
    .eq("payload->>relation_type", "video_launch_activate")
    .order("created_at", { ascending: false });
  if (activationError) throw activationError;
  const openActivations = ((activationRows || []) as Array<WorkItemRow & { source_type?: string | null; source_id?: string | null }>)
    .filter((row) => !TERMINAL_WORK_STATUSES.has(row.status));
  const currentActivation = openActivations[0];
  const currentActivationPayload = toRecord(currentActivation?.payload);
  if (openActivations.length !== 1
    || currentActivation?.id !== activationWorkItemId
    || currentActivation?.source_type !== "pipeline_item"
    || currentActivation?.source_id !== video.item.id
    || currentActivationPayload.trigger !== "youtube_launch_package_v1"
    || currentActivationPayload.action !== "video_launch_activate"
    || currentActivationPayload.pipeline_item_id !== video.item.id
    || currentActivationPayload.source_video_pipeline_item_id !== video.item.id
    || currentActivationPayload.launch_generation !== launchGeneration
    || currentActivationPayload.publish_at !== publishAt) {
    throw new Error("YouTube launch package requires exactly one valid open current-generation activation");
  }
  const finalizedMetadata = {
    ...toRecord(video.item.metadata),
    launch_package: {
      ...toRecord(toRecord(video.item.metadata).launch_package),
      launch_generation: launchGeneration,
      activation_work_item_id: activationWorkItemId,
      launch_state: "awaiting_approval",
    },
  };
  const { data: finalizedVideoItem, error: finalizeError } = await db
    .from("pipeline_items")
    .update({ metadata: finalizedMetadata, updated_at: new Date().toISOString() })
    .eq("id", video.item.id)
    .select("*")
    .single();
  if (finalizeError) throw finalizeError;
  video.item = finalizedVideoItem as PipelineItemRow;

  await db.from("pipeline_events").insert({
    pipeline_item_id: video.item.id,
    event_type: "pipeline_item.youtube_launch_package_prepared",
    actor: requestedBy,
    payload: {
      video_id: videoId,
      youtube_url: youtubeUrl,
      playlist_id: playlistId,
      playlist_context_url: playlistContextUrl,
      publish_at: publishAt,
      launch_generation: launchGeneration,
      activation_work_item_id: activationWorkItemId,
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
    playlistId,
    youtubeUrl,
    videoId,
    workItems,
  };
}
