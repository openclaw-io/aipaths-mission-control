import { supabaseAdmin } from "@/lib/supabase/admin";
import type { YouTubeManualLearning, YouTubeMetricSnapshot, YouTubeStatisticsRow } from "@/lib/youtube/statistics-types";

type JsonRecord = Record<string, unknown>;
type PipelineItemRow = YouTubeStatisticsRow["item"];
type OwnedVideoRow = NonNullable<YouTubeStatisticsRow["video"]>;

const PIPELINE_SELECT = "id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at";
const SNAPSHOT_SELECT = "academy_video_id, window_key, window_start_date, window_end_date, views, impressions, yt_ctr, avg_view_duration_seconds, avg_percent_viewed, retention_30s, retention_50pct, retention_75pct, watch_time_minutes, subscribers_gained, traffic_source_top, launch_day_impressions, launch_day_yt_ctr, first_7d_impressions, first_7d_yt_ctr, first_7d_reach_days_covered, source_freshness_json, raw_metrics_json, computed_at";

export async function loadYouTubeStatisticsRows(): Promise<YouTubeStatisticsRow[]> {
  const [{ data: pipelineItems, error: pipelineError }, { data: ownedVideos, error: ownedError }] = await Promise.all([
    supabaseAdmin
      .from("pipeline_items")
      .select(PIPELINE_SELECT)
      .eq("pipeline_type", "video")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("ops_owned_videos")
      .select("academy_video_id, platform_video_id, title, published_at, video_kind, is_published, metadata_json")
      .eq("video_kind", "longform")
      .order("published_at", { ascending: false }),
  ]);

  if (pipelineError) console.error("[Statistics] Failed to fetch pipeline video items:", pipelineError);
  if (ownedError) console.error("[Statistics] Failed to fetch owned YouTube videos:", ownedError);

  const items = (pipelineItems ?? []) as PipelineItemRow[];
  const videos = (ownedVideos ?? []) as OwnedVideoRow[];
  const videoIds = [...new Set(videos.map((video) => video.academy_video_id).filter(Boolean))];
  const snapshotMap = await loadSnapshotMap(videoIds);
  const videoById = new Map(videos.map((video) => [video.academy_video_id, video]));
  const usedPipelineItemIds = new Set<string>();

  const rows: YouTubeStatisticsRow[] = items
    .map((item) => {
      const videoId = extractYouTubeVideoId({ current_url: item.current_url, metadata: item.metadata });
      const video = videoId ? videoById.get(videoId) ?? null : null;
      if (video) usedPipelineItemIds.add(item.id);
      return makeStatisticsRow({ item, video, snapshotMap });
    })
    .filter((row) => isLongFormStatisticsCandidate(row));

  for (const video of videos) {
    const alreadyRepresented = rows.some((row) => row.video?.academy_video_id === video.academy_video_id);
    if (alreadyRepresented) continue;
    const row = makeStatisticsRow({ item: itemFromOwnedVideo(video), video, snapshotMap });
    if (!isLongFormStatisticsCandidate(row)) continue;
    rows.push(row);
  }

  return rows.sort((a, b) => {
    const aDate = a.video?.published_at || a.item.published_at || a.item.updated_at;
    const bDate = b.video?.published_at || b.item.published_at || b.item.updated_at;
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });
}

