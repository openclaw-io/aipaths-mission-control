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

test("passwordless local app can read both playlist tables but RLS blocks writes", async () => {
  await pool.query(`
    insert into youtube_playlists (playlist_id, canonical_slug, title, url, kind, status)
    values ('PL-rls-read', 'rls-read', 'RLS read fixture', 'https://www.youtube.com/playlist?list=PL-rls-read', 'hub', 'active')
  `);
  await pool.query(`
    insert into youtube_playlist_videos (playlist_id, video_id, position)
    values ('PL-rls-read', 'video-rls-read', 1)
  `);

  const appUrl = new URL(process.env.MISSION_CONTROL_TEST_DATABASE_URL);
  appUrl.username = "aipaths_mc_app";
  appUrl.password = "";
  // Match the deployed app role's SELECT-only table privileges. The local
  // bootstrap grants broad table privileges and relies on RLS to reject writes.
  await pool.query("revoke update on public.youtube_playlists from aipaths_mc_app");
  const app = new pg.Client({ connectionString: appUrl.toString() });
  await app.connect();
  try {
    const identity = await app.query("select current_user");
    assert.equal(identity.rows[0].current_user, "aipaths_mc_app");
    assert.equal((await app.query("select has_table_privilege(current_user, 'public.youtube_playlists', 'UPDATE') can_update")).rows[0].can_update, false);
    assert.equal((await app.query("select count(*)::int count from youtube_playlists where playlist_id='PL-rls-read'")).rows[0].count, 1);
    assert.equal((await app.query("select count(*)::int count from youtube_playlist_videos where playlist_id='PL-rls-read'")).rows[0].count, 1);

    await assert.rejects(
      () => app.query("select playlist_id from youtube_playlists where playlist_id='PL-rls-read' for share"),
      (error) => error.code === "42501",
    );
    await app.query("begin");
    try {
      await app.query("select pg_advisory_xact_lock_shared(hashtextextended('mission-control:youtube-playlist-import', 0))");
      const governed = await app.query("select playlist_id from youtube_playlists where playlist_id='PL-rls-read' and status='active' and kind in ('hub', 'official_series')");
      assert.deepEqual(governed.rows, [{ playlist_id: "PL-rls-read" }]);
      const concurrentImport = await pool.query("select pg_try_advisory_xact_lock(hashtextextended('mission-control:youtube-playlist-import', 0)) acquired");
      assert.equal(concurrentImport.rows[0].acquired, false, "canonical import must not overlap governed validation");
    } finally {
      await app.query("rollback");
    }
    const importAfterValidation = await pool.query("select pg_try_advisory_xact_lock(hashtextextended('mission-control:youtube-playlist-import', 0)) acquired");
    assert.equal(importAfterValidation.rows[0].acquired, true);

    for (const statement of [
      `insert into youtube_playlists (playlist_id, canonical_slug, title, url, kind) values ('PL-rls-write', 'rls-write', 'Blocked', 'https://www.youtube.com/playlist?list=PL-rls-write', 'hub')`,
      `insert into youtube_playlist_videos (playlist_id, video_id, position) values ('PL-rls-read', 'video-rls-write', 2)`,
      `update youtube_playlists set status='archived' where playlist_id='PL-rls-read'`,
    ]) {
      await assert.rejects(
        () => app.query(statement),
        (error) => error.code === "42501" && /permission denied|row-level security/i.test(error.message),
      );
    }
    const blockedDelete = await app.query("delete from youtube_playlists where playlist_id='PL-rls-read'");
    assert.equal(blockedDelete.rowCount, 0, "RLS must hide catalog rows from DELETE even when the local bootstrap grants table DELETE");
    assert.equal((await app.query("select count(*)::int count from youtube_playlists where playlist_id='PL-rls-read' and status='active'")).rows[0].count, 1);
  } finally {
    await app.end();
    await pool.query("grant update on public.youtube_playlists to aipaths_mc_app");
  }
});

test("Supabase migration is additive and idempotent when replayed", async () => {
  const migration = readFileSync(resolve(repoRoot, "supabase/migrations/036_create_youtube_playlist_catalog.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  const preserved = await pool.query("select canonical_slug from youtube_playlists where playlist_id='PL-test'");
  assert.equal(preserved.rows[0].canonical_slug, "test");
  const rls = await pool.query(`
    select relname, relrowsecurity
      from pg_class
     where oid = any(array['public.youtube_playlists'::regclass, 'public.youtube_playlist_videos'::regclass])
     order by relname
  `);
  assert.deepEqual(rls.rows.map((row) => ({ ...row })), [
    { relname: "youtube_playlist_videos", relrowsecurity: true },
    { relname: "youtube_playlists", relrowsecurity: true },
  ]);
  const appPolicies = await pool.query(`
    select tablename, policyname, cmd
      from pg_policies
     where schemaname = 'public'
       and roles @> array['aipaths_mc_app']::name[]
       and tablename = any(array['youtube_playlists', 'youtube_playlist_videos'])
     order by tablename, policyname
  `);
  assert.deepEqual(appPolicies.rows.map((row) => ({ ...row })), [
    { tablename: "youtube_playlist_videos", policyname: "youtube_playlist_videos app read", cmd: "SELECT" },
    { tablename: "youtube_playlists", policyname: "youtube_playlists app read", cmd: "SELECT" },
  ]);
});
