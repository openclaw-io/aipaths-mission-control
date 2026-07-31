import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 2 });
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
after(async () => pool.end());

test("fresh local schema exposes the canonical YouTube playlist contract", async () => {
  const result = await pool.query(`
    select table_name, column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public'
       and table_name = any($1::text[])
     order by table_name, ordinal_position
  `, [["youtube_playlists", "youtube_playlist_videos"]]);
  const byTable = Map.groupBy(result.rows, (row) => row.table_name);
  assert.deepEqual(Array.from(byTable.keys()).sort(), ["youtube_playlist_videos", "youtube_playlists"]);
  assert.deepEqual(byTable.get("youtube_playlists").map((row) => row.column_name), [
    "playlist_id", "canonical_slug", "title", "description", "url", "kind", "purpose", "audience",
    "status", "featured", "home_order", "aliases", "use_cases", "tags", "source", "source_metadata",
    "live_metadata", "source_observed_at", "last_synced_at", "created_at", "updated_at",
  ]);
  assert.deepEqual(byTable.get("youtube_playlist_videos").map((row) => row.column_name), [
    "playlist_id", "video_id", "title", "position", "membership_reason", "membership_role",
    "source_metadata", "created_at", "updated_at",
  ]);
});

test("playlist constraints reject guessed taxonomy and invalid positions", async () => {
  await assert.rejects(
    () => pool.query(`insert into youtube_playlists (playlist_id, canonical_slug, title, url, kind) values ('PL-test', 'test', 'Test', 'https://www.youtube.com/playlist?list=PL-test', 'guessed')`),
    (error) => error.code === "23514",
  );
  await pool.query(`insert into youtube_playlists (playlist_id, canonical_slug, title, url, kind) values ('PL-test', 'test', 'Test', 'https://www.youtube.com/playlist?list=PL-test', 'hub')`);
  await assert.rejects(
    () => pool.query(`insert into youtube_playlist_videos (playlist_id, video_id, position) values ('PL-test', 'video-1', 0)`),
    (error) => error.code === "23514",
  );
});

test("Supabase migration is additive and idempotent when replayed", async () => {
  const migration = readFileSync(resolve(repoRoot, "supabase/migrations/036_create_youtube_playlist_catalog.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  const preserved = await pool.query("select canonical_slug from youtube_playlists where playlist_id='PL-test'");
  assert.equal(preserved.rows[0].canonical_slug, "test");
  const rls = await pool.query("select relrowsecurity from pg_class where oid='public.youtube_playlists'::regclass");
  assert.equal(rls.rows[0].relrowsecurity, true);
});
