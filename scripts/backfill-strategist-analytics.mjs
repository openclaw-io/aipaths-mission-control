#!/usr/bin/env node

import {
  IN_SCOPE_TABLES,
  createPipelineRun,
  createSupabasePair,
  finishPipelineRun,
  isoStartOfDay,
  loadAcademyVideos,
  loadIntelSourceMap,
  makeOwnedVideoRow,
  parseCliArgs,
  printUsage,
  safeJson,
  summarizeDateRange,
  upsertBatches,
  fetchAllRows,
} from './lib/strategist-backfill-common.mjs';

function buildExternalSignalsRows(sourceRows, intelSourceMap, runId) {
  const missingSources = [...new Set(sourceRows.map((row) => row.source).filter((key) => !intelSourceMap.has(key)))];
  if (missingSources.length) {
    throw new Error(`Missing intel_sources entries for: ${missingSources.join(', ')}`);
  }

  return sourceRows.map((row) => {
    const sourceRecord = intelSourceMap.get(row.source);
    const metadataJson = safeJson(row.metadata);

    return {
      source_id: sourceRecord.id,
      run_id: runId,
      lane: sourceRecord.lane,
      captured_on: row.date,
      external_id: row.id != null ? String(row.id) : null,
      url: row.url,
      canonical_url: row.url,
      title: row.title,
      author: row.author || null,
      published_at: null,
      first_seen_at: isoStartOfDay(row.date),
      engagement_score: row.score || 0,
      engagement_count: row.comments_count || 0,
      source_context: row.subreddit || null,
      content_text: null,
      raw_json: row,
      metadata_json: metadataJson,
      content_hash: null,
      language: null,
      fetch_status: 'ok',
    };
  });
}

function buildTrendRows(sourceRows, runId) {
  return sourceRows.map((row) => ({
    run_id: runId,
    date: row.date,
    keyword: row.keyword,
    score: row.score || 0,
    country: row.country || 'AR',
    source_key: row.source || 'google_trends',
    metadata_json: safeJson(row.metadata),
  }));
}

function buildCommunityRows(sourceRows, runId) {
  return sourceRows.map((row) => ({
    run_id: runId,
    date: row.date,
    channel_id: row.channel_id,
    channel_name: row.channel_name || null,
    message_count: row.message_count || 0,
    unique_authors: row.unique_authors || 0,
    notable_messages_json: safeJson(row.notable_messages),
  }));
}

function buildChannelMetricRows(sourceRows, runId) {
  return sourceRows.map((row) => ({
    run_id: runId,
    date: row.date,
    subscribers: row.subscribers || 0,
    total_views: row.total_views || 0,
    watch_time_minutes: row.watch_time_minutes || 0,
    revenue: row.revenue || 0,
    videos_published: row.videos_published || 0,
    net_subscribers: row.net_subscribers || 0,
  }));
}

function buildYouTubeRows(sourceRows, videosMap, runId, videoKind) {
  const ownedVideoMap = new Map();

  for (const row of sourceRows) {
    if (!ownedVideoMap.has(row.video_id)) {
      ownedVideoMap.set(
        row.video_id,
        makeOwnedVideoRow({
          academyVideoId: row.video_id,
          videoKind,
          videoMeta: videosMap.get(row.video_id),
        }),
      );
    }
  }

  const dailyRows = sourceRows.map((row) => ({
    run_id: runId,
    academy_video_id: row.video_id,
    date: row.date,
    views: row.views || 0,
    likes: row.likes || 0,
    comments_count: row.comments_count || 0,
    subscribers_gained: row.subscribers_gained || 0,
    watch_time_minutes: row.watch_time_minutes || 0,
    avg_view_duration_seconds: row.avg_view_duration_seconds || 0,
  }));

  return {
    ownedVideoRows: [...ownedVideoMap.values()],
    dailyRows,
  };
}

