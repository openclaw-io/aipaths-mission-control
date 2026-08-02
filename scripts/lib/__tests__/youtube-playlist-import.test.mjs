import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";
import { parseCatalogJson, parseMembershipTsv, upsertPlaylistSnapshot } from "../youtube-playlist-import.mjs";

const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 2 });
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
after(async () => pool.end());

const catalogJson = JSON.stringify({
  schema_version: 1,
  source: "youtube_playlist_audit_2026-07-31",
  source_observed_at: "2026-07-31T00:00:00Z",
  playlists: [{
    playlist_id: "PL-observed", canonical_slug: "observed", title: "Observed", description: null,
    url: "https://www.youtube.com/playlist?list=PL-observed", kind: "hub", purpose: "Teach safely",
    audience: "AIPaths viewers", status: "active", featured: true, home_order: 1, aliases: ["Old Name"],
    use_cases: ["onboarding"], tags: ["ai"], source_metadata: { evidence: "architecture-v2" }, live_metadata: {},
  }],
});
const literalEscapedTsv = "PL-observed\\tObserved old name\\t01\\tvideo_1\\tFirst video\\t317.0\n";

function playlist(overrides) {
  const playlistId = overrides.playlist_id;
  return {
    playlist_id: playlistId,
    canonical_slug: overrides.canonical_slug,
    title: overrides.title ?? overrides.canonical_slug,
    description: null,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    kind: "hub",
    purpose: null,
    audience: null,
    status: "active",
    featured: false,
    home_order: null,
    aliases: [],
    use_cases: [],
    tags: [],
    source_metadata: {},
    live_metadata: {},
  };
}

