import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStatisticsWindowPeriod,
  isDashboardMetricRowEligibleForStatistics,
  mapDashboardMetricRowToOwnedVideo,
  mapDashboardMetricRowToSnapshot,
  mergeOwnedVideoUpsertRow,
  parseBatchSyncArgs,
  parseSyncArgs,
  parseMcpTextJson,
  shouldMaterializeWindowForVideo,
} from '../youtube-statistics-sync-common.mjs';

test('parseSyncArgs defaults to all windows, longform, limit 100, write mode', () => {
  assert.deepEqual(parseSyncArgs([]), {
    windows: ['7d', '28d', 'lifetime'],
    videoType: 'longform',
    limit: 100,
    offset: 0,
    dryRun: false,
    includeRetentionCurve: false,
    help: false,
  });
});

test('parseSyncArgs supports one window, dry-run, limit, offset and retention curve flag', () => {
  assert.deepEqual(parseSyncArgs(['--window=28d', '--limit=5', '--offset=20', '--dry-run', '--include-retention-curve=true']), {
    windows: ['28d'],
    videoType: 'longform',
    limit: 5,
    offset: 20,
    dryRun: true,
    includeRetentionCurve: true,
    help: false,
  });
});

test('parseBatchSyncArgs supports rolling and launch windows', () => {
  assert.deepEqual(parseBatchSyncArgs(['--window=all', '--dry-run']), {
    windows: ['7d', '28d', 'lifetime', 'launch_day', 'first_7d', 'first_28d'],
    dryRun: true,
    help: false,
  });
  assert.deepEqual(parseBatchSyncArgs(['--window=launch']), {
    windows: ['launch_day', 'first_7d', 'first_28d'],
    dryRun: false,
    help: false,
  });
});

test('getStatisticsWindowPeriod distinguishes rolling and launch-relative windows', () => {
  assert.deepEqual(getStatisticsWindowPeriod({ windowKey: '7d', publishedAt: '2026-06-01T12:00:00Z', today: '2026-06-26' }), {
    startDate: '2026-06-20',
    endDate: '2026-06-26',
  });
  assert.deepEqual(getStatisticsWindowPeriod({ windowKey: 'launch_day', publishedAt: '2026-06-01T12:00:00Z', today: '2026-06-26' }), {
    startDate: '2026-06-01',
    endDate: '2026-06-01',
  });
  assert.deepEqual(getStatisticsWindowPeriod({ windowKey: 'first_7d', publishedAt: '2026-06-01T12:00:00Z', today: '2026-06-26' }), {
    startDate: '2026-06-01',
    endDate: '2026-06-07',
  });
  assert.deepEqual(getStatisticsWindowPeriod({ windowKey: 'first_28d', publishedAt: '2026-06-01T12:00:00Z', today: '2026-06-26' }), {
    startDate: '2026-06-01',
    endDate: '2026-06-28',
  });
});

test('shouldMaterializeWindowForVideo waits until launch windows have matured', () => {
  assert.equal(shouldMaterializeWindowForVideo({ windowKey: 'launch_day', publishedAt: '2026-06-25T12:00:00Z', today: '2026-06-26' }), true);
  assert.equal(shouldMaterializeWindowForVideo({ windowKey: 'first_7d', publishedAt: '2026-06-20T12:00:00Z', today: '2026-06-26' }), false);
  assert.equal(shouldMaterializeWindowForVideo({ windowKey: 'first_7d', publishedAt: '2026-06-19T12:00:00Z', today: '2026-06-26' }), true);
  assert.equal(shouldMaterializeWindowForVideo({ windowKey: 'first_28d', publishedAt: '2026-05-30T12:00:00Z', today: '2026-06-26' }), false);
  assert.equal(shouldMaterializeWindowForVideo({ windowKey: 'first_28d', publishedAt: '2026-05-29T12:00:00Z', today: '2026-06-26' }), true);
});

test('parseMcpTextJson unwraps MCP content text JSON when needed', () => {
  const payload = { content: [{ type: 'text', text: '{"rows":[{"videoId":"abc"}]}' }] };
  assert.deepEqual(parseMcpTextJson(JSON.stringify(payload)), { rows: [{ videoId: 'abc' }] });
});

test('mapDashboardMetricRowToOwnedVideo maps dashboard video metadata for FK-safe upsert', () => {
  assert.deepEqual(mapDashboardMetricRowToOwnedVideo({
    videoId: 'abc123',
    title: 'Demo video',
    publishedAt: '2026-06-20T10:00:00Z',
    durationSeconds: 421,
    durationFormatted: '7:01',
  }, '2026-06-25T10:00:00.000Z'), {
    academy_video_id: 'abc123',
    platform: 'youtube',
    platform_video_id: 'abc123',
    title: 'Demo video',
    published_at: '2026-06-20T10:00:00Z',
    video_kind: 'longform',
    is_published: null,
    metadata_json: {
      academy_video_id: 'abc123',
      duration_seconds: 421,
      duration_formatted: '7:01',
      classification: {
        video_kind: 'longform',
        is_published: null,
        excluded_by_title: false,
        exclusion_reasons: [],
      },
      source: 'youtube_statistics_sync',
    },
    synced_at: '2026-06-25T10:00:00.000Z',
  });
});

