#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { loadEnvFile } from './lib/youtube-statistics-sync-common.mjs';
import { classifyOwnedYoutubeVideo, parseIsoDurationSeconds } from './lib/youtube-owned-video-classification.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MISSION_ENV_PATH = path.join(REPO_ROOT, '.env.local');
const YOUTUBE_MCP_ROOT = process.env.YOUTUBE_MCP_ROOT || '/Users/joaco/openclaw/mcps/youtube_mcp';
const YOUTUBE_MCP_ENV_PATH = path.join(YOUTUBE_MCP_ROOT, '.env');
const YOUTUBE_MCP_DB_PATH = path.join(YOUTUBE_MCP_ROOT, 'data', 'cache.db');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { limit: null, ids: [], all: false, dryRun: false, includeShorts: true, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--longform-only') options.includeShorts = false;
    else if (arg === '--all') options.all = true;
    else if (arg.startsWith('--ids=')) {
      options.ids = arg.slice('--ids='.length).split(',').map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --limit: ${arg}`);
      options.limit = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.all && options.limit) throw new Error('Use either --all or --limit=N, not both');
  if (options.all && options.ids.length) throw new Error('Use either --all or --ids=..., not both');
  return options;
}

function printUsage() {
  console.log('Usage: npm run refresh:youtube-metadata -- --limit=100 --dry-run');
  console.log('Options: --limit=N --ids=ID1,ID2 --all --dry-run --longform-only');
}

async function main() {
  const options = parseArgs();
  if (options.help) return printUsage();

  const missionEnv = loadEnvFile(MISSION_ENV_PATH);
  const supabase = createClient(missionEnv.NEXT_PUBLIC_SUPABASE_URL, missionEnv.SUPABASE_SERVICE_ROLE_KEY);
  const youtubeEnv = loadEnvFile(YOUTUBE_MCP_ENV_PATH);
  const requireFromMcp = createRequire(path.join(YOUTUBE_MCP_ROOT, 'package.json'));
  const { google } = requireFromMcp('googleapis');
  const Database = requireFromMcp('better-sqlite3');

  const sqlite = new Database(YOUTUBE_MCP_DB_PATH);
  const tokens = sqlite.prepare('SELECT access_token, refresh_token, expiry_date, scope FROM oauth_tokens WHERE id = 1').get();
  if (!tokens?.refresh_token && !tokens?.access_token) throw new Error(`No YouTube OAuth tokens found in ${YOUTUBE_MCP_DB_PATH}`);

  const oauth = new google.auth.OAuth2(
    youtubeEnv.GOOGLE_CLIENT_ID,
    youtubeEnv.GOOGLE_CLIENT_SECRET,
    'http://localhost:9876/callback',
  );
  oauth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
    token_type: 'Bearer',
  });
  oauth.on('tokens', (newTokens) => {
    const current = sqlite.prepare('SELECT access_token, refresh_token, expiry_date, scope FROM oauth_tokens WHERE id = 1').get();
    sqlite.prepare('UPDATE oauth_tokens SET access_token=?, refresh_token=?, expiry_date=?, scope=?, updated_at=? WHERE id=1').run(
      newTokens.access_token ?? current.access_token,
      newTokens.refresh_token ?? current.refresh_token,
      newTokens.expiry_date ?? Date.now() + 3600 * 1000,
      current.scope ?? '',
      Math.floor(Date.now() / 1000),
    );
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth });
  let query = supabase
    .from('ops_owned_videos')
    .select('academy_video_id,title,video_kind,is_published,metadata_json')
    .eq('platform', 'youtube')
    .order('published_at', { ascending: false, nullsFirst: false });
  if (options.ids.length) query = query.in('academy_video_id', options.ids);
  if (!options.includeShorts) query = query.eq('video_kind', 'longform');
  if (options.limit && !options.ids.length) query = query.limit(options.limit);

  const { data: owned, error } = await query;
  if (error) throw new Error(`Failed to load ops_owned_videos: ${error.message}`);

  const refreshedAt = new Date().toISOString();
  const summary = {
    scanned: owned?.length ?? 0,
    found: 0,
    updated: 0,
    public: 0,
    nonPublic: 0,
    short: 0,
    longform: 0,
    classTitle: 0,
    missing: 0,
    changed: 0,
    dryRun: options.dryRun,
  };
  const nonPublic = [];
  const changedRows = [];

  for (const batch of chunk(owned || [], 50)) {
    const response = await youtube.videos.list({
      part: ['snippet', 'contentDetails', 'status'],
      id: batch.map((row) => row.academy_video_id),
    });
    const byId = new Map((response.data.items || []).map((video) => [video.id, video]));

    for (const row of batch) {
      const video = byId.get(row.academy_video_id);
      if (!video) {
        summary.missing += 1;
        continue;
      }
      summary.found += 1;

      const title = video.snippet?.title || row.title;
      const durationIso = video.contentDetails?.duration || null;
      const durationSeconds = parseIsoDurationSeconds(durationIso);
      const privacyStatus = video.status?.privacyStatus || null;
      const classification = classifyOwnedYoutubeVideo({ title, durationSeconds, privacyStatus });
      const isPublic = classification.is_published === true;
      const nextIsPublished = classification.is_published ?? row.is_published;
      const metadata = {
        ...(isRecord(row.metadata_json) ? row.metadata_json : {}),
        academy_video_id: row.academy_video_id,
        duration_iso: durationIso,
        duration_seconds: durationSeconds,
        duration_formatted: durationSeconds === null ? null : formatDuration(durationSeconds),
        privacy_status: privacyStatus,
        youtube_title: title,
        classification,
        metadata_refreshed_at: refreshedAt,
        source: 'youtube_metadata_refresh',
      };

      if (isPublic) summary.public += 1;
      else if (privacyStatus) {
        summary.nonPublic += 1;
        nonPublic.push({ id: row.academy_video_id, title, privacy_status: privacyStatus });
      }
      if (classification.video_kind === 'short') summary.short += 1;
      else summary.longform += 1;
      if (classification.excluded_by_title) summary.classTitle += 1;

      const changed = row.title !== title ||
        row.video_kind !== classification.video_kind ||
        row.is_published !== nextIsPublished ||
        row.metadata_json?.duration_seconds !== durationSeconds ||
        row.metadata_json?.privacy_status !== privacyStatus;
      if (changed) {
        summary.changed += 1;
        changedRows.push({
          id: row.academy_video_id,
          title,
          from: {
            video_kind: row.video_kind,
            is_published: row.is_published,
            duration_seconds: row.metadata_json?.duration_seconds ?? null,
            privacy_status: row.metadata_json?.privacy_status ?? null,
          },
          to: {
            video_kind: classification.video_kind,
            is_published: nextIsPublished,
            duration_seconds: durationSeconds,
            privacy_status: privacyStatus,
            exclusion_reasons: classification.exclusion_reasons,
          },
        });
      }

      if (!options.dryRun) {
        const { error: updateError } = await supabase
          .from('ops_owned_videos')
          .update({
            title,
            video_kind: classification.video_kind,
            is_published: nextIsPublished,
            metadata_json: metadata,
            synced_at: refreshedAt,
          })
          .eq('academy_video_id', row.academy_video_id);
        if (updateError) throw new Error(`Failed to update ${row.academy_video_id}: ${updateError.message}`);
        summary.updated += 1;
      }
    }
  }

  console.log(JSON.stringify({ ...summary, nonPublic: nonPublic.slice(0, 20), changedRows: changedRows.slice(0, 30) }, null, 2));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

main().catch((error) => {
  console.error(`refresh-youtube-owned-video-metadata failed: ${error.message}`);
  process.exit(1);
});
