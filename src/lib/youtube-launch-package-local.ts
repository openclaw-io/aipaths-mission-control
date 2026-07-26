import type { PoolClient } from "pg";
import { normalizeRow } from "@/lib/db/mission-control";
import { withTransaction } from "@/lib/db/postgres";
import {
  buildScheduledYouTubeLaunchWorkSpecs,
  extractYouTubeVideoId,
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

function youtubePlaylistContextUrl(videoId: string, playlistId: string | null) {
  return playlistId ? `${youtubeWatchUrl(videoId)}&list=${playlistId}` : null;
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

async function ensureVideoPipelineItem(client: PoolClient, input: {
  publishAt: string;
  requestedBy: string;
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
  const existing = await findExistingVideoItem(client, input.videoId, input.youtubeUrl);
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
        existing.published_at || existing.status === "published" ? existing.status : existing.status || "editing",
        existing.owner_agent || "youtube",
        existing.requested_by || input.requestedBy,
        input.publishAt,
        input.youtubeUrl,
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
       source_id, scheduled_for, current_url, content_format, metadata, updated_at
     ) values ('video', $1, 'editing', 'high', 'youtube', $2, 'service', $3, $4, $5, 'youtube_url', $6::jsonb, $7)
     returning ${PIPELINE_ITEM_COLUMNS}`,
    [input.title, input.requestedBy, `youtube:${input.videoId}`, input.publishAt, input.youtubeUrl, JSON.stringify(metadata), now],
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

async function findExistingWorkItemByVideoRelation(client: PoolClient, videoId: string, relationType: string) {
  const result = await client.query(
    `select ${WORK_ITEM_COLUMNS}
       from public.work_items
      where payload ->> 'video_id' = $1
        and payload ->> 'relation_type' = $2
      order by created_at desc
      limit 1
      for update`,
    [videoId, relationType],
  );
  return result.rows[0] ? workItem(result.rows[0]) : null;
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
  publishAt: string;
  requestedBy: string;
}) {
  const now = new Date().toISOString();
  const existing = await findExistingWorkItemByVideoRelation(client, common.videoId, spec.relationType);
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

  if (existing) {
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
        existing.status === "in_progress" ? "in_progress" : "ready",
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
  const videoId = trimToNull(input.videoId) || extractYouTubeVideoId(input.youtubeUrl);
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error("A valid YouTube video_id or URL is required");
  }
  const youtubeUrl = trimToNull(input.youtubeUrl) || youtubeWatchUrl(videoId);
  const title = trimToNull(input.title) || `Scheduled YouTube video ${videoId}`;
  const requestedBy = trimToNull(input.requestedBy) || "mission-control";
  const targetCommunityPublishAt = addMinutes(publishAt, 30);
  const refs = toRecord(input.refs);

  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`youtube-launch-package:${videoId}`]);

    const existingVideoContext = await findExistingVideoItem(client, videoId, youtubeUrl);
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
      youtubePlaylistContextUrl(
        videoId,
        trimToNull(input.playlistId) || firstStringFromRecords([refs], [["playlist_id"], ["playlistId"], ["playlist", "id"]]),
      );
    const targetEmailSendAt = input.targetEmailSendAt
      ? normalizeIsoDate(input.targetEmailSendAt, "target_email_send_at")
      : addMilliseconds(publishAt, 3 * 60 * 60 * 1000);
    const emailTrackingRef = trimToNull(input.emailTrackingRef) || `email-youtube-${videoId}`;
    const optionalDiagnosticCta =
      trimToNull(input.optionalDiagnosticCta) || firstStringFromRecords([refs], [["optional_diagnostic_cta"], ["diagnostic_cta"]]);
    const cta = trimToNull(input.cta) || firstStringFromRecords([refs], [["cta"], ["community", "cta"]]);

    const video = await ensureVideoPipelineItem(client, {
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
    const community = await ensureCommunityPipelineItem(client, {
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
    const marketing = await ensureMarketingEmailPipelineItem(client, {
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
      videoPipelineItemId: video.item.id,
      communityPipelineItemId: community.item.id,
      marketingPipelineItemId: marketing.item.id,
    });
    const workItems = [];
    for (const spec of specs) {
      workItems.push({ relationType: spec.relationType, ...(await upsertLaunchWorkItem(client, spec, common)) });
    }

    await client.query(
      `insert into public.pipeline_events (pipeline_item_id, event_type, actor, payload)
       values ($1, 'pipeline_item.youtube_launch_package_prepared', $2, $3::jsonb)`,
      [
        video.item.id,
        requestedBy,
        JSON.stringify({
          video_id: videoId,
          youtube_url: youtubeUrl,
          publish_at: publishAt,
          community_pipeline_item_id: community.item.id,
          marketing_pipeline_item_id: marketing.item.id,
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
      videoItem: video.item,
      videoItemCreated: video.created,
      communityItem: community.item,
      communityItemCreated: community.created,
      marketingItem: marketing.item,
      marketingItemCreated: marketing.created,
      publishAt,
      targetCommunityPublishAt,
      targetEmailSendAt,
      playlistContextUrl,
      youtubeUrl,
      videoId,
      workItems,
    };
  });
}
