#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MCP_DIR = '/Users/joaco/openclaw/mcps/youtube_mcp';
const MCP_DIR = process.env.YOUTUBE_MCP_DIR || DEFAULT_MCP_DIR;
const VIDEO_ID = 'YzZtrk_fkPA';
const WORK_ITEM_ID = 'f39dd504-2812-4091-a301-447db16f95a8';
const PUBLISHED_AT = '2026-07-21T13:00:00.000Z';
const WINDOW_KEY = 'first_7d';
const WINDOW_START_DATE = '2026-07-21';
const WINDOW_END_DATE = '2026-07-27';
const COMPLETED_AT = new Date().toISOString();

const requireFromMcp = createRequire(path.join(MCP_DIR, 'package.json'));
const { google } = requireFromMcp('googleapis');
const Database = requireFromMcp('better-sqlite3');

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOrNull(value) {
  const numeric = numberOrNull(value);
  return numeric === null ? null : Math.round(numeric);
}

function parseIsoDurationSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return null;
  const total = Math.round(Number(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function createClients() {
  const repoEnv = { ...loadEnvFile(path.join(REPO_ROOT, '.env.local')), ...loadEnvFile(path.join(REPO_ROOT, '.env')) };
  const mcpEnv = { ...loadEnvFile(path.join(MCP_DIR, '.env')) };
  const databaseUrl = process.env.MISSION_CONTROL_DATABASE_URL || repoEnv.MISSION_CONTROL_DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing MISSION_CONTROL_DATABASE_URL');

  const sourceCachePath = path.join(MCP_DIR, 'data/cache.db');
  const cacheCopyPath = path.join(os.tmpdir(), `youtube-mcp-cache-${process.pid}.db`);
  fs.copyFileSync(sourceCachePath, cacheCopyPath);
  const cacheDb = new Database(cacheCopyPath, { readonly: true, fileMustExist: true });
  const token = cacheDb.prepare('select * from oauth_tokens where id=1').get();
  if (!token) throw new Error('YouTube MCP OAuth tokens missing');

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

  return {
    pool: new Pool({ ...createPoolConfig(databaseUrl), max: 3, idleTimeoutMillis: 30_000 }),
    cacheDb,
    cacheCopyPath,
    youtube: google.youtube({ version: 'v3', auth }),
    analytics: google.youtubeAnalytics({ version: 'v2', auth }),
  };
}

function createPoolConfig(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || 5432);
  const socketPath = `/tmp/.s.PGSQL.${port}`;
  if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && fs.existsSync(socketPath)) {
    return {
      host: '/tmp',
      port,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  }
  return { connectionString: databaseUrl };
}

async function fetchVideoDetails(youtube) {
  const response = await youtube.videos.list({
    part: ['snippet', 'status', 'contentDetails', 'statistics'],
    id: [VIDEO_ID],
  });
  const item = response.data.items?.[0];
  if (!item) throw new Error(`Video ${VIDEO_ID} not found through YouTube Data API`);
  const snippet = item.snippet || {};
  const status = item.status || {};
  const contentDetails = item.contentDetails || {};
  const statistics = item.statistics || {};
  return {
    videoId: VIDEO_ID,
    title: snippet.title || null,
    channelTitle: snippet.channelTitle || null,
    publishedAt: snippet.publishedAt || null,
    privacyStatus: status.privacyStatus || null,
    uploadStatus: status.uploadStatus || null,
    embeddable: status.embeddable ?? null,
    durationSeconds: parseIsoDurationSeconds(contentDetails.duration),
    publicViewCount: integerOrNull(statistics.viewCount),
    publicLikeCount: integerOrNull(statistics.likeCount),
    publicCommentCount: integerOrNull(statistics.commentCount),
  };
}

async function fetchAnalyticsSummary(analytics) {
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate: WINDOW_START_DATE,
    endDate: WINDOW_END_DATE,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
    dimensions: 'video',
    filters: `video==${VIDEO_ID}`,
    maxResults: 1,
  });
  const row = response.data.rows?.[0] || [];
  return {
    views: integerOrNull(row[1]) ?? 0,
    watchTimeMinutes: numberOrNull(row[2]) ?? 0,
    avgViewDurationSeconds: numberOrNull(row[3]) ?? 0,
    avgPercentViewed: numberOrNull(row[4]) ?? 0,
    subscribersGained: integerOrNull(row[5]) ?? 0,
  };
}

