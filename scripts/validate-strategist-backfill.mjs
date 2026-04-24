#!/usr/bin/env node

import {
  IN_SCOPE_TABLES,
  createSupabasePair,
  fetchAllRows,
  fetchCountAndLatest,
  loadIntelSourceMap,
  parseCliArgs,
  summarizeDateRange,
} from './lib/strategist-backfill-common.mjs';

function uniqueCount(rows, field) {
  return new Set(rows.map((row) => row[field]).filter(Boolean)).size;
}

function printRow(label, sourceCount, sourceLatest, destCount, destLatest) {
  const countOk = sourceCount === destCount ? 'OK' : 'DIFF';
  const latestOk = sourceLatest === destLatest ? 'OK' : 'DIFF';
  console.log(`${label}`);
  console.log(`  source count=${sourceCount} latest=${sourceLatest || '-'} | dest count=${destCount} latest=${destLatest || '-'} | count:${countOk} latest:${latestOk}`);
}

async function validateExternalSignals({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'external_signals');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const intelSourceMap = await loadIntelSourceMap(mission);
  const sourceIds = [...intelSourceMap.values()]
    .filter((row) => ['hackernews', 'reddit', 'producthunt', 'news'].includes(row.source_key))
    .map((row) => row.id);

  const destSummary = sourceIds.length
    ? await fetchCountAndLatest(mission, 'intel_items_raw', 'captured_on', (query) => query.in('source_id', sourceIds))
    : { count: 0, latest: null };

  printRow('external_signals -> intel_items_raw', sourceSummary.count, sourceSummary.latest, destSummary.count, destSummary.latest);
}

async function validateTrendSnapshots({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'trend_snapshots');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const destSummary = await fetchCountAndLatest(mission, 'intel_trend_daily', 'date');
  printRow('trend_snapshots -> intel_trend_daily', sourceSummary.count, sourceSummary.latest, destSummary.count, destSummary.latest);
}

async function validateCommunityActivity({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'community_activity');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const destSummary = await fetchCountAndLatest(mission, 'ops_community_daily', 'date');
  printRow('community_activity -> ops_community_daily', sourceSummary.count, sourceSummary.latest, destSummary.count, destSummary.latest);
}

async function validateChannelMetrics({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'channel_metrics');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const destSummary = await fetchCountAndLatest(mission, 'ops_youtube_channel_daily', 'date');
  printRow('channel_metrics -> ops_youtube_channel_daily', sourceSummary.count, sourceSummary.latest, destSummary.count, destSummary.latest);
}

async function validateYoutubeMetrics({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'youtube_metrics');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const destDailySummary = await fetchCountAndLatest(mission, 'ops_youtube_video_daily', 'date');
  const destOwnedSummary = await fetchCountAndLatest(
    mission,
    'ops_owned_videos',
    'published_at',
    (query) => query.eq('video_kind', 'longform'),
  );

  printRow('youtube_metrics -> ops_youtube_video_daily', sourceSummary.count, sourceSummary.latest, destDailySummary.count, destDailySummary.latest);
  console.log(`  longform unique video ids source=${uniqueCount(sourceRows, 'video_id')} | ops_owned_videos(longform)=${destOwnedSummary.count}`);
}

async function validateYoutubeShorts({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'youtube_shorts_metrics');
  const sourceSummary = summarizeDateRange(sourceRows, 'date');
  const destDailySummary = await fetchCountAndLatest(mission, 'ops_youtube_short_daily', 'date');
  const destOwnedSummary = await fetchCountAndLatest(
    mission,
    'ops_owned_videos',
    'published_at',
    (query) => query.eq('video_kind', 'short'),
  );

  printRow('youtube_shorts_metrics -> ops_youtube_short_daily', sourceSummary.count, sourceSummary.latest, destDailySummary.count, destDailySummary.latest);
  console.log(`  short unique video ids source=${uniqueCount(sourceRows, 'video_id')} | ops_owned_videos(short)=${destOwnedSummary.count}`);
}

async function validateYoutubeComments({ academy, mission }) {
  const sourceRows = await fetchAllRows(academy, 'youtube_comments');
  const sourceSummary = summarizeDateRange(sourceRows, 'published_at');
  const destSummary = await fetchCountAndLatest(mission, 'ops_youtube_comments', 'published_at');
  const destRows = await fetchAllRows(mission, 'ops_youtube_comments', { select: 'academy_video_id' });

  printRow('youtube_comments -> ops_youtube_comments', sourceSummary.count, sourceSummary.latest, destSummary.count, destSummary.latest);
  console.log(`  longform unique video ids source=${uniqueCount(sourceRows, 'video_id')} | ops_youtube_comments unique academy_video_id=${uniqueCount(destRows, 'academy_video_id')}`);
}

async function main() {
  const options = parseCliArgs();
  if (options.write) {
    throw new Error('Validation does not support --write');
  }
  if (options.limit != null) {
    throw new Error('Validation does not support --limit');
  }

  if (options.help || !options.tables.length) {
    console.log('Usage:');
    console.log('  node scripts/validate-strategist-backfill.mjs --all');
    console.log('  node scripts/validate-strategist-backfill.mjs --table=external_signals [--table=trend_snapshots] [--table=youtube_comments]');
    console.log(`\nIn-scope tables: ${IN_SCOPE_TABLES.join(', ')}`);
    console.log('\nNotes:');
    console.log('- validation is read-only');
    console.log('- --write is not supported');
    process.exit(options.help ? 0 : 1);
  }

  const { mission, academy } = createSupabasePair();

  console.log(`Validating tables: ${options.tables.join(', ')}`);
  console.log('');

  for (const table of options.tables) {
    if (table === 'external_signals') {
      await validateExternalSignals({ academy, mission });
    } else if (table === 'trend_snapshots') {
      await validateTrendSnapshots({ academy, mission });
    } else if (table === 'community_activity') {
      await validateCommunityActivity({ academy, mission });
    } else if (table === 'channel_metrics') {
      await validateChannelMetrics({ academy, mission });
    } else if (table === 'youtube_metrics') {
      await validateYoutubeMetrics({ academy, mission });
    } else if (table === 'youtube_shorts_metrics') {
      await validateYoutubeShorts({ academy, mission });
    } else if (table === 'youtube_comments') {
      await validateYoutubeComments({ academy, mission });
    }

    console.log('');
  }
}

main().catch((error) => {
  console.error(`Validation failed: ${error.message}`);
  process.exit(1);
});