function dryRunWithMemberships(memberships) {
  const directory = mkdtempSync(resolve(tmpdir(), "youtube-playlist-dry-run-"));
  try {
    const catalogPath = resolve(directory, "catalog.json");
    const membershipsPath = resolve(directory, "memberships.tsv");
    writeFileSync(catalogPath, catalogJson);
    writeFileSync(membershipsPath, memberships);
    return spawnSync(process.execPath, [
      resolve(repoRoot, "scripts/import-youtube-playlists.mjs"),
      "--catalog", catalogPath,
      "--memberships", membershipsPath,
      "--dry-run",
    ], { cwd: repoRoot, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("snapshot parsers accept the audit's literal escaped TSV and preserve only evidenced values", () => {
  const catalog = parseCatalogJson(catalogJson);
  const memberships = parseMembershipTsv(literalEscapedTsv);
  assert.equal(catalog.playlists[0].description, null);
  assert.deepEqual(memberships, [{
    playlist_id: "PL-observed", source_playlist_title: "Observed old name", position: 1,
    video_id: "video_1", title: "First video", membership_reason: "observed_in_source_snapshot",
    membership_role: "existing_membership", source_metadata: { duration_seconds: 317 },
  }]);
});

test("invalid snapshots fail closed instead of inventing playlist or video data", () => {
  assert.throws(() => parseMembershipTsv("PL-observed\\tTitle\\tnope\\tvideo\\tNA\\tNA"), /position/i);
  const invalid = JSON.parse(catalogJson);
  invalid.playlists[0].kind = "course_maybe";
  assert.throws(() => parseCatalogJson(JSON.stringify(invalid)), /kind/i);
});

test("membership parser rejects duplicate playlist positions and blank numeric durations", () => {
  assert.throws(() => parseMembershipTsv([
    "PL-observed\tTitle\t1\tvideo-1\tFirst\t10",
    "PL-observed\tTitle\t1\tvideo-2\tSecond\t20",
  ].join("\n")), /position/i);
  assert.throws(() => parseMembershipTsv("PL-observed\tTitle\t1\tvideo-1\tFirst\t   "), /duration/i);
});

test("dry-run fails closed for duplicate positions and whitespace-only durations", () => {
  const duplicatePosition = dryRunWithMemberships([
    "PL-observed\tTitle\t1\tvideo-1\tFirst\t10",
    "PL-observed\tTitle\t1\tvideo-2\tSecond\t20",
  ].join("\n"));
  assert.notEqual(duplicatePosition.status, 0, duplicatePosition.stdout);
  assert.match(duplicatePosition.stderr, /position/i);

  const blankDuration = dryRunWithMemberships("PL-observed\tTitle\t1\tvideo-1\tFirst\t   ");
  assert.notEqual(blankDuration.status, 0, blankDuration.stdout);
  assert.match(blankDuration.stderr, /duration/i);
});

test("snapshot upsert is transactional and idempotent", async () => {
  const snapshot = { ...parseCatalogJson(catalogJson), memberships: parseMembershipTsv(literalEscapedTsv) };
  const first = await upsertPlaylistSnapshot(pool, snapshot);
  const second = await upsertPlaylistSnapshot(pool, snapshot);
  assert.deepEqual(first, { playlists: 1, memberships: 1 });
  assert.deepEqual(second, first);
  const counts = await pool.query(`select
    (select count(*)::int from youtube_playlists where playlist_id='PL-observed') playlists,
    (select count(*)::int from youtube_playlist_videos where playlist_id='PL-observed') memberships`);
  assert.deepEqual(counts.rows[0], { playlists: 1, memberships: 1 });
  assert.equal((await pool.query(`select source_metadata->>'duration_seconds' duration from youtube_playlist_videos where video_id='video_1'`)).rows[0].duration, "317");
});

test("snapshot replacement supports reorder, removes stale memberships, and stays scoped to included playlists", async () => {
  const reorder = playlist({ playlist_id: "PL-snapshot-reorder", canonical_slug: "snapshot-reorder" });
  const outside = playlist({ playlist_id: "PL-snapshot-outside", canonical_slug: "snapshot-outside" });
  const catalog = {
    schema_version: 1,
    source: "snapshot-replacement-test",
    source_observed_at: "2026-07-31T00:00:00Z",
    playlists: [reorder, outside],
  };
  const initialMemberships = parseMembershipTsv([
    "PL-snapshot-reorder\tReorder\t1\treorder-v1\tFirst\t10",
    "PL-snapshot-reorder\tReorder\t2\treorder-v2\tSecond\t20",
    "PL-snapshot-reorder\tReorder\t3\treorder-stale\tStale\t30",
    "PL-snapshot-outside\tOutside\t1\toutside-v1\tOutside\t40",
  ].join("\n"));
  await upsertPlaylistSnapshot(pool, { ...catalog, memberships: initialMemberships });

  const replacementMemberships = parseMembershipTsv([
    "PL-snapshot-reorder\tReorder\t1\treorder-v2\tSecond\t20",
    "PL-snapshot-reorder\tReorder\t2\treorder-v1\tFirst\t10",
  ].join("\n"));
  await upsertPlaylistSnapshot(pool, {
    ...catalog,
    playlists: [reorder],
    memberships: replacementMemberships,
  });

  const replaced = await pool.query(`
    select video_id, position
      from youtube_playlist_videos
     where playlist_id = 'PL-snapshot-reorder'
     order by position
  `);
  assert.deepEqual(replaced.rows, [
    { video_id: "reorder-v2", position: 1 },
    { video_id: "reorder-v1", position: 2 },
  ]);
  assert.equal((await pool.query(`
    select count(*)::int count
      from youtube_playlist_videos
     where playlist_id = 'PL-snapshot-outside' and video_id = 'outside-v1'
  `)).rows[0].count, 1);
});

test("catalog provenance references exact committed approved sources", () => {
  const expectedSources = {
    "data/youtube-playlists/sources/architecture-v2.md": "5bc2c3c0b4d1d856cb0b7a00dc0ed58a3dbd2b4d2ddf0fcbf1583048046db622",
    "data/youtube-playlists/sources/audit.md": "9368660747bf64665bb99c6251f7add9806bb9406aaa9ea159799ca2218ff894",
  };
  for (const [relativePath, expectedHash] of Object.entries(expectedSources)) {
    const bytes = readFileSync(resolve(repoRoot, relativePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, relativePath);
  }

  const catalog = parseCatalogJson(readFileSync(resolve(repoRoot, "data/youtube-playlists/2026-07-31-catalog.json"), "utf8"));
  for (const item of catalog.playlists) {
    assert.equal(item.source_metadata.metadata_kind, "approved_editorial_intent");
    assert.deepEqual(item.source_metadata.approved_editorial_source, {
      path: "data/youtube-playlists/sources/architecture-v2.md",
      sha256: expectedSources["data/youtube-playlists/sources/architecture-v2.md"],
    });
    assert.deepEqual(item.source_metadata.live_observation_source, {
      path: "data/youtube-playlists/sources/audit.md",
      sha256: expectedSources["data/youtube-playlists/sources/audit.md"],
    });
    assert.equal(item.live_metadata.metadata_kind, "observed_live_state");
  }
});

test("the audited 2026-07-31 seed excludes Shorts and replays only long-form playlists", async () => {
  const catalog = parseCatalogJson(readFileSync(resolve(repoRoot, "data/youtube-playlists/2026-07-31-catalog.json"), "utf8"));
  const memberships = parseMembershipTsv(readFileSync(resolve(repoRoot, "data/youtube-playlists/2026-07-31-memberships.tsv"), "utf8"));
  assert.equal(catalog.playlists.some((playlist) => playlist.kind === "shorts"), false);
  const first = await upsertPlaylistSnapshot(pool, { ...catalog, memberships });
  const second = await upsertPlaylistSnapshot(pool, { ...catalog, memberships });
  assert.deepEqual(first, { playlists: 6, memberships: 54 });
  assert.deepEqual(second, first);
  const playlistIds = catalog.playlists.map((playlist) => playlist.playlist_id);
  const counts = await pool.query(`select
    (select count(*)::int from youtube_playlists where playlist_id=any($1::text[])) playlists,
    (select count(*)::int from youtube_playlist_videos where playlist_id=any($1::text[])) memberships`, [playlistIds]);
  assert.deepEqual(counts.rows[0], first);
  assert.equal((await pool.query("select count(*)::int count from youtube_playlists where playlist_id=any($1::text[]) and source='youtube_playlist_audit_2026-07-31'", [playlistIds])).rows[0].count, 6);
});

test("the owner-finalized 2026-08-02 snapshot converges to all public long-form playlists", async () => {
  const sourcePath = "data/youtube-playlists/sources/youtube-live-snapshot-2026-08-02.json";
  const sourceBytes = readFileSync(resolve(repoRoot, sourcePath));
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  assert.equal(sourceHash, "773a65226fba4f0b36c615d97ebc489e71f7f0e706dd312e2add56e4a33e5e76");

  const sourceSnapshot = JSON.parse(sourceBytes.toString("utf8"));
  const liveIds = sourceSnapshot.playlists
    .filter((playlist) => playlist.status?.privacyStatus === "public" && !playlist.snippet?.title?.toLowerCase().includes("shorts"))
    .map((playlist) => playlist.id)
    .sort();
  const catalog = parseCatalogJson(readFileSync(resolve(repoRoot, "data/youtube-playlists/2026-08-02-catalog.json"), "utf8"));
  const memberships = parseMembershipTsv(readFileSync(resolve(repoRoot, "data/youtube-playlists/2026-08-02-memberships.tsv"), "utf8"));

  assert.deepEqual(catalog.playlists.map((playlist) => playlist.playlist_id).sort(), liveIds);
  assert.equal(catalog.playlists.some((playlist) => playlist.kind === "shorts"), false);
  assert.equal(catalog.source_observed_at, sourceSnapshot.capturedAt);
  for (const playlist of catalog.playlists) {
    assert.deepEqual(playlist.source_metadata.live_observation_source, { path: sourcePath, sha256: sourceHash });
    assert.equal(playlist.live_metadata.captured_at, sourceSnapshot.capturedAt);
    assert.equal(playlist.live_metadata.privacy_status, "public");
  }

  const first = await upsertPlaylistSnapshot(pool, { ...catalog, memberships });
  const second = await upsertPlaylistSnapshot(pool, { ...catalog, memberships });
  assert.deepEqual(first, { playlists: 11, memberships: 101 });
  assert.deepEqual(second, first);
  const playlistIds = catalog.playlists.map((playlist) => playlist.playlist_id);
  const counts = await pool.query(`select
    (select count(*)::int from youtube_playlists where playlist_id=any($1::text[])) playlists,
    (select count(*)::int from youtube_playlist_videos where playlist_id=any($1::text[])) memberships`, [playlistIds]);
  assert.deepEqual(counts.rows[0], first);
});