async function fetchTopTrafficSource(analytics) {
  const response = await analytics.reports.query({
    ids: 'channel==MINE',
    startDate: WINDOW_START_DATE,
    endDate: WINDOW_END_DATE,
    metrics: 'views',
    dimensions: 'insightTrafficSourceType',
    filters: `video==${VIDEO_ID}`,
    sort: '-views',
    maxResults: 5,
  });
  return response.data.rows?.[0]?.[0] ? String(response.data.rows[0][0]) : null;
}

function fetchReachWindow(cacheDb, startDate = WINDOW_START_DATE, endDate = WINDOW_END_DATE) {
  const rows = cacheDb.prepare(`
    select date, video_thumbnail_impressions as impressions, video_thumbnail_impressions_ctr as ctr
    from reach_daily
    where video_id = ? and date between ? and ?
  `).all(VIDEO_ID, startDate.replaceAll('-', ''), endDate.replaceAll('-', ''));
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
  return {
    impressions: impressions > 0 ? impressions : null,
    ytCtr: impressions > 0 && ctrRows ? Math.round((weightedCtr / impressions) * 100) / 100 : null,
    daysCovered: days.size,
    rowCount: rows.length,
  };
}

function fetchRetentionFromExisting(existing) {
  return {
    retention30s: numberOrNull(existing?.retention_30s),
    retention50pct: numberOrNull(existing?.retention_50pct),
    retention75pct: numberOrNull(existing?.retention_75pct),
  };
}

async function fetchComments(pool) {
  const { rows } = await pool.query(
    `select comment_id, author_name, text_original, like_count, published_at
       from ops_youtube_comments
      where academy_video_id = $1
      order by published_at asc nulls last
      limit 20`,
    [VIDEO_ID],
  );
  return rows;
}

async function fetchCtaSignals(pool) {
  const ref = 'yt-description-agente-real-whatsapp';
  const candidates = [
    {
      label: 'academy_events ref',
      sql: `select count(*)::int as events
              from academy_events
             where metadata::text ilike $1 or properties::text ilike $1 or url ilike $1`,
    },
    {
      label: 'analytics_events ref',
      sql: `select count(*)::int as events
              from analytics_events
             where metadata::text ilike $1 or properties::text ilike $1 or url ilike $1`,
    },
    {
      label: 'ops_daily_snapshots ref',
      sql: `select count(*)::int as events
              from ops_daily_snapshots
             where academy_json::text ilike $1`,
    },
  ];
  const results = [];
  for (const candidate of candidates) {
    try {
      const { rows } = await pool.query(candidate.sql, [`%${ref}%`]);
      results.push({ source: candidate.label, events: rows[0]?.events ?? 0 });
    } catch (error) {
      results.push({ source: candidate.label, unavailable: error.message });
    }
  }
  return { ref, results };
}