test('mapDashboardMetricRowToOwnedVideo classifies sub-180-second metric rows as shorts', () => {
  const row = mapDashboardMetricRowToOwnedVideo({
    videoId: 'short123',
    title: 'Short demo',
    durationSeconds: 88,
    durationFormatted: '1:28',
  }, '2026-06-25T10:00:00.000Z');

  assert.equal(row.video_kind, 'short');
  assert.equal(row.is_published, null);
  assert.equal(row.metadata_json.duration_seconds, 88);
  assert.deepEqual(row.metadata_json.classification.exclusion_reasons, ['duration_lt_180']);
});

test('mergeOwnedVideoUpsertRow preserves existing short and non-public classification', () => {
  const merged = mergeOwnedVideoUpsertRow({
    current: {
      academy_video_id: 'abc123',
      video_kind: 'short',
      is_published: false,
      metadata_json: {
        duration_seconds: 88,
        privacy_status: 'unlisted',
      },
    },
    row: {
      academy_video_id: 'abc123',
      platform: 'youtube',
      platform_video_id: 'abc123',
      title: 'Demo',
      published_at: '2026-06-20T10:00:00Z',
      video_kind: 'longform',
      is_published: true,
      metadata_json: {
        academy_video_id: 'abc123',
        source: 'youtube_statistics_sync',
      },
      synced_at: '2026-06-25T10:00:00.000Z',
    },
  });

  assert.equal(merged.video_kind, 'short');
  assert.equal(merged.is_published, false);
  assert.equal(merged.metadata_json.duration_seconds, 88);
  assert.equal(merged.metadata_json.privacy_status, 'unlisted');
});

test('mergeOwnedVideoUpsertRow keeps public rows published when sync row lacks privacy', () => {
  const merged = mergeOwnedVideoUpsertRow({
    current: {
      academy_video_id: 'public123',
      video_kind: 'longform',
      is_published: true,
      metadata_json: {
        duration_seconds: 421,
        privacy_status: 'public',
      },
    },
    row: {
      academy_video_id: 'public123',
      platform: 'youtube',
      platform_video_id: 'public123',
      title: 'Public demo',
      published_at: null,
      video_kind: 'longform',
      is_published: null,
      metadata_json: {
        academy_video_id: 'public123',
        duration_seconds: 421,
        source: 'youtube_statistics_sync',
      },
      synced_at: '2026-06-25T10:00:00.000Z',
    },
  });

  assert.equal(merged.video_kind, 'longform');
  assert.equal(merged.is_published, true);
  assert.equal(merged.metadata_json.privacy_status, 'public');
});

test('isDashboardMetricRowEligibleForStatistics excludes shorts, unknown duration and class titles', () => {
  assert.equal(isDashboardMetricRowEligibleForStatistics({ title: 'Long video', durationSeconds: 421 }), true);
  assert.equal(isDashboardMetricRowEligibleForStatistics({ title: 'Short video', durationSeconds: 88 }), false);
  assert.equal(isDashboardMetricRowEligibleForStatistics({ title: 'Unknown duration' }), false);
  assert.equal(isDashboardMetricRowEligibleForStatistics({ title: 'Clase #1 Bootcamp Marzo 2026', durationSeconds: 8220 }), false);
});

test('mapDashboardMetricRowToSnapshot maps dashboard metrics to canonical DB row', () => {
  const row = mapDashboardMetricRowToSnapshot({
    windowKey: '28d',
    period: { startDate: '2026-05-29', endDate: '2026-06-25' },
    runId: 42,
    computedAt: '2026-06-25T10:00:00.000Z',
    metric: {
      videoId: 'abc123',
      views: 1000,
      impressions: 5000,
      ytCtr: 4.2,
      avgViewDurationSeconds: 321,
      avgViewPercentage: 41.5,
      watchTimeMinutes: 5350,
      subscribersGained: 17,
      trafficSourceTop: 'YT_SEARCH',
      retention30s: 72.4,
      retention50pct: 45.1,
      retention75pct: 31.2,
      launchDayImpressions: 800,
      launchDayYtCtr: 5.5,
      first7DayImpressions: 2400,
      first7DayYtCtr: 4.9,
      first7DayReachDaysCovered: 7,
      reachDataFreshness: 'fresh',
    },
  });

  assert.equal(row.run_id, 42);
  assert.equal(row.academy_video_id, 'abc123');
  assert.equal(row.window_key, '28d');
  assert.equal(row.window_start_date, '2026-05-29');
  assert.equal(row.window_end_date, '2026-06-25');
  assert.equal(row.views, 1000);
  assert.equal(row.impressions, 5000);
  assert.equal(row.yt_ctr, 4.2);
  assert.equal(row.avg_view_duration_seconds, 321);
  assert.equal(row.retention_30s, 72.4);
  assert.equal(row.first_7d_reach_days_covered, 7);
  assert.deepEqual(row.source_freshness_json, { reach: 'fresh', retention: 'ok' });
  assert.equal(row.raw_metrics_json.videoId, 'abc123');
});
