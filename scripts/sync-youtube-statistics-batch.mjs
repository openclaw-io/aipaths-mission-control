#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

import {
  getStatisticsWindowPeriod,
  loadEnvFile,
  parseBatchSyncArgs,
  shouldMaterializeWindowForVideo,
} from './lib/youtube-statistics-sync-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MCP_DIR = '/Users/joaco/openclaw/mcps/youtube_mcp';
const MCP_DIR = process.env.YOUTUBE_MCP_DIR || DEFAULT_MCP_DIR;
const requireFromMcp = createRequire(path.join(MCP_DIR, 'package.json'));
const { google } = requireFromMcp('googleapis');
const Database = requireFromMcp('better-sqlite3');

const ROLLING_WINDOWS = new Set(['7d', '28d', 'lifetime']);
const LAUNCH_WINDOWS = new Set(['launch_day', 'first_7d', 'first_28d']);

async function main() {
  const options = parseBatchSyncArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const env = loadEnvFile(path.join(REPO_ROOT, '.env.local'));
  const mcpEnv = loadEnvFile(path.join(MCP_DIR, '.env'));
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const cacheDb = new Database(path.join(MCP_DIR, 'data/cache.db'));
  const analytics = createAnalyticsClient({ mcpEnv, cacheDb });
  const today = new Date().toISOString().slice(0, 10);
  const computedAt = new Date().toISOString();

  const eligibleVideos = await loadEligibleOwnedVideos(supabase);
  const existingSnapshots = await loadExistingSnapshots(supabase, eligibleVideos.map((video) => video.academy_video_id));
  const reachBounds = cacheDb.prepare('select min(date) as min_date, max(date) as max_date from reach_daily').get();

  let totalRows = 0;
  const perWindow = [];
  for (const windowKey of options.windows) {
    const videos = eligibleVideos.filter((video) => shouldMaterializeWindowForVideo({
      windowKey,
      publishedAt: video.published_at,
      today,
    }));

    if (videos.length === 0) {
      perWindow.push({ window: windowKey, videos: 0, rows: 0, skipped: eligibleVideos.length });
      continue;
    }

    const rows = await buildRowsForWindow({
      analytics,
      cacheDb,
      existingSnapshots,
      reachBounds,
      videos,
      windowKey,
      today,
      computedAt,
    });

    totalRows += rows.length;
    perWindow.push({
      window: windowKey,
      videos: videos.length,
      rows: rows.length,
      skipped: eligibleVideos.length - videos.length,
      analyticsRowsWithViews: rows.filter((row) => Number(row.views || 0) > 0).length,
    });

    if (options.dryRun) {
      console.log(`\n=== ${windowKey} dry-run ===`);
      console.log(JSON.stringify({ sample: rows.slice(0, 3) }, null, 2));
    } else if (rows.length > 0) {
      const { error } = await supabase
        .from('ops_youtube_video_learning_snapshots')
        .upsert(rows, { onConflict: 'academy_video_id,window_key' });
      if (error) throw new Error(`upsert ${windowKey} failed: ${error.message}`);
      console.log(`Upserted ${rows.length} ${windowKey} rows`);
    }
  }

  console.log(JSON.stringify({ dryRun: options.dryRun, eligibleVideos: eligibleVideos.length, totalRows, perWindow }, null, 2));
}

function printHelp() {
  console.log(`Usage: npm run sync:youtube-statistics:batch -- [--window=all|rolling|launch|7d|28d|lifetime|launch_day|first_7d|first_28d] [--dry-run]\n\nBackfills /statistics snapshots directly from YouTube Analytics API plus local reach cache.\nRolling windows are trailing calendar windows. Launch windows are relative to published_at and only materialize after the window is complete.`);
}

function createAnalyticsClient({ mcpEnv, cacheDb }) {
  const token = cacheDb.prepare('select * from oauth_tokens where id=1').get();
  if (!token) throw new Error('YouTube MCP OAuth tokens missing; run youtube_mcp setup first');
  const auth = new google.auth.OAuth2(
    mcpEnv.GOOGLE_CLIENT_ID || mcpEnv.YOUTUBE_CLIENT_ID,
    mcpEnv.GOOGLE_CLIENT_SECRET || mcpEnv.YOUTUBE_CLIENT_SECRET,
    mcpEnv.OAUTH_REDIRECT_URI || mcpEnv.GOOGLE_REDIRECT_URI,
  );
  auth.setCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expiry_date: token.expiry_date,
    scope: token.scope,
    token_type: 'Bearer',
  });
  return google.youtubeAnalytics({ version: 'v2', auth });
}