async function loadContext(pool) {
  const [workItem, pipelineItem, ownedVideo, existingSnapshot] = await Promise.all([
    pool.query(
      `select id, status, title, owner_agent, source_type, source_id, scheduled_for, payload, metadata
         from work_items
        where id = $1`,
      [WORK_ITEM_ID],
    ),
    pool.query(
      `select id, title, status, published_at, current_url, metadata
         from pipeline_items
        where pipeline_type = 'video'
          and (current_url ilike $1 or metadata::text ilike $1)
        order by updated_at desc
        limit 1`,
      [`%${VIDEO_ID}%`],
    ),
    pool.query(
      `select academy_video_id, platform_video_id, title, published_at, video_kind, is_published, metadata_json
         from ops_owned_videos
        where academy_video_id = $1 or platform_video_id = $1`,
      [VIDEO_ID],
    ),
    pool.query(
      `select *
         from ops_youtube_video_learning_snapshots
        where academy_video_id = $1 and window_key = $2`,
      [VIDEO_ID, WINDOW_KEY],
    ),
  ]);
  return {
    workItem: workItem.rows[0] || null,
    pipelineItem: pipelineItem.rows[0] || null,
    ownedVideo: ownedVideo.rows[0] || null,
    existingSnapshot: existingSnapshot.rows[0] || null,
  };
}

async function upsertOwnedVideo(pool, videoDetails) {
  const metadata = {
    academy_video_id: VIDEO_ID,
    duration_seconds: videoDetails.durationSeconds,
    privacy_status: videoDetails.privacyStatus,
    upload_status: videoDetails.uploadStatus,
    public_view_count_at_snapshot: videoDetails.publicViewCount,
    public_like_count_at_snapshot: videoDetails.publicLikeCount,
    public_comment_count_at_snapshot: videoDetails.publicCommentCount,
    source: 'collect_youtube_snapshot_work_item',
    classification: {
      video_kind: 'longform',
      is_published: videoDetails.privacyStatus === 'public',
    },
  };
  await pool.query(
    `insert into ops_owned_videos
       (academy_video_id, platform, platform_video_id, title, published_at, video_kind, is_published, metadata_json, synced_at)
     values ($1, 'youtube', $1, $2, $3, 'longform', $4, $5, $6)
     on conflict (academy_video_id)
     do update set
       platform = excluded.platform,
       platform_video_id = excluded.platform_video_id,
       title = excluded.title,
       published_at = coalesce(ops_owned_videos.published_at, excluded.published_at),
       video_kind = excluded.video_kind,
       is_published = excluded.is_published,
       metadata_json = ops_owned_videos.metadata_json || excluded.metadata_json,
       synced_at = excluded.synced_at`,
    [
      VIDEO_ID,
      videoDetails.title || 'Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp',
      videoDetails.publishedAt || PUBLISHED_AT,
      videoDetails.privacyStatus === 'public',
      JSON.stringify(metadata),
      COMPLETED_AT,
    ],
  );
}

async function upsertSnapshot(pool, row) {
  await pool.query(
    `insert into ops_youtube_video_learning_snapshots
       (run_id, academy_video_id, window_key, window_start_date, window_end_date, views,
        impressions, yt_ctr, avg_view_duration_seconds, avg_percent_viewed, retention_30s,
        retention_50pct, retention_75pct, watch_time_minutes, subscribers_gained, traffic_source_top,
        launch_day_impressions, launch_day_yt_ctr, first_7d_impressions, first_7d_yt_ctr,
        first_7d_reach_days_covered, source_freshness_json, raw_metrics_json, computed_at, updated_at)
     values
       (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $23)
     on conflict (academy_video_id, window_key)
     do update set
       window_start_date = excluded.window_start_date,
       window_end_date = excluded.window_end_date,
       views = excluded.views,
       impressions = excluded.impressions,
       yt_ctr = excluded.yt_ctr,
       avg_view_duration_seconds = excluded.avg_view_duration_seconds,
       avg_percent_viewed = excluded.avg_percent_viewed,
       retention_30s = excluded.retention_30s,
       retention_50pct = excluded.retention_50pct,
       retention_75pct = excluded.retention_75pct,
       watch_time_minutes = excluded.watch_time_minutes,
       subscribers_gained = excluded.subscribers_gained,
       traffic_source_top = excluded.traffic_source_top,
       launch_day_impressions = excluded.launch_day_impressions,
       launch_day_yt_ctr = excluded.launch_day_yt_ctr,
       first_7d_impressions = excluded.first_7d_impressions,
       first_7d_yt_ctr = excluded.first_7d_yt_ctr,
       first_7d_reach_days_covered = excluded.first_7d_reach_days_covered,
       source_freshness_json = excluded.source_freshness_json,
       raw_metrics_json = excluded.raw_metrics_json,
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at`,
    [
      VIDEO_ID,
      WINDOW_KEY,
      WINDOW_START_DATE,
      WINDOW_END_DATE,
      row.views,
      row.impressions,
      row.ytCtr,
      row.avgViewDurationSeconds,
      row.avgPercentViewed,
      row.retention30s,
      row.retention50pct,
      row.retention75pct,
      row.watchTimeMinutes,
      row.subscribersGained,
      row.trafficSourceTop,
      row.launchDayImpressions,
      row.launchDayYtCtr,
      row.first7DayImpressions,
      row.first7DayYtCtr,
      row.first7DayReachDaysCovered,
      JSON.stringify(row.sourceFreshness),
      JSON.stringify(row.rawMetrics),
      COMPLETED_AT,
    ],
  );
}

