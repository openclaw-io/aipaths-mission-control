#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMissionControlDb, getMissionControlDatabaseUrl } from './lib/mission-control-db.mjs';
import {
  isDashboardMetricRowEligibleForStatistics,
  loadEnvFile,
  mapDashboardMetricRowToOwnedVideo,
  mapDashboardMetricRowToSnapshot,
  mergeOwnedVideoUpsertRow,
  parseMcpTextJson,
  parseSyncArgs,
} from './lib/youtube-statistics-sync-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env.local');
const YOUTUBE_MCP_SCRIPT = '/Users/joaco/Repos/mcps/youtube_mcp/dist/src/index.js';
const YOUTUBE_MCP_ENV = '/Users/joaco/Repos/mcps/youtube_mcp/.env';

function printUsage() {
  console.log('Usage:');
  console.log('  npm run sync:youtube-statistics -- --window=28d --limit=10 --dry-run');
  console.log('  npm run sync:youtube-statistics -- --window=all --limit=100');
  console.log('');
  console.log('Options:');
  console.log('  --window=7d|28d|lifetime|all   default: all');
  console.log('  --limit=N                       default: 100');
  console.log('  --offset=N                      default: 0');
  console.log('  --dry-run                       call MCP and print summary, no DB writes');
  console.log('  --include-retention-curve=true  default: false');
}

async function main() {
  const options = parseSyncArgs();
  if (options.help) {
    printUsage();
    return;
  }

  const env = loadEnvFile(ENV_PATH);
  const db = options.dryRun ? null : createMissionControlDb({ env, envPath: ENV_PATH });
  const dbDescription = db?.description || (getMissionControlDatabaseUrl(env)
    ? 'local Postgres via MISSION_CONTROL_DATABASE_URL (dry-run; no writes)'
    : 'Supabase fallback (dry-run; no writes; MISSION_CONTROL_DATABASE_URL not set)');
  console.log(`Mission Control DB: ${dbDescription}`);
  const computedAt = new Date().toISOString();
  let runId = null;
  let totalRows = 0;
  const perWindow = [];

  if (!options.dryRun) {
    runId = await db.createPipelineRun(options);
    console.log(`pipeline_runs.id=${runId}`);
  }

  try {
    for (const windowKey of options.windows) {
      console.log(`\n=== ${windowKey} ===`);
      const payload = await callDashboardMetrics({
        windowKey,
        videoType: options.videoType,
        limit: options.limit,
        offset: options.offset,
        includeRetentionCurve: options.includeRetentionCurve,
      });
      const metricRows = payload.rows || [];
      const eligibleMetricRows = metricRows.filter(isDashboardMetricRowEligibleForStatistics);
      const rows = eligibleMetricRows.map((metric) => mapDashboardMetricRowToSnapshot({
        windowKey,
        period: payload.period,
        metric,
        runId,
        computedAt,
      }));

      totalRows += rows.length;
      perWindow.push({ window: windowKey, rows: rows.length, sourceRows: metricRows.length, skippedRows: metricRows.length - eligibleMetricRows.length });
      console.log(`MCP rows: ${metricRows.length}; eligible Statistics rows: ${rows.length}`);

      if (options.dryRun) {
        const sample = rows.slice(0, 3).map((row) => ({
          academy_video_id: row.academy_video_id,
          window_key: row.window_key,
          views: row.views,
          impressions: row.impressions,
          yt_ctr: row.yt_ctr,
          avg_view_duration_seconds: row.avg_view_duration_seconds,
          retention_30s: row.retention_30s,
          source_freshness_json: row.source_freshness_json,
        }));
        console.log(JSON.stringify({ sample }, null, 2));
      } else if (metricRows.length > 0) {
        await upsertOwnedVideoRows(db, metricRows.map((metric) => mapDashboardMetricRowToOwnedVideo(metric, computedAt)));
        if (rows.length > 0) {
          await db.upsertSnapshotRows(rows);
        }
        console.log(`Upserted ${metricRows.length} rows into ops_owned_videos and ${rows.length} rows into ops_youtube_video_learning_snapshots`);
      }
    }

    if (!options.dryRun) {
      await db.finishPipelineRun(runId, {
        status: 'ok',
        rows_read: totalRows,
        rows_written: totalRows,
        error_summary: null,
      });
    }

    console.log('\n=== Summary ===');
    console.log(JSON.stringify({ dryRun: options.dryRun, totalRows, perWindow }, null, 2));
  } catch (error) {
    if (!options.dryRun && runId != null) {
      await db.finishPipelineRun(runId, {
        status: 'error',
        rows_read: totalRows,
        rows_written: 0,
        error_summary: error.message,
      });
    }
    throw error;
  } finally {
    if (db) await db.close();
  }
}

async function callDashboardMetrics({ windowKey, videoType, limit, offset, includeRetentionCurve }) {
  const parsed = await callMcpTool('yt_dashboard_metrics', {
    window: windowKey,
    videoType,
    limit,
    offset,
    includeRetentionCurve,
  });
  if (!Array.isArray(parsed.rows)) {
    throw new Error(`yt_dashboard_metrics returned no rows array for ${windowKey}`);
  }
  return parsed;
}

function callMcpTool(toolName, toolArgs, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const server = spawn('node', [YOUTUBE_MCP_SCRIPT], {
      cwd: path.dirname(YOUTUBE_MCP_SCRIPT),
      env: { ...process.env, DOTENV_CONFIG_PATH: YOUTUBE_MCP_ENV },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let buffer = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { server.kill(); } catch {}
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${toolName}`));
    }, timeoutMs);

    function finish(fn, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { server.kill(); } catch {}
      fn(value);
    }

    function send(message) {
      server.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message.id == null && message.method) return;
      if (message.id === 1) {
        if (message.error) {
          finish(reject, new Error(`MCP initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: toolName, arguments: toolArgs },
        });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish(reject, new Error(`MCP tool failed: ${JSON.stringify(message.error)}`));
          return;
        }
        const content = message.result?.content;
        const text = Array.isArray(content) ? content.find((item) => item.type === 'text')?.text : null;
        if (!text) {
          finish(reject, new Error(`MCP tool ${toolName} returned no text content`));
          return;
        }
        try {
          finish(resolve, parseMcpTextJson(text));
        } catch (error) {
          finish(reject, error);
        }
      }
    }

    server.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // Ignore non-JSON stdout noise.
        }
      }
    });

    server.on('error', (error) => finish(reject, error));
    server.on('close', (code) => {
      if (!finished) finish(reject, new Error(`MCP server exited before response, code=${code}`));
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mission-control-youtube-statistics-sync', version: '1.0.0' },
      },
    });
  });
}

async function upsertOwnedVideoRows(db, rows) {
  const ids = rows.map((row) => row.academy_video_id);
  const existing = await db.loadOwnedVideoRowsByIds(ids);

  const existingById = new Map((existing || []).map((row) => [row.academy_video_id, row]));
  const mergedRows = rows.map((row) => mergeOwnedVideoUpsertRow({
    current: existingById.get(row.academy_video_id),
    row,
  }));

  await db.upsertOwnedVideoRows(mergedRows);
}

main().catch((error) => {
  console.error(`sync-youtube-statistics failed: ${error.message}`);
  process.exit(1);
});
