import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { normalizeRow } from "@/lib/db/mission-control";
import { withTransaction } from "@/lib/db/postgres";
import {
  buildScheduledYouTubeLaunchWorkSpecs,
  extractYouTubeVideoId,
  firstPlaylistContextUrlFromRecords,
  requireCommunityPlaylistContextUrl,
  resolveYouTubePlaylistContextUrl,
  youtubeWatchUrl,
  type JsonRecord,
  type ScheduledYouTubeLaunchWorkSpec,
  type YouTubeLaunchPackageInput,
} from "@/lib/youtube-launch-package";

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

const PIPELINE_ITEM_COLUMNS = `
  id, title, pipeline_type, status, priority, owner_agent, requested_by,
  source_type, source_id, scheduled_for, published_at, current_url, content_path,
  content_format, metadata, created_at, updated_at
`;
const WORK_ITEM_COLUMNS = "id, status, payload";
const TERMINAL_WORK_STATUSES = new Set(["done", "failed", "canceled", "cancelled"]);

function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export class GovernedPlaylistValidationError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "GovernedPlaylistValidationError";
    this.status = status;
  }
}

function valueAtPath(record: JsonRecord, path: string[]) {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonRecord)[key];
  }
  return trimToNull(current);
}

function governedPlaylistIdFromCandidate(value: unknown, allowRawPlaylistId = false) {
  const raw = trimToNull(value);
  if (!raw) return null;
  if (allowRawPlaylistId && /^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || (host !== "youtu.be" && host !== "youtube.com" && !host.endsWith(".youtube.com"))) return null;
    const playlistId = trimToNull(url.searchParams.get("list"));
    return playlistId && /^[a-zA-Z0-9_-]+$/.test(playlistId) ? playlistId : null;
  } catch {
    return null;
  }
}

function assertGovernedCandidate(input: {
  value: unknown;
  selectedPlaylistId: string;
  label: string;
  allowRawPlaylistId?: boolean;
  existingState?: boolean;
}) {
  const raw = trimToNull(input.value);
  if (!raw) return;
  const candidatePlaylistId = governedPlaylistIdFromCandidate(raw, input.allowRawPlaylistId);
  if (!candidatePlaylistId || candidatePlaylistId !== input.selectedPlaylistId) {
    throw new GovernedPlaylistValidationError(
      `${input.existingState ? "Existing scheduled launch" : input.label} conflicts with governed playlist_id ${input.selectedPlaylistId}`,
      input.existingState ? 409 : 400,
    );
  }
}

async function lockGovernedPlaylist(client: PoolClient, playlistId: string | null) {
  if (!playlistId || !/^[a-zA-Z0-9_-]+$/.test(playlistId)) {
    throw new GovernedPlaylistValidationError("playlist_id is required for governed YouTube launches");
  }
  const result = await client.query(
    `select playlist_id
       from public.youtube_playlists
      where playlist_id = $1
        and status = 'active'
        and kind in ('hub', 'official_series')
      for share`,
    [playlistId],
  );
  if (result.rowCount !== 1) {
    throw new GovernedPlaylistValidationError(
      "playlist_id must reference exactly one active eligible playlist in the governed YouTube catalog",
    );
  }
  return String(result.rows[0].playlist_id);
}