export function extractYouTubeVideoId(input: { current_url?: string | null; metadata?: JsonRecord | null }) {
  const metadata = input.metadata || {};
  const youtubeV0 = toRecord(metadata.youtube_v0);
  const publication = toRecord(youtubeV0.publication);
  const published = toRecord(youtubeV0.published);
  const source = toRecord(metadata.source);
  const candidates = [
    metadata.video_id,
    metadata.youtube_video_id,
    youtubeV0.video_id,
    youtubeV0.youtube_video_id,
    publication.video_id,
    publication.youtube_video_id,
    published.video_id,
    published.youtube_video_id,
    source.video_id,
    source.youtube_video_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const url = input.current_url;
  if (typeof url === "string") {
    const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function loadSnapshotMap(videoIds: string[]) {
  const snapshotMap = new Map<string, YouTubeStatisticsRow["snapshots"]>();
  if (!videoIds.length) return snapshotMap;

  const { data, error } = await supabaseAdmin
    .from("ops_youtube_video_learning_snapshots")
    .select(SNAPSHOT_SELECT)
    .in("academy_video_id", videoIds);

  if (error) {
    console.warn("[Statistics] YouTube learning snapshots unavailable:", error.message);
    return snapshotMap;
  }

  for (const raw of data ?? []) {
    const snapshot = normalizeSnapshot(raw as JsonRecord);
    const current = snapshotMap.get(snapshot.academy_video_id) || {};
    current[snapshot.window_key] = snapshot;
    snapshotMap.set(snapshot.academy_video_id, current);
  }

  return snapshotMap;
}

function makeStatisticsRow({
  item,
  video,
  snapshotMap,
}: {
  item: PipelineItemRow;
  video: OwnedVideoRow | null;
  snapshotMap: Map<string, YouTubeStatisticsRow["snapshots"]>;
}): YouTubeStatisticsRow {
  return {
    item,
    video,
    snapshots: video ? snapshotMap.get(video.academy_video_id) || {} : {},
    manual: extractManualLearning(item.metadata),
  };
}

function isLongFormStatisticsCandidate(row: YouTubeStatisticsRow) {
  if (row.video?.video_kind === "short") return false;
  if (row.video?.is_published === false) return false;

  const status = row.item.status.toLowerCase();
  if (["hidden", "oculto", "private", "privado", "archived", "rejected"].includes(status)) return false;

  const title = `${row.video?.title || ""} ${row.item.title || ""}`.toLowerCase();
  if (/\b(clase|bootcamp|workshop|masterclass)\b/.test(title)) return false;

  const durationSeconds = getVideoDurationSeconds(row);
  // Statistics should be strict: public/relevant long-form only. If duration is
  // missing, do not show the row; otherwise Shorts with incomplete metadata leak in.
  if (durationSeconds === null || durationSeconds < 180) return false;

  if (!hasMetricSnapshot(row)) return false;

  const metadata = row.item.metadata || {};
  const format = stringOrNull(toRecord(metadata.youtube_learning_v1).format || toRecord(metadata.learning_dashboard).format || metadata.format)?.toLowerCase();
  if (format === "short" || format === "shorts") return false;
  return ["published", "learning"].includes(status) || Boolean(row.item.published_at || row.item.current_url || row.video);
}

function hasMetricSnapshot(row: YouTubeStatisticsRow) {
  return Object.values(row.snapshots).some((snapshot) => snapshot && (
    snapshot.views !== null ||
    snapshot.impressions !== null ||
    snapshot.yt_ctr !== null ||
    snapshot.avg_view_duration_seconds !== null ||
    snapshot.retention_30s !== null
  ));
}

function getVideoDurationSeconds(row: YouTubeStatisticsRow): number | null {
  const videoMetadata = toRecord(row.video?.metadata_json);
  const itemMetadata = toRecord(row.item.metadata);
  const notion = toRecord(itemMetadata.notion_properties);
  const snapshots = Object.values(row.snapshots);
  const candidates = [
    videoMetadata.duration_seconds,
    videoMetadata.durationSeconds,
    videoMetadata.duration_seconds_total,
    ...snapshots.map((snapshot) => snapshot ? toRecord(snapshot.raw_metrics_json).durationSeconds : null),
    notion["Actual Length"],
    itemMetadata.actual_length,
    itemMetadata.duration,
  ];

  for (const candidate of candidates) {
    const parsed = parseDurationSeconds(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function itemFromOwnedVideo(video: OwnedVideoRow): PipelineItemRow {
  return {
    id: `owned-video:${video.academy_video_id}`,
    pipeline_type: "video",
    title: video.title,
    slug: null,
    status: "published",
    priority: null,
    owner_agent: "youtube",
    requested_by: null,
    source_type: "ops_owned_videos",
    source_id: video.academy_video_id,
    scheduled_for: null,
    published_at: video.published_at,
    current_url: `https://www.youtube.com/watch?v=${video.platform_video_id}`,
    content_path: null,
    content_format: null,
    metadata: { ops_owned_video: { metadata_json: video.metadata_json || {}, is_published: video.is_published } },
    created_at: video.published_at || new Date(0).toISOString(),
    updated_at: video.published_at || new Date(0).toISOString(),
  };
}

function extractManualLearning(metadata: JsonRecord | null): YouTubeManualLearning {
  const direct = toRecord(metadata?.youtube_learning_v1 || metadata?.learning_dashboard);
  return {
    format: stringOrNull(direct.format) || stringOrNull(metadata?.format),
    pillar: stringOrNull(direct.pillar || metadata?.pillar),
    video_type: stringOrNull(direct.video_type || metadata?.video_type),
    promise: stringOrNull(direct.promise || metadata?.promise),
    primary_cta: stringOrNull(direct.primary_cta || metadata?.primary_cta),
    hook_type: stringOrNull(direct.hook_type),
    title_angle: stringOrNull(direct.title_angle),
    thumbnail_angle: stringOrNull(direct.thumbnail_angle),
    manual_result: stringOrNull(direct.manual_result),
    what_worked: stringOrNull(direct.what_worked),
    what_failed: stringOrNull(direct.what_failed),
    hypothesis: stringOrNull(direct.hypothesis),
    next_test: stringOrNull(direct.next_test),
    ctas: Array.isArray(direct.ctas) ? direct.ctas.map(normalizeCta).filter(Boolean) as YouTubeManualLearning["ctas"] : [],
    updated_at: stringOrNull(direct.updated_at),
    updated_by: stringOrNull(direct.updated_by),
  };
}

function normalizeSnapshot(raw: JsonRecord): YouTubeMetricSnapshot {
  return {
    academy_video_id: String(raw.academy_video_id),
    window_key: raw.window_key as YouTubeMetricSnapshot["window_key"],
    window_start_date: stringOrNull(raw.window_start_date),
    window_end_date: stringOrNull(raw.window_end_date),
    views: numberOrNull(raw.views),
    impressions: numberOrNull(raw.impressions),
    yt_ctr: numberOrNull(raw.yt_ctr),
    avg_view_duration_seconds: numberOrNull(raw.avg_view_duration_seconds),
    avg_percent_viewed: numberOrNull(raw.avg_percent_viewed),
    retention_30s: numberOrNull(raw.retention_30s),
    retention_50pct: numberOrNull(raw.retention_50pct),
    retention_75pct: numberOrNull(raw.retention_75pct),
    watch_time_minutes: numberOrNull(raw.watch_time_minutes),
    subscribers_gained: numberOrNull(raw.subscribers_gained),
    traffic_source_top: stringOrNull(raw.traffic_source_top),
    launch_day_impressions: numberOrNull(raw.launch_day_impressions),
    launch_day_yt_ctr: numberOrNull(raw.launch_day_yt_ctr),
    first_7d_impressions: numberOrNull(raw.first_7d_impressions),
    first_7d_yt_ctr: numberOrNull(raw.first_7d_yt_ctr),
    first_7d_reach_days_covered: numberOrNull(raw.first_7d_reach_days_covered),
    source_freshness_json: toRecord(raw.source_freshness_json),
    raw_metrics_json: toRecord(raw.raw_metrics_json),
    computed_at: String(raw.computed_at),
  };
}

function normalizeCta(value: unknown) {
  const row = toRecord(value);
  const destination = stringOrNull(row.destination);
  if (!destination) return null;
  return {
    destination,
    clicks: numberOrNull(row.clicks),
    leads: numberOrNull(row.leads),
    revenue: numberOrNull(row.revenue),
    ref: stringOrNull(row.ref) || "",
  };
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(numeric) ? numeric : null;
}