function buildShortRows(sourceRows, videosMap, runId) {
  const ownedVideoMap = new Map();

  for (const row of sourceRows) {
    if (!ownedVideoMap.has(row.video_id)) {
      ownedVideoMap.set(
        row.video_id,
        makeOwnedVideoRow({
          academyVideoId: row.video_id,
          videoKind: 'short',
          videoMeta: videosMap.get(row.video_id),
        }),
      );
    }
  }

  const dailyRows = sourceRows.map((row) => ({
    run_id: runId,
    academy_video_id: row.video_id,
    date: row.date,
    views: row.views || 0,
    likes: row.likes || 0,
    comments_count: row.comments_count || 0,
  }));

  return {
    ownedVideoRows: [...ownedVideoMap.values()],
    dailyRows,
  };
}

function buildCommentRows(sourceRows, videosMap, runId) {
  const ownedVideoMap = new Map();

  for (const row of sourceRows) {
    if (!ownedVideoMap.has(row.video_id)) {
      ownedVideoMap.set(
        row.video_id,
        makeOwnedVideoRow({
          academyVideoId: row.video_id,
          videoKind: 'longform',
          videoMeta: videosMap.get(row.video_id),
        }),
      );
    }
  }

  const commentRows = sourceRows.map((row) => ({
    run_id: runId,
    academy_video_id: row.video_id,
    comment_id: row.comment_id,
    author_name: row.author_name || null,
    author_channel_id: row.author_channel_id || null,
    text: row.text,
    like_count: row.like_count || 0,
    reply_count: row.reply_count || 0,
    is_hearted: row.is_hearted || false,
    published_at: row.published_at,
    scraped_at: row.scraped_at || row.published_at || new Date().toISOString(),
    metadata_json: {
      source: 'academy.youtube_comments',
    },
  }));

  return {
    ownedVideoRows: [...ownedVideoMap.values()],
    commentRows,
  };
}

async function runBackfillForTable({ mission, academy, table, write, limit, intelSourceMap, academyVideosMap }) {
  console.log(`\n=== ${table} ===`);
  const sourceRows = await fetchAllRows(academy, table, { limit });
  const dateSummary = summarizeDateRange(sourceRows, 'date');
  console.log(`Source rows: ${sourceRows.length}${dateSummary.latest ? ` | latest=${dateSummary.latest}` : ''}`);

  if (!sourceRows.length) {
    console.log('Nothing to backfill.');
    return { table, sourceRows: 0, rowsWritten: 0, dryRun: !write };
  }

  let runId = null;
  const metadata = {
    source_table: table,
    dry_run: !write,
    limit,
  };

  if (write) {
    runId = await createPipelineRun(mission, `backfill:${table}`, metadata);
    console.log(`pipeline_runs.id=${runId}`);
  }

  try {
    let rowsRead = sourceRows.length;
    let rowsWritten = 0;

    if (table === 'external_signals') {
      const destinationRows = buildExternalSignalsRows(sourceRows, intelSourceMap, runId);
      console.log(`Destination: intel_items_raw (${destinationRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'intel_items_raw',
          rows: destinationRows,
          onConflict: 'source_id,canonical_url',
        });
      }
    } else if (table === 'trend_snapshots') {
      const destinationRows = buildTrendRows(sourceRows, runId);
      console.log(`Destination: intel_trend_daily (${destinationRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'intel_trend_daily',
          rows: destinationRows,
          onConflict: 'date,keyword,country,source_key',
        });
      }
    } else if (table === 'community_activity') {
      const destinationRows = buildCommunityRows(sourceRows, runId);
      console.log(`Destination: ops_community_daily (${destinationRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_community_daily',
          rows: destinationRows,
          onConflict: 'date,channel_id',
        });
      }
    } else if (table === 'channel_metrics') {
      const destinationRows = buildChannelMetricRows(sourceRows, runId);
      console.log(`Destination: ops_youtube_channel_daily (${destinationRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_youtube_channel_daily',
          rows: destinationRows,
          onConflict: 'date',
        });
      }
    } else if (table === 'youtube_metrics') {
      const { ownedVideoRows, dailyRows } = buildYouTubeRows(sourceRows, academyVideosMap, runId, 'longform');
      console.log(`Destination: ops_owned_videos (${ownedVideoRows.length} rows), ops_youtube_video_daily (${dailyRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_owned_videos',
          rows: ownedVideoRows,
          onConflict: 'academy_video_id',
        });
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_youtube_video_daily',
          rows: dailyRows,
          onConflict: 'academy_video_id,date',
        });
      }
    } else if (table === 'youtube_shorts_metrics') {
      const { ownedVideoRows, dailyRows } = buildShortRows(sourceRows, academyVideosMap, runId);
      console.log(`Destination: ops_owned_videos (${ownedVideoRows.length} rows), ops_youtube_short_daily (${dailyRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_owned_videos',
          rows: ownedVideoRows,
          onConflict: 'academy_video_id',
        });
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_youtube_short_daily',
          rows: dailyRows,
          onConflict: 'academy_video_id,date',
        });
      }
    } else if (table === 'youtube_comments') {
      const { ownedVideoRows, commentRows } = buildCommentRows(sourceRows, academyVideosMap, runId);
      console.log(`Destination: ops_owned_videos (${ownedVideoRows.length} rows), ops_youtube_comments (${commentRows.length} rows)`);
      if (write) {
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_owned_videos',
          rows: ownedVideoRows,
          onConflict: 'academy_video_id',
        });
        rowsWritten += await upsertBatches({
          mission,
          table: 'ops_youtube_comments',
          rows: commentRows,
          onConflict: 'comment_id',
        });
      }
    } else {
      throw new Error(`Unsupported table: ${table}`);
    }

    if (write) {
      await finishPipelineRun(mission, runId, {
        status: 'ok',
        rows_read: rowsRead,
        rows_written: rowsWritten,
        rows_skipped: 0,
        error_summary: null,
      });
    }

    if (!write) {
      console.log('Dry-run only, no data written.');
    } else {
      console.log(`Write complete: ${rowsWritten} rows upserted.`);
    }

    return { table, sourceRows: rowsRead, rowsWritten, dryRun: !write };
  } catch (error) {
    if (write && runId != null) {
      await finishPipelineRun(mission, runId, {
        status: 'error',
        rows_read: sourceRows.length,
        rows_written: 0,
        rows_skipped: 0,
        error_summary: error.message,
      });
    }
    throw error;
  }
}