async function loadEligibleOwnedVideos(supabase) {
  const { data, error } = await supabase
    .from('ops_owned_videos')
    .select('academy_video_id,title,published_at,video_kind,is_published,metadata_json')
    .eq('video_kind', 'longform')
    .order('published_at', { ascending: false });
  if (error) throw new Error(`load ops_owned_videos failed: ${error.message}`);

  return (data || []).filter((video) => {
    const title = String(video.title || '').toLowerCase();
    const duration = video.metadata_json?.duration_seconds;
    return video.is_published !== false
      && duration !== null
      && duration !== undefined
      && Number(duration) >= 180
      && !/\b(clase|bootcamp|workshop|masterclass)\b/i.test(title);
  });
}

async function loadExistingSnapshots(supabase, videoIds) {
  if (!videoIds.length) return new Map();
  const { data, error } = await supabase
    .from('ops_youtube_video_learning_snapshots')
    .select('*')
    .in('academy_video_id', videoIds);
  if (error) throw new Error(`load existing snapshots failed: ${error.message}`);
  return new Map((data || []).map((row) => [`${row.academy_video_id}:${row.window_key}`, row]));
}

async function buildRowsForWindow({ analytics, cacheDb, existingSnapshots, reachBounds, videos, windowKey, today, computedAt }) {
  const ids = videos.map((video) => video.academy_video_id);
  const periods = new Map(videos.map((video) => [video.academy_video_id, getStatisticsWindowPeriod({ windowKey, publishedAt: video.published_at, today })]));
  const sharedPeriod = getSharedPeriod(periods);
  const metrics = sharedPeriod
    ? await fetchAnalyticsSummary({ analytics, videoIds: ids, startDate: sharedPeriod.startDate, endDate: sharedPeriod.endDate })
    : await fetchAnalyticsPerVideo({ analytics, videos, periods });
  const traffic = sharedPeriod
    ? await fetchTopTrafficSource({ analytics, videoIds: ids, startDate: sharedPeriod.startDate, endDate: sharedPeriod.endDate }).catch(() => new Map())
    : new Map();

  return videos.map((video) => {
    const period = periods.get(video.academy_video_id);
    const metric = metrics.get(video.academy_video_id) || zeroMetric();
    const reach = fetchReachWindow(cacheDb, video.academy_video_id, period.startDate, period.endDate);
    const launchDate = video.published_at ? String(video.published_at).slice(0, 10) : null;
    const launchReach = launchDate ? fetchReachWindow(cacheDb, video.academy_video_id, launchDate, launchDate) : emptyReach();
    const first7Reach = launchDate ? fetchReachWindow(cacheDb, video.academy_video_id, launchDate, addDays(launchDate, 6)) : emptyReach();
    const existing = existingSnapshots.get(`${video.academy_video_id}:${windowKey}`) || {};

    return {
      run_id: null,
      academy_video_id: video.academy_video_id,
      window_key: windowKey,
      window_start_date: period.startDate,
      window_end_date: period.endDate,
      views: metric.views,
      impressions: reach.impressions,
      yt_ctr: reach.ytCtr,
      avg_view_duration_seconds: metric.avgViewDurationSeconds,
      avg_percent_viewed: metric.avgPercentViewed,
      retention_30s: existing.retention_30s ?? null,
      retention_50pct: existing.retention_50pct ?? null,
      retention_75pct: existing.retention_75pct ?? null,
      watch_time_minutes: metric.watchTimeMinutes,
      subscribers_gained: metric.subscribersGained,
      traffic_source_top: traffic.get(video.academy_video_id) || existing.traffic_source_top || null,
      launch_day_impressions: launchReach.impressions,
      launch_day_yt_ctr: launchReach.ytCtr,
      first_7d_impressions: first7Reach.impressions,
      first_7d_yt_ctr: first7Reach.ytCtr,
      first_7d_reach_days_covered: first7Reach.daysCovered,
      source_freshness_json: {
        analytics: 'fresh_batch',
        reach: reach.daysCovered > 0 ? (LAUNCH_WINDOWS.has(windowKey) ? 'launch_window_reporting_cache' : 'partial_reporting_cache') : 'missing',
        reach_cache_min_date: reachBounds?.min_date || null,
        reach_cache_max_date: reachBounds?.max_date || null,
        retention: existing.retention_30s != null ? 'preserved_existing' : 'missing',
      },
      raw_metrics_json: {
        source: 'youtube_analytics_batch_sync',
        window: windowKey,
        videoId: video.academy_video_id,
        title: video.title,
        durationSeconds: video.metadata_json?.duration_seconds ?? null,
        reachDaysCovered: reach.daysCovered,
        reachRowCount: reach.rowCount,
      },
      computed_at: computedAt,
      updated_at: computedAt,
    };
  });
}

