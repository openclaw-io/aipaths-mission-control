import fs from 'node:fs';

import { classifyOwnedYoutubeVideo } from './youtube-owned-video-classification.mjs';

const ROLLING_WINDOWS = ['7d', '28d', 'lifetime'];
const LAUNCH_WINDOWS = ['launch_day', 'first_7d', 'first_28d'];
const SUPPORTED_WINDOWS = [...ROLLING_WINDOWS];
const SUPPORTED_BATCH_WINDOWS = [...ROLLING_WINDOWS, ...LAUNCH_WINDOWS];

export function parseSyncArgs(argv = process.argv.slice(2)) {
  const options = {
    windows: [...SUPPORTED_WINDOWS],
    videoType: 'longform',
    limit: 100,
    offset: 0,
    dryRun: false,
    includeRetentionCurve: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--window=')) {
      const value = arg.slice('--window='.length);
      if (value === 'all') {
        options.windows = [...SUPPORTED_WINDOWS];
      } else if (SUPPORTED_WINDOWS.includes(value)) {
        options.windows = [value];
      } else {
        throw new Error(`Unsupported --window value: ${value}`);
      }
    } else if (arg.startsWith('--video-type=')) {
      const value = arg.slice('--video-type='.length);
      if (value !== 'longform') throw new Error('Only --video-type=longform is supported for Statistics sync V1');
      options.videoType = value;
    } else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --limit value: ${arg}`);
      options.limit = value;
    } else if (arg.startsWith('--offset=')) {
      const value = Number(arg.slice('--offset='.length));
      if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid --offset value: ${arg}`);
      options.offset = value;
    } else if (arg.startsWith('--include-retention-curve=')) {
      const value = arg.slice('--include-retention-curve='.length);
      options.includeRetentionCurve = value === 'true' || value === '1' || value === 'yes';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function loadEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function parseBatchSyncArgs(argv = process.argv.slice(2)) {
  const options = {
    windows: [...SUPPORTED_BATCH_WINDOWS],
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--window=')) {
      const value = arg.slice('--window='.length);
      if (value === 'all') {
        options.windows = [...SUPPORTED_BATCH_WINDOWS];
      } else if (value === 'rolling') {
        options.windows = [...ROLLING_WINDOWS];
      } else if (value === 'launch') {
        options.windows = [...LAUNCH_WINDOWS];
      } else if (SUPPORTED_BATCH_WINDOWS.includes(value)) {
        options.windows = [value];
      } else {
        throw new Error(`Unsupported --window value: ${value}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function getStatisticsWindowPeriod({ windowKey, publishedAt, today = new Date().toISOString().slice(0, 10) }) {
  const todayDate = parseDateOnly(today);
  if (windowKey === '7d') return { startDate: formatDate(addDays(todayDate, -6)), endDate: formatDate(todayDate) };
  if (windowKey === '28d') return { startDate: formatDate(addDays(todayDate, -27)), endDate: formatDate(todayDate) };
  if (windowKey === 'lifetime') return { startDate: '2005-01-01', endDate: formatDate(todayDate) };

  const publishedDate = parseDateOnly(String(publishedAt || '').slice(0, 10));
  if (windowKey === 'launch_day') return { startDate: formatDate(publishedDate), endDate: formatDate(publishedDate) };
  if (windowKey === 'first_7d') return { startDate: formatDate(publishedDate), endDate: formatDate(addDays(publishedDate, 6)) };
  if (windowKey === 'first_28d') return { startDate: formatDate(publishedDate), endDate: formatDate(addDays(publishedDate, 27)) };
  throw new Error(`Unsupported window: ${windowKey}`);
}

export function shouldMaterializeWindowForVideo({ windowKey, publishedAt, today = new Date().toISOString().slice(0, 10) }) {
  if (ROLLING_WINDOWS.includes(windowKey)) return true;
  if (!publishedAt) return false;
  const period = getStatisticsWindowPeriod({ windowKey, publishedAt, today });
  return period.endDate < today;
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`);
  return new Date(`${value}T00:00:00Z`);
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function parseMcpTextJson(output) {
  const parsed = JSON.parse(output);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
    const text = parsed.content.find((item) => item?.type === 'text')?.text;
    if (typeof text === 'string') return JSON.parse(text);
  }
  return parsed;
}

export function mapDashboardMetricRowToOwnedVideo(metric, syncedAt = new Date().toISOString()) {
  const videoId = requiredString(metric.videoId, 'metric.videoId');
  const durationSeconds = numberOrNull(metric.durationSeconds);
  const classification = classifyOwnedYoutubeVideo({
    title: stringOrNull(metric.title) || videoId,
    durationSeconds,
    privacyStatus: stringOrNull(metric.privacyStatus),
  });

  return {
    academy_video_id: videoId,
    platform: 'youtube',
    platform_video_id: videoId,
    title: stringOrNull(metric.title) || videoId,
    published_at: stringOrNull(metric.publishedAt),
    video_kind: classification.video_kind,
    is_published: classification.is_published,
    metadata_json: {
      academy_video_id: videoId,
      duration_seconds: durationSeconds,
      duration_formatted: stringOrNull(metric.durationFormatted),
      ...(stringOrNull(metric.privacyStatus) ? { privacy_status: stringOrNull(metric.privacyStatus) } : {}),
      classification,
      source: 'youtube_statistics_sync',
    },
    synced_at: syncedAt,
  };
}

export function mergeOwnedVideoUpsertRow({ current, row }) {
  const currentMetadata = current?.metadata_json && typeof current.metadata_json === 'object' ? current.metadata_json : {};
  const nextMetadata = row.metadata_json && typeof row.metadata_json === 'object' ? row.metadata_json : {};
  const durationSeconds = numberOrNull(nextMetadata.duration_seconds) ?? numberOrNull(currentMetadata.duration_seconds);
  const privacyStatus = stringOrNull(currentMetadata.privacy_status) || stringOrNull(nextMetadata.privacy_status);
  const classification = classifyOwnedYoutubeVideo({
    title: row.title,
    durationSeconds,
    privacyStatus,
  });
  const videoKind = current?.video_kind === 'short' || classification.video_kind === 'short'
    ? 'short'
    : row.video_kind;
  const isPublished = privacyStatus
    ? privacyStatus === 'public'
    : (current?.is_published === false ? false : row.is_published);

  return {
    ...row,
    video_kind: videoKind,
    is_published: isPublished,
    metadata_json: {
      ...currentMetadata,
      ...nextMetadata,
      ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
      ...(privacyStatus ? { privacy_status: privacyStatus } : {}),
      classification: {
        ...classification,
        video_kind: videoKind,
        is_published: privacyStatus ? privacyStatus === 'public' : classification.is_published,
      },
    },
  };
}

export function isDashboardMetricRowEligibleForStatistics(metric) {
  const durationSeconds = numberOrNull(metric?.durationSeconds);
  if (durationSeconds === null || durationSeconds < 180) return false;
  return !/\b(clase|bootcamp|workshop|masterclass)\b/i.test(String(metric?.title || ''));
}

export function mapDashboardMetricRowToSnapshot({ windowKey, period, metric, runId = null, computedAt = new Date().toISOString() }) {
  const retentionError = typeof metric.retentionError === 'string' && metric.retentionError ? metric.retentionError : null;
  const hasRetention = metric.retention30s != null || metric.retention50pct != null || metric.retention75pct != null;

  return {
    run_id: runId,
    academy_video_id: requiredString(metric.videoId, 'metric.videoId'),
    window_key: windowKey,
    window_start_date: stringOrNull(period?.startDate),
    window_end_date: stringOrNull(period?.endDate),
    views: integerOrNull(metric.views),
    impressions: integerOrNull(metric.impressions),
    yt_ctr: numberOrNull(metric.ytCtr),
    avg_view_duration_seconds: numberOrNull(metric.avgViewDurationSeconds),
    avg_percent_viewed: numberOrNull(metric.avgViewPercentage),
    retention_30s: numberOrNull(metric.retention30s),
    retention_50pct: numberOrNull(metric.retention50pct),
    retention_75pct: numberOrNull(metric.retention75pct),
    watch_time_minutes: numberOrNull(metric.watchTimeMinutes),
    subscribers_gained: integerOrNull(metric.subscribersGained),
    traffic_source_top: stringOrNull(metric.trafficSourceTop),
    launch_day_impressions: integerOrNull(metric.launchDayImpressions),
    launch_day_yt_ctr: numberOrNull(metric.launchDayYtCtr),
    first_7d_impressions: integerOrNull(metric.first7DayImpressions),
    first_7d_yt_ctr: numberOrNull(metric.first7DayYtCtr),
    first_7d_reach_days_covered: integerOrNull(metric.first7DayReachDaysCovered),
    source_freshness_json: {
      reach: stringOrNull(metric.reachDataFreshness) || 'unknown',
      retention: retentionError ? 'error' : (hasRetention ? 'ok' : 'missing'),
      ...(retentionError ? { retentionError } : {}),
    },
    raw_metrics_json: metric,
    computed_at: computedAt,
    updated_at: computedAt,
  };
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  return value.trim();
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOrNull(value) {
  const numeric = numberOrNull(value);
  return numeric === null ? null : Math.round(numeric);
}
