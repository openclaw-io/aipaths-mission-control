import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

export const IN_SCOPE_TABLES = [
  'external_signals',
  'trend_snapshots',
  'community_activity',
  'channel_metrics',
  'youtube_metrics',
  'youtube_shorts_metrics',
  'youtube_comments',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptsDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(scriptsDir, '..');

export const MISSION_CONTROL_ENV_PATH = path.join(repoRoot, '.env.local');
export const ACADEMY_REPO_ROOT = '/Users/joaco/Documents/openclaw/repos/aipaths-academy';
export const ACADEMY_ENV_PATH = path.join(ACADEMY_REPO_ROOT, '.env.local');

export function loadEnvFile(envPath) {
  const env = {};
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

export function createSupabasePair() {
  const missionEnv = loadEnvFile(MISSION_CONTROL_ENV_PATH);
  const academyEnv = loadEnvFile(ACADEMY_ENV_PATH);

  const mission = createClient(
    missionEnv.NEXT_PUBLIC_SUPABASE_URL,
    missionEnv.SUPABASE_SERVICE_ROLE_KEY,
  );

  const academy = createClient(
    academyEnv.NEXT_PUBLIC_SUPABASE_URL,
    academyEnv.SUPABASE_SERVICE_ROLE_KEY,
  );

  return { mission, academy, missionEnv, academyEnv };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    write: false,
    all: false,
    tables: [],
    limit: null,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--table=')) {
      const value = arg.slice('--table='.length);
      options.tables.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      options.limit = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const deduped = [...new Set(options.tables)];
  if (options.all) {
    options.tables = [...IN_SCOPE_TABLES];
  } else {
    options.tables = deduped;
  }

  for (const table of options.tables) {
    if (!IN_SCOPE_TABLES.includes(table)) {
      throw new Error(`Unsupported table: ${table}`);
    }
  }

  return options;
}

export function printUsage(scriptName) {
  console.log(`Usage:\n  node ${scriptName} --all [--write] [--limit=100]\n  node ${scriptName} --table=external_signals [--table=trend_snapshots] [--table=youtube_comments] [--write] [--limit=100]`);
}

export async function fetchAllRows(client, table, { select = '*', pageSize = 1000, limit = null } = {}) {
  const rows = [];
  let offset = 0;

  while (true) {
    const remaining = limit == null ? pageSize : Math.min(pageSize, limit - rows.length);
    if (remaining <= 0) break;

    const { data, error } = await client
      .from(table)
      .select(select)
      .range(offset, offset + remaining - 1);

    if (error) throw new Error(`[${table}] fetch failed: ${error.message}`);

    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < remaining) break;
    offset += batch.length;
  }

  return rows;
}

export async function fetchCountAndLatest(client, table, latestColumn, applyFilters = (query) => query) {
  const countQuery = applyFilters(client.from(table).select('*', { count: 'exact', head: true }));
  const latestQuery = applyFilters(client.from(table).select(latestColumn).order(latestColumn, { ascending: false }).limit(1));

  const [{ count, error: countError }, { data, error: latestError }] = await Promise.all([countQuery, latestQuery]);

  if (countError) throw new Error(`[${table}] count failed: ${countError.message}`);
  if (latestError) throw new Error(`[${table}] latest failed: ${latestError.message}`);

  return {
    count: count ?? 0,
    latest: data?.[0]?.[latestColumn] ?? null,
  };
}

export function chunk(array, size = 500) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return { raw: value };

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: value };
  }
}

export function isoStartOfDay(dateString) {
  if (!dateString) return null;
  return `${dateString}T00:00:00Z`;
}

export function summarizeDateRange(rows, field) {
  if (!rows.length) return { count: 0, latest: null, earliest: null };
  const values = rows.map((row) => row[field]).filter(Boolean).sort();
  return {
    count: rows.length,
    earliest: values[0] ?? null,
    latest: values[values.length - 1] ?? null,
  };
}

export async function loadIntelSourceMap(mission) {
  const { data, error } = await mission
    .from('intel_sources')
    .select('id, source_key, lane');

  if (error) throw new Error(`Failed to load intel_sources: ${error.message}`);

  return new Map((data ?? []).map((row) => [row.source_key, row]));
}

export async function loadAcademyVideos(academy) {
  const selectVariants = [
    'id,title_en,title_es,published_at,is_published',
    'id,title,published_at,is_published',
    'id,title,published_at',
    'id,published_at',
    'id',
  ];

  let lastError = null;
  for (const select of selectVariants) {
    try {
      const videos = await fetchAllRows(academy, 'videos', {
        select,
        pageSize: 500,
      });
      return new Map(videos.map((video) => [video.id, video]));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to load Academy videos metadata');
}

export function makeOwnedVideoRow({ academyVideoId, videoKind, videoMeta }) {
  return {
    academy_video_id: academyVideoId,
    platform: 'youtube',
    platform_video_id: academyVideoId,
    title: videoMeta?.title_en || videoMeta?.title_es || videoMeta?.title || academyVideoId,
    published_at: videoMeta?.published_at || null,
    video_kind: videoKind,
    is_published: videoMeta?.is_published ?? true,
    metadata_json: {
      academy_video_id: academyVideoId,
      title_es: videoMeta?.title_es || null,
      source: videoMeta ? 'academy.videos' : 'fallback',
    },
    synced_at: new Date().toISOString(),
  };
}

export async function createPipelineRun(mission, runType, metadata = {}) {
  const { data, error } = await mission
    .from('pipeline_runs')
    .insert({
      run_type: runType,
      status: 'running',
      source_system: 'academy',
      metadata_json: metadata,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create pipeline run: ${error.message}`);
  return data.id;
}

export async function finishPipelineRun(mission, runId, payload) {
  const { error } = await mission
    .from('pipeline_runs')
    .update({
      ...payload,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);

  if (error) throw new Error(`Failed to update pipeline run ${runId}: ${error.message}`);
}

export async function upsertBatches({ mission, table, rows, onConflict, chunkSize = 500 }) {
  let written = 0;
  for (const batch of chunk(rows, chunkSize)) {
    const { error } = await mission
      .from(table)
      .upsert(batch, { onConflict });

    if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
    written += batch.length;
  }
  return written;
}