function getSharedPeriod(periods) {
  const values = [...periods.values()];
  if (!values.length) return null;
  const first = values[0];
  return values.every((period) => period.startDate === first.startDate && period.endDate === first.endDate) ? first : null;
}

async function fetchAnalyticsPerVideo({ analytics, videos, periods }) {
  const metrics = new Map();
  for (const video of videos) {
    const period = periods.get(video.academy_video_id);
    const result = await fetchAnalyticsSummary({ analytics, videoIds: [video.academy_video_id], startDate: period.startDate, endDate: period.endDate });
    metrics.set(video.academy_video_id, result.get(video.academy_video_id) || zeroMetric());
  }
  return metrics;
}

async function fetchAnalyticsSummary({ analytics, videoIds, startDate, endDate }) {
  if (!videoIds.length) return new Map();
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
    dimensions: 'video',
    filters: `video==${videoIds.join(',')}`,
    maxResults: videoIds.length,
  });
  const map = new Map();
  for (const row of response.data.rows || []) {
    map.set(row[0], {
      views: integerOrNull(row[1]) ?? 0,
      watchTimeMinutes: numberOrNull(row[2]) ?? 0,
      avgViewDurationSeconds: numberOrNull(row[3]) ?? 0,
      avgPercentViewed: numberOrNull(row[4]) ?? 0,
      subscribersGained: integerOrNull(row[5]) ?? 0,
    });
  }
  return map;
}

async function fetchTopTrafficSource({ analytics, videoIds, startDate, endDate }) {
  if (!videoIds.length) return new Map();
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: 'views',
    dimensions: 'video,insightTrafficSourceType',
    filters: `video==${videoIds.join(',')}`,
    maxResults: Math.max(500, videoIds.length * 10),
  });
  const best = new Map();
  for (const row of response.data.rows || []) {
    const [videoId, source, views] = row;
    const existing = best.get(videoId);
    const numericViews = Number(views) || 0;
    if (!existing || numericViews > existing.views) best.set(videoId, { source: String(source || ''), views: numericViews });
  }
  return new Map([...best.entries()].map(([videoId, value]) => [videoId, value.source]));
}

function fetchReachWindow(cacheDb, videoId, startDate, endDate) {
  const startKey = startDate.replaceAll('-', '');
  const endKey = endDate.replaceAll('-', '');
  const rows = cacheDb.prepare(`
    select date, video_thumbnail_impressions as impressions, video_thumbnail_impressions_ctr as ctr
    from reach_daily
    where video_id = ? and date between ? and ?
  `).all(videoId, startKey, endKey);
  let impressions = 0;
  let weightedCtr = 0;
  let ctrRows = 0;
  const days = new Set();
  for (const row of rows) {
    const rowImpressions = Number(row.impressions) || 0;
    impressions += rowImpressions;
    if (row.ctr !== null && row.ctr !== undefined) {
      weightedCtr += rowImpressions * Number(row.ctr);
      ctrRows += 1;
    }
    days.add(row.date);
  }
  if (!rows.length || impressions <= 0) return { ...emptyReach(), rowCount: rows.length };
  return {
    impressions,
    ytCtr: ctrRows ? Math.round((weightedCtr / impressions) * 100) / 100 : null,
    daysCovered: days.size,
    rowCount: rows.length,
  };
}

function emptyReach() {
  return { impressions: null, ytCtr: null, daysCovered: 0, rowCount: 0 };
}

function zeroMetric() {
  return { views: 0, watchTimeMinutes: 0, avgViewDurationSeconds: 0, avgPercentViewed: 0, subscribersGained: 0 };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

main().catch((error) => {
  console.error(`sync-youtube-statistics-batch failed: ${error.message}`);
  process.exit(1);
});