async function updateWorkItemStatus(pool, status, output) {
  await pool.query(
    `update work_items
        set status = $2,
            completed_at = case when $2 = 'done' then $3 else completed_at end,
            output = coalesce(output, '{}'::jsonb) || $4::jsonb,
            updated_at = $3
      where id = $1`,
    [WORK_ITEM_ID, status, COMPLETED_AT, JSON.stringify(output || {})],
  );
}

async function main() {
  const { pool, cacheDb, cacheCopyPath, youtube, analytics } = createClients();
  try {
    await updateWorkItemStatus(pool, 'in_progress', {
      claimed_by: 'codex',
      claimed_at: COMPLETED_AT,
      claim_method: 'direct_postgres_fallback_api_unavailable',
    });

    const contextBefore = await loadContext(pool);
    const videoDetails = await fetchVideoDetails(youtube);
    const isPublic = videoDetails.privacyStatus === 'public' && videoDetails.uploadStatus === 'processed';
    if (!isPublic) {
      await updateWorkItemStatus(pool, 'failed', {
        failed_at: COMPLETED_AT,
        failure_reason: 'youtube_not_public',
        video_details: videoDetails,
      });
      throw new Error(`YouTube video is not public/processed: ${JSON.stringify(videoDetails)}`);
    }

    await upsertOwnedVideo(pool, videoDetails);

    const [analyticsSummary, trafficSource, comments, ctaSignals] = await Promise.all([
      fetchAnalyticsSummary(analytics),
      fetchTopTrafficSource(analytics).catch((error) => `unavailable:${error.message}`),
      fetchComments(pool),
      fetchCtaSignals(pool),
    ]);
    const reach = fetchReachWindow(cacheDb);
    const launchReach = fetchReachWindow(cacheDb, WINDOW_START_DATE, WINDOW_START_DATE);
    const first7Reach = fetchReachWindow(cacheDb, WINDOW_START_DATE, WINDOW_END_DATE);
    const retention = fetchRetentionFromExisting(contextBefore.existingSnapshot);

    const rawMetrics = {
      source: 'collect_youtube_snapshot_work_item',
      videoId: VIDEO_ID,
      title: videoDetails.title,
      window: WINDOW_KEY,
      publishedAtScheduled: PUBLISHED_AT,
      windowStartDate: WINDOW_START_DATE,
      windowEndDate: WINDOW_END_DATE,
      publicVerification: videoDetails,
      analyticsSummary,
      reach,
      comments,
      ctaSignals,
      contextBefore,
    };

    const snapshot = {
      views: analyticsSummary.views,
      impressions: reach.impressions,
      ytCtr: reach.ytCtr,
      avgViewDurationSeconds: analyticsSummary.avgViewDurationSeconds,
      avgPercentViewed: analyticsSummary.avgPercentViewed,
      retention30s: retention.retention30s,
      retention50pct: retention.retention50pct,
      retention75pct: retention.retention75pct,
      watchTimeMinutes: analyticsSummary.watchTimeMinutes,
      subscribersGained: analyticsSummary.subscribersGained,
      trafficSourceTop: typeof trafficSource === 'string' && trafficSource.startsWith('unavailable:') ? null : trafficSource,
      launchDayImpressions: launchReach.impressions,
      launchDayYtCtr: launchReach.ytCtr,
      first7DayImpressions: first7Reach.impressions,
      first7DayYtCtr: first7Reach.ytCtr,
      first7DayReachDaysCovered: first7Reach.daysCovered,
      sourceFreshness: {
        analytics: 'fresh_youtube_analytics_api',
        public_verification: 'fresh_youtube_data_api',
        reach: reach.daysCovered > 0 ? 'youtube_mcp_reach_cache' : 'missing',
        retention: retention.retention30s !== null ? 'preserved_existing' : 'missing',
        comments: comments.length ? 'canonical_ops_youtube_comments' : 'none_in_canonical_table',
        cta: 'canonical_table_probe',
      },
      rawMetrics,
    };

    await upsertSnapshot(pool, snapshot);

    const summary = {
      video_id: VIDEO_ID,
      title: videoDetails.title,
      youtube_url: `https://youtu.be/${VIDEO_ID}`,
      playlist_context_url: `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PLItELtCfBA39ig81F5j9wcMqclkhfdKaL`,
      published_at_scheduled_utc: PUBLISHED_AT,
      snapshot_window: WINDOW_KEY,
      window_start_date: WINDOW_START_DATE,
      window_end_date: WINDOW_END_DATE,
      public_live_verified: true,
      public_verification: {
        privacy_status: videoDetails.privacyStatus,
        upload_status: videoDetails.uploadStatus,
        published_at: videoDetails.publishedAt,
        duration_seconds: videoDetails.durationSeconds,
      },
      metrics: {
        views: snapshot.views,
        impressions: snapshot.impressions,
        yt_ctr: snapshot.ytCtr,
        avg_view_duration: formatSeconds(snapshot.avgViewDurationSeconds),
        avg_view_duration_seconds: snapshot.avgViewDurationSeconds,
        avg_percent_viewed: snapshot.avgPercentViewed,
        retention_30s: snapshot.retention30s,
        retention_50pct: snapshot.retention50pct,
        retention_75pct: snapshot.retention75pct,
        watch_time_minutes: snapshot.watchTimeMinutes,
        subscribers_gained: snapshot.subscribersGained,
        traffic_source_top: snapshot.trafficSourceTop,
      },
      comments_qualitative: comments.map((comment) => ({
        author_name: comment.author_name,
        text_original: comment.text_original,
        like_count: comment.like_count,
        published_at: comment.published_at,
      })),
      cta_clicks_ref: ctaSignals,
      availability_notes: {
        packaging: snapshot.impressions !== null ? 'available from reach cache' : 'missing',
        retention: snapshot.retention30s !== null ? 'available/preserved' : 'not available in canonical snapshot/API script',
        comments: comments.length ? 'available in ops_youtube_comments' : 'no comments found in canonical table',
        cta_clicks: 'probed canonical tables for ref=yt-description-agente-real-whatsapp',
      },
    };

    await updateWorkItemStatus(pool, 'done', {
      completed_by: 'codex',
      completed_at: COMPLETED_AT,
      youtube_snapshot_7d: summary,
      status_update_method: 'direct_postgres_fallback_api_unavailable',
    });

    console.log(JSON.stringify({ ok: true, summary }, null, 2));
  } finally {
    cacheDb.close();
    if (cacheCopyPath) {
      try { fs.unlinkSync(cacheCopyPath); } catch {}
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