async function main() {
  const options = parseCliArgs();

  if (options.help || !options.tables.length) {
    printUsage('scripts/backfill-strategist-analytics.mjs');
    console.log(`\nIn-scope tables: ${IN_SCOPE_TABLES.join(', ')}`);
    console.log('\nNotes:');
    console.log('- dry-run is the default');
    console.log('- writes happen only with --write');
    console.log('- academy_daily_kpis / ops_daily_snapshots historical backfill remains phase 2');
    process.exit(options.help ? 0 : 1);
  }

  const { mission, academy } = createSupabasePair();
  const intelSourceMap = options.tables.includes('external_signals')
    ? await loadIntelSourceMap(mission)
    : new Map();
  const academyVideosMap = options.tables.some((table) => table === 'youtube_metrics' || table === 'youtube_shorts_metrics' || table === 'youtube_comments')
    ? await loadAcademyVideos(academy)
    : new Map();

  console.log(`Mode: ${options.write ? 'WRITE' : 'DRY-RUN'}`);
  console.log(`Tables: ${options.tables.join(', ')}`);
  if (options.limit != null) console.log(`Limit: ${options.limit}`);

  const results = [];
  for (const table of options.tables) {
    const result = await runBackfillForTable({
      mission,
      academy,
      table,
      write: options.write,
      limit: options.limit,
      intelSourceMap,
      academyVideosMap,
    });
    results.push(result);
  }

  console.log('\n=== Summary ===');
  for (const result of results) {
    console.log(
      `${result.table}: source=${result.sourceRows}, ${result.dryRun ? 'dry-run' : `written=${result.rowsWritten}`}`,
    );
  }
}

main().catch((error) => {
  console.error(`\nBackfill failed: ${error.message}`);
  process.exit(1);
});