function assertGovernedPlaylistInputs(input: {
  launchInput: YouTubeLaunchPackageInput;
  refs: JsonRecord;
  youtubeUrl: string;
  selectedPlaylistId: string;
  existingVideoMetadata: JsonRecord;
}) {
  assertGovernedCandidate({
    value: input.launchInput.playlistContextUrl,
    selectedPlaylistId: input.selectedPlaylistId,
    label: "playlist_context_url",
  });
  const refIdPaths = [["playlist_id"], ["playlistId"], ["playlist", "id"]];
  const refUrlPaths = [
    ["playlist_context_url"], ["playlistContextUrl"], ["playlist_url"], ["playlistUrl"],
    ["playlist", "context_url"], ["playlist", "url"],
    ["source", "playlist_context_url"], ["source", "playlist_url"],
  ];
  for (const path of refIdPaths) {
    assertGovernedCandidate({
      value: valueAtPath(input.refs, path),
      selectedPlaylistId: input.selectedPlaylistId,
      label: `refs.${path.join(".")}`,
      allowRawPlaylistId: true,
    });
  }
  for (const path of refUrlPaths) {
    assertGovernedCandidate({
      value: valueAtPath(input.refs, path),
      selectedPlaylistId: input.selectedPlaylistId,
      label: `refs.${path.join(".")}`,
    });
  }
  const youtubePlaylistId = governedPlaylistIdFromCandidate(input.youtubeUrl);
  if (youtubePlaylistId && youtubePlaylistId !== input.selectedPlaylistId) {
    throw new GovernedPlaylistValidationError(
      `youtube_url conflicts with governed playlist_id ${input.selectedPlaylistId}`,
    );
  }

  const existingLaunch = toRecord(input.existingVideoMetadata.launch_package);
  if (existingLaunch.kind === "scheduled_youtube_launch_package_v1" && existingLaunch.status === "scheduled") {
    const existingIdPaths = [
      ["launch_package", "playlist_id"],
      ["youtube_v0", "playlist_id"],
      ["publication", "playlist_id"],
      ["source", "playlist_id"],
    ];
    const existingUrlPaths = [
      ["launch_package", "playlist_context_url"], ["launch_package", "playlist_url"],
      ["youtube_v0", "playlist_context_url"], ["youtube_v0", "playlist_url"],
      ["publication", "playlist_context_url"], ["publication", "playlist_url"],
      ["source", "playlist_context_url"], ["source", "playlist_url"],
    ];
    for (const path of existingIdPaths) {
      assertGovernedCandidate({
        value: valueAtPath(input.existingVideoMetadata, path),
        selectedPlaylistId: input.selectedPlaylistId,
        label: `existing metadata.${path.join(".")}`,
        allowRawPlaylistId: true,
        existingState: true,
      });
    }
    for (const path of existingUrlPaths) {
      assertGovernedCandidate({
        value: valueAtPath(input.existingVideoMetadata, path),
        selectedPlaylistId: input.selectedPlaylistId,
        label: `existing metadata.${path.join(".")}`,
        existingState: true,
      });
    }
    for (const path of [
      ["launch_package", "youtube_url"],
      ["youtube_v0", "youtube_url"],
      ["publication", "youtube_url"],
    ]) {
      const existingYoutubePlaylistId = governedPlaylistIdFromCandidate(valueAtPath(input.existingVideoMetadata, path));
      if (existingYoutubePlaylistId && existingYoutubePlaylistId !== input.selectedPlaylistId) {
        throw new GovernedPlaylistValidationError(
          `Existing scheduled launch conflicts with governed playlist_id ${input.selectedPlaylistId}`,
          409,
        );
      }
    }
  }
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

function pipelineItem(row: unknown) {
  return normalizeRow(row) as PipelineItemRow;
}

function workItem(row: unknown) {
  return normalizeRow(row) as WorkItemRow;
}

async function findExistingVideoItem(client: PoolClient, videoId: string, youtubeUrl: string) {
  const selectors: Array<{ expression: string; value: string }> = [
    { expression: "metadata -> 'launch_package' ->> 'video_id'", value: videoId },
    { expression: "metadata -> 'youtube_v0' ->> 'video_id'", value: videoId },
    { expression: "metadata -> 'publication' ->> 'video_id'", value: videoId },
    { expression: "current_url", value: youtubeUrl },
  ];

  for (const selector of selectors) {
    const result = await client.query(
      `select ${PIPELINE_ITEM_COLUMNS}
         from public.pipeline_items
        where pipeline_type = 'video'
          and ${selector.expression} = $1
        order by updated_at desc nulls last
        limit 1`,
      [selector.value],
    );
    if (result.rows[0]) return pipelineItem(result.rows[0]);
  }

  return null;
}

async function findExactVideoItem(client: PoolClient, pipelineItemId: string, forUpdate = true) {
  const result = await client.query(
    `select ${PIPELINE_ITEM_COLUMNS}
       from public.pipeline_items
      where id = $1
      ${forUpdate ? "for update" : ""}`,
    [pipelineItemId],
  );
  if (!result.rows[0]) throw new Error("Video pipeline item not found");
  const item = pipelineItem(result.rows[0]);
  if (item.pipeline_type !== "video") throw new Error("pipelineItemId must reference a video pipeline item");
  return item;
}

type LockedLaunchWorkItem = WorkItemRow & { source_type?: string | null; source_id?: string | null };

/**
 * Lock-order contract: every YouTube reschedule locks all launch work rows in
 * stable id order before locking its parent pipeline row. Agent completion
 * already locks work -> pipeline, so reversing this order here would deadlock.
 */
async function lockLaunchWorkBeforePipeline(client: PoolClient, input: {
  videoPipelineItemId: string | null;
  videoId: string;
}) {
  const result = await client.query(
    `select id, status, payload, source_type, source_id
       from public.work_items
      where (payload ->> 'trigger' = 'youtube_launch_package_v1'
          or payload ->> 'schedule_kind' = 'youtube_launch_package')
        and (
          ($1::text is not null and payload ->> 'source_video_pipeline_item_id' = $1)
          or (payload ->> 'video_id' = $2 and payload ->> 'source_video_pipeline_item_id' is null)
        )
      order by id
      for update`,
    [input.videoPipelineItemId, input.videoId],
  );
  const rows = result.rows.map((row) => workItem(row) as LockedLaunchWorkItem);
  if (rows.some((row) => row.status === "in_progress")) {
    throw new Error("Cannot reschedule a YouTube launch while launch work is in_progress");
  }
  return rows;
}

function currentGenerationCanBeReused(input: {
  videoItem: PipelineItemRow | null;
  launchWork: LockedLaunchWorkItem[];
  videoId: string;
  publishAt: string;
}) {
  if (!input.videoItem || input.videoItem.published_at || input.videoItem.status !== "scheduled") return null;
  const launch = toRecord(toRecord(input.videoItem.metadata).launch_package);
  const generation = trimToNull(launch.launch_generation);
  const activationId = trimToNull(launch.activation_work_item_id);
  if (launch.kind !== "scheduled_youtube_launch_package_v1"
    || launch.status !== "scheduled"
    || launch.video_id !== input.videoId
    || launch.publish_at !== input.publishAt
    || !generation
    || !activationId) return null;

  const openActivations = input.launchWork.filter((row) => {
    const payload = toRecord(row.payload);
    return !TERMINAL_WORK_STATUSES.has(row.status)
      && payload.relation_type === "video_launch_activate"
      && payload.source_video_pipeline_item_id === input.videoItem?.id;
  });
  if (openActivations.length !== 1 || openActivations[0].id !== activationId) return null;
  const activation = openActivations[0];
  const payload = toRecord(activation.payload);
  if (payload.trigger !== "youtube_launch_package_v1"
    || payload.action !== "video_launch_activate"
    || payload.pipeline_type !== "video"
    || payload.pipeline_item_id !== input.videoItem.id
    || payload.source_video_pipeline_item_id !== input.videoItem.id
    || payload.launch_generation !== generation
    || payload.publish_at !== input.publishAt
    || activation.source_type !== "pipeline_item"
    || activation.source_id !== input.videoItem.id) return null;
  return generation;
}

function newLaunchGeneration(videoId: string, publishAt: string) {
  return `youtube-launch-v1:${videoId}:${publishAt}:${randomUUID()}`;
}

async function ensureVideoPipelineItem(client: PoolClient, input: {
  pipelineItemId: string | null;
  launchGeneration: string;
  publishAt: string;
  requestedBy: string;
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
    ? await findExactVideoItem(client, input.pipelineItemId)
    : await findExistingVideoItem(client, input.videoId, input.youtubeUrl);
  const existingMetadata = toRecord(existing?.metadata);
  const existingLaunchPackage = toRecord(existingMetadata.launch_package);
  const existingYoutubeV0 = toRecord(existingMetadata.youtube_v0);
  const existingPublication = toRecord(existingMetadata.publication);
  if (existing && (Boolean(existing.published_at) || !["recorded", "editing", "scheduled"].includes(existing.status))) {
    throw new Error(`Cannot schedule video in ${existing.status || "unknown"} state`);
  }
  const launchPackage = {
    ...existingLaunchPackage,
    kind: "scheduled_youtube_launch_package_v1",
    status: "scheduled",
    launch_generation: input.launchGeneration,
    newsletter_scope: "excluded_v1",
    video_id: input.videoId,
    youtube_url: input.youtubeUrl,
    playlist_context_url: input.playlistContextUrl,
    playlist_id: input.playlistId,
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
      playlist_id: input.playlistId,
      scheduled_publish_at: input.publishAt,
      stage: "scheduled",
      launch_package_status: "scheduled",
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
    const result = await client.query(
      `update public.pipeline_items
          set title = $1,
              status = $2,
              owner_agent = $3,
              requested_by = $4,
              scheduled_for = $5,
              current_url = $6,
              metadata = $7::jsonb,
              updated_at = $8
        where id = $9
        returning ${PIPELINE_ITEM_COLUMNS}`,
      [
        input.title || existing.title,
        "scheduled",
        existing.owner_agent || "youtube",
        existing.requested_by || input.requestedBy,
        input.publishAt,
        null,
        JSON.stringify(metadata),
        now,
        existing.id,
      ],
    );
    return { item: pipelineItem(result.rows[0]), created: false };
  }

  const result = await client.query(
    `insert into public.pipeline_items (
       pipeline_type, title, status, priority, owner_agent, requested_by, source_type,
       source_id, scheduled_for, content_format, metadata, updated_at
     ) values ('video', $1, 'scheduled', 'high', 'youtube', $2, 'service', $3, $4, 'youtube_url', $5::jsonb, $6)
     returning ${PIPELINE_ITEM_COLUMNS}`,
    [input.title, input.requestedBy, `youtube:${input.videoId}`, input.publishAt, JSON.stringify(metadata), now],
  );
  return { item: pipelineItem(result.rows[0]), created: true };
}

async function ensureCommunityPipelineItem(client: PoolClient, input: {
  videoItem: PipelineItemRow;
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
  const existingResult = await client.query(
    `select ${PIPELINE_ITEM_COLUMNS}
       from public.pipeline_items
      where pipeline_type = 'community_post'
        and metadata -> 'source' ->> 'video_id' = $1
      order by updated_at desc nulls last
      limit 1`,
    [input.videoId],
  );
  const existing = existingResult.rows[0] ? pipelineItem(existingResult.rows[0]) : null;
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
      playlist_id: input.playlistId,
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
      playlist_id: input.playlistId,
      publish_at: input.publishAt,
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
    const result = await client.query(
      `update public.pipeline_items
          set title = $1, status = $2, owner_agent = 'community', requested_by = $3,
              source_type = 'manual', source_id = $4, metadata = $5::jsonb, updated_at = $6
        where id = $7
        returning ${PIPELINE_ITEM_COLUMNS}`,
      [
        `Announce video: ${input.title}`,
        TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "draft",
        existing.requested_by || input.requestedBy,
        input.videoItem.id,
        JSON.stringify(metadata),
        now,
        existing.id,
      ],
    );
    return { item: pipelineItem(result.rows[0]), created: false };
  }

  const result = await client.query(
    `insert into public.pipeline_items (
       pipeline_type, title, status, priority, owner_agent, requested_by, source_type, source_id, metadata, updated_at
     ) values ('community_post', $1, 'draft', $2, 'community', $3, 'manual', $4, $5::jsonb, $6)
     returning ${PIPELINE_ITEM_COLUMNS}`,
    [`Announce video: ${input.title}`, input.videoItem.priority || "high", input.requestedBy, input.videoItem.id, JSON.stringify(metadata), now],
  );
  return { item: pipelineItem(result.rows[0]), created: true };
}

async function findExistingMarketingItem(client: PoolClient, videoId: string, videoPipelineItemId: string) {
  const selectors: Array<{ expression: string; value: string }> = [
    { expression: "metadata -> 'source' ->> 'video_id'", value: videoId },
    { expression: "metadata ->> 'video_id'", value: videoId },
    { expression: "metadata -> 'launch_package' ->> 'video_id'", value: videoId },
    { expression: "source_id", value: videoPipelineItemId },
  ];
  for (const selector of selectors) {
    const result = await client.query(
      `select ${PIPELINE_ITEM_COLUMNS}
         from public.pipeline_items
        where pipeline_type = 'email_campaign'
          and ${selector.expression} = $1
        order by updated_at desc nulls last
        limit 1`,
      [selector.value],
    );
    if (result.rows[0]) return pipelineItem(result.rows[0]);
  }
  return null;
}

async function ensureMarketingEmailPipelineItem(client: PoolClient, input: {
  videoItem: PipelineItemRow;
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
  const existing = await findExistingMarketingItem(client, input.videoId, input.videoItem.id);
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
      playlist_id: input.playlistId,
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
      playlist_id: input.playlistId,
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
    const result = await client.query(
      `update public.pipeline_items
          set title = $1, status = $2, owner_agent = 'marketing', requested_by = $3,
              source_type = 'manual', source_id = $4, scheduled_for = $5,
              metadata = $6::jsonb, updated_at = $7
        where id = $8
        returning ${PIPELINE_ITEM_COLUMNS}`,
      [
        `Email announcement: ${input.title}`,
        TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "sent" ? existing.status : existing.status || "drafting",
        existing.requested_by || input.requestedBy,
        input.videoItem.id,
        input.targetSendAt,
        JSON.stringify(metadata),
        now,
        existing.id,
      ],
    );
    return { item: pipelineItem(result.rows[0]), created: false };
  }

  const result = await client.query(
    `insert into public.pipeline_items (
       pipeline_type, title, status, priority, owner_agent, requested_by, source_type,
       source_id, scheduled_for, metadata, updated_at
     ) values ('email_campaign', $1, 'drafting', $2, 'marketing', $3, 'manual', $4, $5, $6::jsonb, $7)
     returning ${PIPELINE_ITEM_COLUMNS}`,
    [
      `Email announcement: ${input.title}`,
      input.videoItem.priority || "high",
      input.requestedBy,
      input.videoItem.id,
      input.targetSendAt,
      JSON.stringify(metadata),
      now,
    ],
  );
  return { item: pipelineItem(result.rows[0]), created: true };
}

async function ensurePinnedCommentPipelineItem(client: PoolClient, input: {
  videoItem: PipelineItemRow;
  title: string;
  youtubeUrl: string;
  videoId: string;
  publishAt: string;
  playlistContextUrl: string | null;
  playlistId: string | null;
  cta: string | null;
  requestedBy: string;
}) {
  const existingResult = await client.query(
    `select ${PIPELINE_ITEM_COLUMNS}
       from public.pipeline_items
      where pipeline_type = 'youtube_pinned_comment'
        and metadata -> 'launch_package' ->> 'video_id' = $1
      order by updated_at desc nulls last
      limit 1`,
    [input.videoId],
  );
  const existing = existingResult.rows[0] ? pipelineItem(existingResult.rows[0]) : null;
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
      playlist_id: input.playlistId,
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
      playlist_id: input.playlistId,
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
    const result = await client.query(
      `update public.pipeline_items
          set title = $1, status = $2, owner_agent = 'youtube', requested_by = $3,
              source_type = 'manual', source_id = $4, metadata = $5::jsonb, updated_at = $6
        where id = $7
        returning ${PIPELINE_ITEM_COLUMNS}`,
      [
        `Pinned comment draft: ${input.title}`,
        TERMINAL_WORK_STATUSES.has(existing.status) || existing.status === "published" ? existing.status : existing.status || "drafting",
        existing.requested_by || input.requestedBy,
        input.videoItem.id,
        JSON.stringify(metadata),
        now,
        existing.id,
      ],
    );
    return { item: pipelineItem(result.rows[0]), created: false };
  }

  const result = await client.query(
    `insert into public.pipeline_items (
       pipeline_type, title, status, priority, owner_agent, requested_by, source_type, source_id, metadata, updated_at
     ) values ('youtube_pinned_comment', $1, 'drafting', $2, 'youtube', $3, 'manual', $4, $5::jsonb, $6)
     returning ${PIPELINE_ITEM_COLUMNS}`,
    [`Pinned comment draft: ${input.title}`, input.videoItem.priority || "high", input.requestedBy, input.videoItem.id, JSON.stringify(metadata), now],
  );
  return { item: pipelineItem(result.rows[0]), created: true };
}

async function findExistingWorkItemByVideoRelation(client: PoolClient, input: {
  videoPipelineItemId: string;
  videoId: string;
  relationType: string;
  launchGeneration: string;
  publishAt: string;
  allowLegacyVideoFallback: boolean;
}) {
  const exact = await client.query(
    `select ${WORK_ITEM_COLUMNS}
       from public.work_items
      where payload ->> 'source_video_pipeline_item_id' = $1
        and payload ->> 'relation_type' = $2
      order by created_at desc`,
    [input.videoPipelineItemId, input.relationType],
  );
  const exactItems = exact.rows.map(workItem);
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

  const legacy = await client.query(
    `select ${WORK_ITEM_COLUMNS}
       from public.work_items
      where payload ->> 'video_id' = $1
        and payload ->> 'relation_type' = $2
        and payload ->> 'source_video_pipeline_item_id' is null
      order by created_at desc`,
    [input.videoId, input.relationType],
  );
  const legacyItems = legacy.rows.map(workItem);
  const legacyOpen = legacyItems.filter((item) => !TERMINAL_WORK_STATUSES.has(item.status));
  if (legacyOpen.length > 1) throw new Error(`Duplicate open legacy YouTube launch work for ${input.relationType}`);
  if (legacyOpen[0]) return legacyOpen[0];
  return legacyItems.find((item) => {
    const itemPayload = toRecord(item.payload);
    return itemPayload.launch_generation === input.launchGeneration
      || (!itemPayload.launch_generation && itemPayload.publish_at === input.publishAt);
  }) || null;
}

async function mapWorkItem(client: PoolClient, pipelineItemId: string, workItemId: string, relationType: string) {
  await client.query(
    `insert into public.pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     values ($1, $2, $3)
     on conflict (pipeline_item_id, work_item_id, relation_type) do nothing`,
    [pipelineItemId, workItemId, relationType],
  );
}

async function upsertLaunchWorkItem(client: PoolClient, spec: ScheduledYouTubeLaunchWorkSpec, common: {
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
  const existing = await findExistingWorkItemByVideoRelation(client, {
    videoPipelineItemId: common.videoPipelineItemId,
    videoId: common.videoId,
    relationType: spec.relationType,
    launchGeneration: common.launchGeneration,
    publishAt: common.publishAt,
    allowLegacyVideoFallback: common.allowLegacyVideoFallback,
  });
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
    playlist_context_url: common.playlistContextUrl,
    playlist_id: common.playlistId,
    publish_at: common.publishAt,
    launch_generation: common.launchGeneration,
    newsletter_scope: "excluded_v1",
    ...(spec.payloadExtra || {}),
  };

  if (existing) {
    if (existing.status === "in_progress") {
      throw new Error("Cannot reschedule a YouTube launch while launch work is in_progress");
    }
    if (TERMINAL_WORK_STATUSES.has(existing.status)) {
      await mapWorkItem(client, spec.mapPipelineItemId, existing.id, spec.mapRelationType);
      return { workItem: existing, created: false, updated: false, skipped: true };
    }

    const result = await client.query(
      `update public.work_items
          set title = $1, instruction = $2, status = $3, scheduled_for = $4,
              priority = $5, owner_agent = $6, target_agent_id = $6,
              requested_by = $7, source_type = 'pipeline_item', source_id = $8,
              payload = $9::jsonb, updated_at = $10
        where id = $11
        returning ${WORK_ITEM_COLUMNS}`,
      [
        spec.title,
        spec.instruction,
        "ready",
        spec.scheduledFor,
        spec.priority || "high",
        spec.ownerAgent,
        common.requestedBy,
        spec.sourcePipelineItemId,
        JSON.stringify(payload),
        now,
        existing.id,
      ],
    );
    const updated = workItem(result.rows[0]);
    await mapWorkItem(client, spec.mapPipelineItemId, updated.id, spec.mapRelationType);
    return { workItem: updated, created: false, updated: true, skipped: false };
  }

  const result = await client.query(
    `insert into public.work_items (
       kind, source_type, source_id, title, instruction, status, scheduled_for,
       priority, owner_agent, target_agent_id, requested_by, payload
     ) values ('task', 'pipeline_item', $1, $2, $3, 'ready', $4, $5, $6, $6, $7, $8::jsonb)
     returning ${WORK_ITEM_COLUMNS}`,
    [
      spec.sourcePipelineItemId,
      spec.title,
      spec.instruction,
      spec.scheduledFor,
      spec.priority || "high",
      spec.ownerAgent,
      common.requestedBy,
      JSON.stringify(payload),
    ],
  );
  const inserted = workItem(result.rows[0]);
  await mapWorkItem(client, spec.mapPipelineItemId, inserted.id, spec.mapRelationType);
  return { workItem: inserted, created: true, updated: false, skipped: false };
}

/**
 * Postgres-first equivalent of createScheduledYouTubeLaunchPackage.
 * The advisory lock and transaction make reruns for one video atomic and prevent
 * concurrent requests from creating duplicate launch work items.
 */
export async function createScheduledYouTubeLaunchPackageLocal(input: YouTubeLaunchPackageInput) {
  const publishAt = normalizeIsoDate(input.publishAt, "publish_at");
  const pipelineItemId = trimToNull(input.pipelineItemId);
  const videoId = trimToNull(input.videoId) || extractYouTubeVideoId(input.youtubeUrl);
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error("A valid YouTube video_id or URL is required");
  }
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

  return withTransaction(async (client) => {
    const lockScopes = [`youtube-launch-package:video:${videoId}`];
    if (pipelineItemId) lockScopes.push(`youtube-launch-package:parent:${pipelineItemId}`);
    for (const lockScope of lockScopes.sort()) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockScope]);
    }
    const governedPlaylistId = input.requireGovernedPlaylist
      ? await lockGovernedPlaylist(client, trimToNull(input.playlistId))
      : null;

    // Discover identity without a row lock, then follow the global work ->
    // pipeline row-lock order shared with work-item completion.
    const discoveredVideoContext = pipelineItemId
      ? await findExactVideoItem(client, pipelineItemId, false)
      : await findExistingVideoItem(client, videoId, youtubeUrl);
    const resolvedPipelineItemId = discoveredVideoContext?.id || pipelineItemId;
    const lockedLaunchWork = await lockLaunchWorkBeforePipeline(client, {
      videoPipelineItemId: resolvedPipelineItemId,
      videoId,
    });
    const existingVideoContext = resolvedPipelineItemId
      ? await findExactVideoItem(client, resolvedPipelineItemId)
      : null;
    if (pipelineItemId) {
      const conflict = await client.query(
        `select id
           from public.pipeline_items
          where pipeline_type = 'video'
            and id <> $1
            and published_at is null
            and metadata #>> '{launch_package,kind}' = 'scheduled_youtube_launch_package_v1'
            and metadata #>> '{launch_package,status}' = 'scheduled'
            and metadata #>> '{launch_package,video_id}' = $2
          order by id
          limit 1
          for update`,
        [pipelineItemId, videoId],
      );
      if (conflict.rows[0]) {
        throw new Error("This YouTube video already has an active scheduled parent card");
      }
    }
    const launchGeneration = currentGenerationCanBeReused({
      videoItem: existingVideoContext,
      launchWork: lockedLaunchWork,
      videoId,
      publishAt,
    }) || newLaunchGeneration(videoId, publishAt);
    const existingVideoMetadata = toRecord(existingVideoContext?.metadata);
    if (governedPlaylistId) {
      assertGovernedPlaylistInputs({
        launchInput: input,
        refs,
        youtubeUrl,
        selectedPlaylistId: governedPlaylistId,
        existingVideoMetadata,
      });
    }
    const playlistContextUrl = governedPlaylistId
      ? resolveYouTubePlaylistContextUrl(videoId, governedPlaylistId, { allowRawPlaylistId: true })
      : resolveYouTubePlaylistContextUrl(videoId, input.playlistContextUrl, { allowPlaylistOnly: true }) ||
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
    const playlistId = governedPlaylistId || governedPlaylistIdFromCandidate(playlistContextUrl);
    const targetEmailSendAt = input.targetEmailSendAt
      ? normalizeIsoDate(input.targetEmailSendAt, "target_email_send_at")
      : addMilliseconds(publishAt, 3 * 60 * 60 * 1000);
    const emailTrackingRef = trimToNull(input.emailTrackingRef) || `email-youtube-${videoId}`;
    const optionalDiagnosticCta =
      trimToNull(input.optionalDiagnosticCta) || firstStringFromRecords([refs], [["optional_diagnostic_cta"], ["diagnostic_cta"]]);
    const cta = trimToNull(input.cta) || firstStringFromRecords([refs], [["cta"], ["community", "cta"]]);

    const video = await ensureVideoPipelineItem(client, {
      pipelineItemId: resolvedPipelineItemId,
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
    const community = await ensureCommunityPipelineItem(client, {
      videoItem: video.item,
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
    const marketing = await ensureMarketingEmailPipelineItem(client, {
      videoItem: video.item,
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
    const pinnedComment = await ensurePinnedCommentPipelineItem(client, {
      videoItem: video.item,
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
      workItems.push({ relationType: spec.relationType, ...(await upsertLaunchWorkItem(client, spec, common)) });
    }
    const activationWorkItemId = workItems.find((entry) => entry.relationType === "video_launch_activate")?.workItem?.id;
    if (!activationWorkItemId || workItems.length !== 9) {
      throw new Error("YouTube launch package did not reconcile exactly nine current work items");
    }
    const openActivations = await client.query(
      `select w.id, w.source_type, w.source_id, w.payload
         from public.work_items w
        where w.payload ->> 'source_video_pipeline_item_id' = $1
          and w.payload ->> 'relation_type' = 'video_launch_activate'
          and w.status not in ('done','failed','canceled','cancelled')
        order by w.id`,
      [video.item.id],
    );
    const currentActivation = openActivations.rows[0];
    const currentActivationPayload = toRecord(currentActivation?.payload);
    if (openActivations.rowCount !== 1
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
    const activationMap = await client.query(
      `select 1 from public.pipeline_work_map
        where pipeline_item_id = $1 and work_item_id = $2 and relation_type = 'followup'
        limit 1`,
      [video.item.id, activationWorkItemId],
    );
    if (!activationMap.rows[0]) {
      throw new Error("YouTube launch package current activation mapping is missing");
    }
    const finalizedMetadata = {
      ...toRecord(video.item.metadata),
      launch_package: {
        ...toRecord(toRecord(video.item.metadata).launch_package),
        launch_generation: launchGeneration,
        activation_work_item_id: activationWorkItemId,
      },
    };
    const finalizedVideoResult = await client.query(
      `update public.pipeline_items
          set metadata = $1::jsonb, updated_at = $2
        where id = $3
        returning ${PIPELINE_ITEM_COLUMNS}`,
      [JSON.stringify(finalizedMetadata), new Date().toISOString(), video.item.id],
    );
    const finalizedVideoItem = pipelineItem(finalizedVideoResult.rows[0]);

    await client.query(
      `insert into public.pipeline_events (pipeline_item_id, event_type, actor, payload)
       values ($1, 'pipeline_item.youtube_launch_package_prepared', $2, $3::jsonb)`,
      [
        video.item.id,
        requestedBy,
        JSON.stringify({
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
        }),
      ],
    );

    return {
      videoItem: finalizedVideoItem,
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
      playlistId,
      playlistContextUrl,
      youtubeUrl,
      videoId,
      workItems,
    };
  });
}
