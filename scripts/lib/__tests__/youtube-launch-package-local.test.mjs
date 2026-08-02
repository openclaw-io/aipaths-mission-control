import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const moduleCache = new Map();

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]));
  }
  return value;
}

function loadTypeScriptModule(relativePath) {
  const sourcePath = resolve(repoRoot, relativePath);
  if (moduleCache.has(sourcePath)) return moduleCache.get(sourcePath);

  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;

  const cjsModule = { exports: {} };
  moduleCache.set(sourcePath, cjsModule.exports);
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier === "@/lib/youtube-launch-package") return loadTypeScriptModule("src/lib/youtube-launch-package.ts");
      if (specifier === "@/lib/db/mission-control") return { normalizeRow: normalizeValue };
      if (specifier === "@/lib/db/postgres") {
        return {
          withTransaction: async (run) => {
            const client = new Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL || process.env.MISSION_CONTROL_DATABASE_URL });
            await client.connect();
            try {
              await client.query("begin");
              const result = await run(client);
              await client.query("commit");
              return result;
            } catch (error) {
              await client.query("rollback").catch(() => {});
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }
      if (specifier === "node:crypto") return { randomUUID };
      if (specifier === "@supabase/supabase-js" || specifier === "pg") return {};
      throw new Error(`Unexpected require: ${specifier}`);
    },
    URL,
    Date,
    Number,
    Set,
    JSON,
    String,
    RegExp,
    console,
  };

  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  moduleCache.set(sourcePath, cjsModule.exports);
  return cjsModule.exports;
}

const { createScheduledYouTubeLaunchPackageLocal } = loadTypeScriptModule("src/lib/youtube-launch-package-local.ts");
const { extractYouTubeVideoId } = loadTypeScriptModule("src/lib/youtube-launch-package.ts");

async function withClient(run) {
  const client = new Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL || process.env.MISSION_CONTROL_DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function readLaunchRows(videoId) {
  return withClient(async (client) => {
    const work = await client.query(
      `select id, status, instruction, to_char(scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scheduled_for, payload
         from public.work_items
        where payload ->> 'video_id' = $1
        order by payload ->> 'relation_type'`,
      [videoId],
    );
    const pipeline = await client.query(
      `select pipeline_type, status, metadata
         from public.pipeline_items
        where metadata -> 'launch_package' ->> 'video_id' = $1
        order by pipeline_type`,
      [videoId],
    );
    return { work: work.rows.map(normalizeValue), pipeline: pipeline.rows.map(normalizeValue) };
  });
}

async function seedGovernedPlaylist(playlistId, overrides = {}) {
  return withClient(async (client) => {
    const slug = `test-${playlistId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const values = {
      status: "active",
      kind: "hub",
      ...overrides,
    };
    await client.query(
      `insert into public.youtube_playlists
         (playlist_id, canonical_slug, title, url, kind, status)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (playlist_id) do update
         set kind=excluded.kind, status=excluded.status, updated_at=now()`,
      [playlistId, slug, `Test ${playlistId}`, `https://www.youtube.com/playlist?list=${playlistId}`, values.kind, values.status],
    );
  });
}

async function insertVideoPipelineItem(overrides = {}) {
  return withClient(async (client) => {
    const values = {
      title: "Exact board card",
      status: "editing",
      published_at: null,
      current_url: null,
      metadata: { youtube_v0: { stage: "editing" } },
      ...overrides,
    };
    const result = await client.query(
      `insert into public.pipeline_items
         (pipeline_type, title, status, published_at, current_url, metadata)
       values ('video', $1, $2, $3, $4, $5::jsonb)
       returning *`,
      [values.title, values.status, values.published_at, values.current_url, JSON.stringify(values.metadata)],
    );
    return normalizeValue(result.rows[0]);
  });
}

function workByRelation(rows) {
  return new Map(rows.map((row) => [row.payload.relation_type, row]));
}

test("local scheduled launch package prepares private-video drafts immediately and no external actions before approval", async () => {
  const videoId = "V2mvpAAA001";
  const result = await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP dry package",
    publishAt: "2026-07-07T14:00:00.000Z",
    preparedAt: "2026-07-07T10:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });
  assert.equal(result.videoId, videoId);
  assert.equal(result.pinnedCommentItem.pipeline_type, "youtube_pinned_comment");

  const rows = await readLaunchRows(videoId);
  const byRelation = workByRelation(rows.work);
  assert.deepEqual([...byRelation.keys()], [
    "launch_community_draft",
    "marketing_email_campaign",
    "video_launch_activate",
    "website_publish_video",
    "youtube_launch_preflight",
    "youtube_pinned_comment_draft",
    "youtube_snapshot_24h",
    "youtube_snapshot_28d",
    "youtube_snapshot_7d",
  ]);
  assert.equal(byRelation.get("launch_community_draft").scheduled_for, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("marketing_email_campaign").scheduled_for, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("youtube_pinned_comment_draft").scheduled_for, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("youtube_launch_preflight").scheduled_for, "2026-07-07T13:30:00.000Z");
  assert.equal(byRelation.get("website_publish_video").payload.requires_live_check_passed, true);
  assert.equal(byRelation.get("launch_community_draft").payload.public_gate_applies_to, "publish_or_send_only");
  assert.equal(byRelation.get("marketing_email_campaign").payload.requires_gonza_approval, true);
  assert.equal(rows.work.some((row) => ["publish_community_post", "send_email_campaign", "publish_youtube_pinned_comment"].includes(row.payload.action)), false);
  assert.deepEqual(rows.pipeline.map((row) => row.pipeline_type), ["community_post", "email_campaign", "video", "youtube_pinned_comment"]);
});

test("local scheduled launch package derives playlist context from a full YouTube URL with list", async () => {
  const videoId = "V2mvpAAA101";
  const playlistContextUrl = `https://www.youtube.com/watch?v=${videoId}&list=PLabc123`;
  const result = await createScheduledYouTubeLaunchPackageLocal({
    youtubeUrl: playlistContextUrl,
    title: "V2 MVP playlist URL",
    publishAt: "2026-07-07T14:00:00.000Z",
    preparedAt: "2026-07-07T10:00:00.000Z",
    requestedBy: "test:dev",
  });

  assert.equal(result.playlistContextUrl, playlistContextUrl);
  const rows = await readLaunchRows(videoId);
  const community = workByRelation(rows.work).get("launch_community_draft");
  assert.equal(community.payload.playlist_context_url, playlistContextUrl);
  assert.match(community.instruction, /"playlist_context_url": "https:\/\/www\.youtube\.com\/watch\?v=V2mvpAAA101&list=PLabc123"/);
});

test("governed launch persists the exact selected playlist provenance across parent, children, and work items", async () => {
  const videoId = "GovPersist1";
  const playlistId = "PLGovernedPersist";
  const playlistContextUrl = `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`;
  await seedGovernedPlaylist(playlistId);

  const result = await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "Governed provenance",
    publishAt: "2026-08-20T14:00:00.000Z",
    playlistId,
    requireGovernedPlaylist: true,
    requestedBy: "test:governed",
  });

  assert.equal(result.playlistId, playlistId);
  assert.equal(result.playlistContextUrl, playlistContextUrl);
  const rows = await readLaunchRows(videoId);
  assert.equal(rows.pipeline.length, 4);
  for (const row of rows.pipeline) {
    const launch = row.metadata.launch_package;
    assert.equal(launch.playlist_id, playlistId, `${row.pipeline_type} launch_package provenance`);
    assert.equal(launch.playlist_context_url, playlistContextUrl, `${row.pipeline_type} context provenance`);
    if (row.pipeline_type === "video") {
      assert.equal(row.metadata.youtube_v0.playlist_id, playlistId);
      assert.equal(row.metadata.publication.playlist_id, playlistId);
    } else {
      assert.equal(row.metadata.source.playlist_id, playlistId);
    }
  }
  assert.equal(rows.work.length, 9);
  for (const work of rows.work) {
    assert.equal(work.payload.playlist_id, playlistId, `${work.payload.relation_type} playlist_id`);
    assert.equal(work.payload.playlist_context_url, playlistContextUrl, `${work.payload.relation_type} context URL`);
  }

  const rerun = await createScheduledYouTubeLaunchPackageLocal({
    pipelineItemId: result.videoItem.id,
    videoId,
    publishAt: "2026-08-20T14:00:00.000Z",
    playlistId,
    requireGovernedPlaylist: true,
    requestedBy: "test:governed",
  });
  assert.equal(rerun.videoItem.id, result.videoItem.id);
  assert.equal(rerun.playlistId, playlistId);
});

test("governed launch rejects conflicting explicit, refs, and youtube_url playlist provenance without mutations", async () => {
  const playlistId = "PLGovernedConflict";
  await seedGovernedPlaylist(playlistId);
  const cases = [
    { videoId: "GovInput001", playlistContextUrl: "https://www.youtube.com/playlist?list=PLUntrustedInput" },
    { videoId: "GovRefs0001", refs: { playlist_id: "PLUntrustedRefs" } },
    { videoId: "GovUrl00001", youtubeUrl: "https://www.youtube.com/watch?v=GovUrl00001&list=PLUntrustedUrl" },
  ];

  for (const candidate of cases) {
    await assert.rejects(
      () => createScheduledYouTubeLaunchPackageLocal({
        ...candidate,
        publishAt: "2026-08-21T14:00:00.000Z",
        playlistId,
        requireGovernedPlaylist: true,
        requestedBy: "test:governed-conflict",
      }),
      (error) => error?.status === 400 && /conflicts with governed playlist_id/i.test(error.message),
    );
    const rows = await readLaunchRows(candidate.videoId);
    assert.equal(rows.pipeline.length, 0);
    assert.equal(rows.work.length, 0);
  }
});

test("governed reschedule fails closed on contradictory existing active launch metadata", async () => {
  const videoId = "GovExist001";
  const playlistId = "PLGovernedExisting";
  await seedGovernedPlaylist(playlistId);
  const parent = await insertVideoPipelineItem({
    metadata: {
      youtube_v0: { stage: "editing" },
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        status: "scheduled",
        video_id: videoId,
        playlist_id: "PLLegacyExisting",
        playlist_context_url: `https://www.youtube.com/watch?v=${videoId}&list=PLLegacyExisting`,
      },
    },
  });

  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal({
      pipelineItemId: parent.id,
      videoId,
      publishAt: "2026-08-22T14:00:00.000Z",
      playlistId,
      requireGovernedPlaylist: true,
      requestedBy: "test:governed-existing",
    }),
    (error) => error?.status === 409 && /existing scheduled launch.*conflicts/i.test(error.message),
  );
  const preserved = await withClient((client) => client.query(
    "select status,metadata from public.pipeline_items where id=$1",
    [parent.id],
  ));
  assert.equal(preserved.rows[0].status, "editing");
  assert.equal(preserved.rows[0].metadata.launch_package.playlist_id, "PLLegacyExisting");
  const rows = await readLaunchRows(videoId);
  assert.equal(rows.work.length, 0);
  assert.equal(rows.pipeline.length, 1);
});

test("governed catalog row is revalidated under the canonical import shared lock before mutations", async () => {
  const catalogCases = [
    { videoId: "GovMiss0001", playlistId: "PLGovernedMissing" },
    { videoId: "GovArch0001", playlistId: "PLGovernedArchived", status: "archived", kind: "hub" },
    { videoId: "GovShort001", playlistId: "PLGovernedShorts", status: "active", kind: "shorts" },
  ];
  await seedGovernedPlaylist(catalogCases[1].playlistId, catalogCases[1]);
  await seedGovernedPlaylist(catalogCases[2].playlistId, catalogCases[2]);

  for (const candidate of catalogCases) {
    await assert.rejects(
      () => createScheduledYouTubeLaunchPackageLocal({
        videoId: candidate.videoId,
        publishAt: "2026-08-23T14:00:00.000Z",
        playlistId: candidate.playlistId,
        requireGovernedPlaylist: true,
        requestedBy: "test:governed-catalog",
      }),
      (error) => error?.status === 400 && /active eligible playlist.*governed.*catalog/i.test(error.message),
    );
    const rows = await readLaunchRows(candidate.videoId);
    assert.equal(rows.pipeline.length, 0);
    assert.equal(rows.work.length, 0);
  }

  const source = readFileSync(resolve(repoRoot, "src/lib/youtube-launch-package-local.ts"), "utf8");
  const importSource = readFileSync(resolve(repoRoot, "scripts/lib/youtube-playlist-import.mjs"), "utf8");
  const lockFunction = source.slice(
    source.indexOf("async function lockGovernedPlaylist"),
    source.indexOf("function assertGovernedPlaylistInputs"),
  );
  const canonicalLockKey = "mission-control:youtube-playlist-import";
  assert.match(importSource, new RegExp(`pg_advisory_xact_lock\\(hashtextextended\\('${canonicalLockKey}', 0\\)\\)`));
  assert.match(lockFunction, new RegExp(`pg_advisory_xact_lock_shared\\(hashtextextended\\('${canonicalLockKey}', 0\\)\\)`));
  assert.ok(
    lockFunction.indexOf("pg_advisory_xact_lock_shared") < lockFunction.indexOf("from public.youtube_playlists"),
    "the shared import lock must be acquired before reading and validating the governed row",
  );
  assert.doesNotMatch(lockFunction, /for\s+(share|update)/i);
  assert.match(lockFunction, /from public\.youtube_playlists[\s\S]*playlist_id = \$1[\s\S]*status = 'active'[\s\S]*kind in \('hub', 'official_series'\)/);
  assert.ok(source.indexOf("lockGovernedPlaylist(client") < source.indexOf("findExistingVideoItem(client", source.indexOf("createScheduledYouTubeLaunchPackageLocal")));
});

test("local scheduled launch package rejects bare AIPaths YouTube URLs before creating launch rows", async () => {
  const videoId = "V2mvpAAA102";
  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal({
      youtubeUrl: `https://youtu.be/${videoId}`,
      title: "V2 MVP bare URL",
      publishAt: "2026-07-07T14:00:00.000Z",
      preparedAt: "2026-07-07T10:00:00.000Z",
      requestedBy: "test:dev",
    }),
    /playlist_context_url.*required|playlist_context_url.*list=/i,
  );

  const rows = await readLaunchRows(videoId);
  assert.equal(rows.work.length, 0);
  assert.equal(rows.pipeline.length, 0);
});

test("local scheduled launch package reruns update open schedules without duplicating and preserve terminal work", async () => {
  const videoId = "V2mvpAAA002";
  await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP reschedule",
    publishAt: "2026-07-07T14:00:00.000Z",
    preparedAt: "2026-07-07T10:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });
  await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP reschedule",
    publishAt: "2026-07-08T15:00:00.000Z",
    preparedAt: "2026-07-08T10:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });

  let rows = await readLaunchRows(videoId);
  let byRelation = workByRelation(rows.work);
  assert.equal(rows.work.length, 9);
  assert.equal(byRelation.get("youtube_launch_preflight").scheduled_for, "2026-07-08T14:30:00.000Z");
  assert.equal(byRelation.get("video_launch_activate").scheduled_for, "2026-07-08T15:02:00.000Z");
  assert.equal(byRelation.get("website_publish_video").scheduled_for, "2026-07-08T15:15:00.000Z");
  assert.equal(byRelation.get("launch_community_draft").scheduled_for, "2026-07-08T10:00:00.000Z");
  assert.equal(byRelation.get("youtube_snapshot_7d").scheduled_for, "2026-07-15T15:00:00.000Z");

  const websiteWorkId = byRelation.get("website_publish_video").id;
  await withClient((client) => client.query("update public.work_items set status='done' where id=$1", [websiteWorkId]));
  await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP reschedule",
    publishAt: "2026-07-09T16:00:00.000Z",
    preparedAt: "2026-07-09T10:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });

  rows = await readLaunchRows(videoId);
  const currentGeneration = rows.pipeline.find((row) => row.pipeline_type === "video").metadata.launch_package.launch_generation;
  assert.match(currentGeneration, new RegExp(`^youtube-launch-v1:${videoId}:2026-07-09T16:00:00\\.000Z:`));
  const currentWork = rows.work.filter((row) => row.payload.launch_generation === currentGeneration);
  byRelation = workByRelation(currentWork);
  assert.equal(rows.work.length, 10);
  assert.equal(currentWork.length, 9);
  const preservedTerminal = rows.work.find((row) => row.id === websiteWorkId);
  assert.equal(preservedTerminal.status, "done");
  assert.equal(preservedTerminal.scheduled_for, "2026-07-08T15:15:00.000Z");
  assert.notEqual(byRelation.get("website_publish_video").id, websiteWorkId);
  assert.equal(byRelation.get("website_publish_video").status, "ready");
  assert.equal(byRelation.get("website_publish_video").scheduled_for, "2026-07-09T16:15:00.000Z");
  assert.equal(byRelation.get("video_launch_activate").scheduled_for, "2026-07-09T16:02:00.000Z");
  assert.equal(byRelation.get("youtube_launch_preflight").scheduled_for, "2026-07-09T15:30:00.000Z");
});

test("same-date reconciliation adopts legacy terminal work without duplicating it", async () => {
  const videoId = "LegacyGen01";
  const publishAt = "2026-08-04T13:00:00.000Z";
  const first = await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "Legacy generation reconciliation",
    publishAt,
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });
  const terminalId = first.workItems.find((entry) => entry.relationType === "launch_community_draft").workItem.id;
  await withClient(async (client) => {
    await client.query("update public.work_items set status='done', payload=payload-'launch_generation' where id=$1", [terminalId]);
    await client.query(
      "update public.pipeline_items set metadata=jsonb_set(metadata,'{launch_package}',(metadata->'launch_package')-'launch_generation'-'activation_work_item_id') where id=$1",
      [first.videoItem.id],
    );
    await client.query("update public.work_items set payload=payload-'launch_generation' where payload->>'video_id'=$1", [videoId]);
  });

  const reconciled = await createScheduledYouTubeLaunchPackageLocal({
    pipelineItemId: first.videoItem.id,
    videoId,
    title: "Legacy generation reconciliation",
    publishAt,
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });
  const rows = await readLaunchRows(videoId);
  assert.equal(rows.work.length, 9);
  assert.equal(rows.work.find((row) => row.id === terminalId).status, "done");
  assert.match(reconciled.videoItem.metadata.launch_package.launch_generation, new RegExp(`^youtube-launch-v1:${videoId}:${publishAt.replaceAll(".", "\\.")}:`));
  assert.ok(reconciled.videoItem.metadata.launch_package.activation_work_item_id);
});

test("exact pipelineItemId reuses the selected video card, schedules it, and does not expose a private URL", async () => {
  const videoId = "ExactCard01";
  const exact = await insertVideoPipelineItem();
  const decoy = await insertVideoPipelineItem({
    title: "Heuristic decoy",
    metadata: { launch_package: { video_id: videoId }, youtube_v0: { stage: "editing" } },
  });

  const result = await createScheduledYouTubeLaunchPackageLocal({
    pipelineItemId: exact.id,
    videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: exact.title,
    publishAt: "2026-08-01T12:00:00.000Z",
    preparedAt: "2026-07-31T12:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:board",
  });

  assert.equal(result.videoItem.id, exact.id);
  assert.equal(result.videoItemCreated, false);
  assert.equal(result.videoItem.status, "scheduled");
  assert.equal(result.videoItem.scheduled_for, "2026-08-01T12:00:00.000Z");
  assert.equal(result.videoItem.published_at, null);
  assert.equal(result.videoItem.current_url, null);
  assert.equal(result.videoItem.metadata.youtube_v0.stage, "scheduled");
  assert.equal(result.videoItem.metadata.launch_package.status, "scheduled");
  assert.equal(result.playlistContextUrl, `https://www.youtube.com/watch?v=${videoId}&list=PLabc123`);
  assert.equal(result.videoItem.metadata.launch_package.playlist_context_url, result.playlistContextUrl);

  const rows = await withClient((client) => client.query(
    "select id, status, metadata from public.pipeline_items where pipeline_type='video' and (id=$1 or id=$2)",
    [exact.id, decoy.id],
  ));
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.find((row) => row.id === exact.id).metadata.launch_package.playlist_context_url, result.playlistContextUrl);
  assert.equal(rows.rows.find((row) => row.id === decoy.id).status, "editing");
});

test("a video ID cannot be scheduled onto a second active parent card", async () => {
  const videoId = "OneParent01";
  const first = await insertVideoPipelineItem({ title: "First parent" });
  const second = await insertVideoPipelineItem({ title: "Second parent" });
  await createScheduledYouTubeLaunchPackageLocal({
    pipelineItemId: first.id,
    videoId,
    title: first.title,
    publishAt: "2026-08-04T12:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:dev",
  });
  await withClient((client) => client.query("update public.pipeline_items set status='editing' where id=$1", [first.id]));
  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal({
      pipelineItemId: second.id,
      videoId,
      title: second.title,
      publishAt: "2026-08-05T12:00:00.000Z",
      playlistId: "PLabc123",
      requestedBy: "test:dev",
    }),
    /already has an active scheduled parent/i,
  );
  const rows = await withClient((client) => client.query(
    "select id,status from public.pipeline_items where id=any($1::uuid[]) order by id",
    [[first.id, second.id]],
  ));
  assert.equal(rows.rows.find((row) => row.id === first.id).status, "editing");
  assert.equal(rows.rows.find((row) => row.id === second.id).status, "editing");
});

test("local scheduled launch package rejects timezone-less schedule timestamps", async () => {
  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal({
      videoId: "NoTimezone1",
      title: "Invalid local time",
      publishAt: "2026-08-04T12:00:00",
      requestedBy: "test:dev",
    }),
    /timezone-qualified publish_at/i,
  );
});

test("YouTube URL parsing is HTTPS-only and accepts only exact YouTube host boundaries", async () => {
  const videoId = "StrictHost1";
  for (const url of [
    `https://youtube.com/watch?v=${videoId}`,
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://music.youtube.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}`,
    `https://youtube.com/shorts/${videoId}`,
    `https://youtube.com/embed/${videoId}`,
    `https://youtube.com/live/${videoId}`,
  ]) assert.equal(extractYouTubeVideoId(url), videoId);

  for (const url of [
    `http://youtube.com/watch?v=${videoId}`,
    `https://notyoutube.com/watch?v=${videoId}`,
    `https://evil-youtube.com/watch?v=${videoId}`,
    `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://sub.youtu.be/${videoId}`,
    `https://youtube.com/redirect?v=${videoId}`,
    `https://youtube.com/not-a-video?v=${videoId}`,
    `https://user@youtube.com/watch?v=${videoId}`,
    `https://youtube.com:444/watch?v=${videoId}`,
    `https://youtube.com/watch?v=${videoId}#fragment`,
    `https://youtu.be/${videoId}/extra`,
  ]) {
    assert.equal(extractYouTubeVideoId(url), null);
    await assert.rejects(
      () => createScheduledYouTubeLaunchPackageLocal({
        videoId,
        youtubeUrl: url,
        publishAt: "2026-08-04T12:00:00.000Z",
        requestedBy: "test:host",
      }),
      /YouTube URL must use HTTPS/i,
    );
  }
});

test("generation recovery is idempotent but A to B to A never reuses terminal activation evidence", async () => {
  const videoId = "GenCycle001";
  const scheduleA = "2026-08-10T12:00:00.000Z";
  const scheduleB = "2026-08-11T12:00:00.000Z";
  const first = await createScheduledYouTubeLaunchPackageLocal({
    videoId, publishAt: scheduleA, playlistId: "PLabc123", requestedBy: "test:generation",
  });
  const firstGeneration = first.videoItem.metadata.launch_package.launch_generation;
  const firstActivationId = first.videoItem.metadata.launch_package.activation_work_item_id;

  const replay = await createScheduledYouTubeLaunchPackageLocal({
    videoId, publishAt: scheduleA, playlistId: "PLabc123", requestedBy: "test:generation",
  });
  assert.equal(replay.videoItem.metadata.launch_package.launch_generation, firstGeneration);
  assert.equal(replay.videoItem.metadata.launch_package.activation_work_item_id, firstActivationId);

  await withClient((client) => client.query("update public.work_items set status='done' where id=$1", [firstActivationId]));
  const scheduleBResult = await createScheduledYouTubeLaunchPackageLocal({
    videoId, publishAt: scheduleB, playlistId: "PLabc123", requestedBy: "test:generation",
  });
  const generationB = scheduleBResult.videoItem.metadata.launch_package.launch_generation;
  const activationB = scheduleBResult.videoItem.metadata.launch_package.activation_work_item_id;
  assert.notEqual(generationB, firstGeneration);
  assert.notEqual(activationB, firstActivationId);

  const backToA = await createScheduledYouTubeLaunchPackageLocal({
    videoId, publishAt: scheduleA, playlistId: "PLabc123", requestedBy: "test:generation",
  });
  const generationA2 = backToA.videoItem.metadata.launch_package.launch_generation;
  assert.notEqual(generationA2, firstGeneration);
  assert.notEqual(generationA2, generationB);
  assert.notEqual(backToA.videoItem.metadata.launch_package.activation_work_item_id, firstActivationId);

  const rows = await readLaunchRows(videoId);
  const currentActivations = rows.work.filter((row) => row.status !== "done"
    && row.payload.relation_type === "video_launch_activate"
    && row.payload.launch_generation === generationA2);
  assert.equal(currentActivations.length, 1);
  assert.equal(rows.work.find((row) => row.id === firstActivationId).status, "done");
});

test("reschedule rejects in_progress launch work before mutating the parent", async () => {
  const videoId = "InProgress1";
  const first = await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    publishAt: "2026-08-12T12:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:in-progress",
  });
  const workId = first.workItems.find((entry) => entry.relationType === "youtube_launch_preflight").workItem.id;
  await withClient((client) => client.query("update public.work_items set status='in_progress' where id=$1", [workId]));

  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal({
      pipelineItemId: first.videoItem.id,
      videoId,
      publishAt: "2026-08-13T12:00:00.000Z",
      playlistId: "PLabc123",
      requestedBy: "test:in-progress",
    }),
    /while launch work is in_progress/i,
  );
  const preserved = await withClient((client) => client.query(
    "select scheduled_for,metadata from pipeline_items where id=$1",
    [first.videoItem.id],
  ));
  assert.equal(normalizeValue(preserved.rows[0].scheduled_for), "2026-08-12T12:00:00.000Z");
  assert.equal(preserved.rows[0].metadata.launch_package.launch_generation, first.videoItem.metadata.launch_package.launch_generation);
});

test("reschedule lock-order contract is work rows before pipeline row", () => {
  const source = readFileSync(resolve(repoRoot, "src/lib/youtube-launch-package-local.ts"), "utf8");
  const lockCall = source.indexOf("lockLaunchWorkBeforePipeline(client");
  const pipelineLock = source.indexOf("findExactVideoItem(client, resolvedPipelineItemId)", lockCall);
  assert.ok(lockCall >= 0 && pipelineLock > lockCall);
  assert.match(source, /order by id\s+for update/);
  assert.match(source, /global work ->[\s\S]*pipeline row-lock order/);
});

test("scheduling an exact published parent fails closed without creating launch work", async () => {
  const videoId = "ExactPub001";
  const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const exact = await insertVideoPipelineItem({
    status: "published",
    published_at: "2026-07-01T10:00:00.000Z",
    current_url: publicUrl,
    metadata: { youtube_v0: { stage: "published" } },
  });
  const input = {
    pipelineItemId: exact.id,
    videoId,
    youtubeUrl: publicUrl,
    publishAt: "2026-08-02T12:00:00.000Z",
    preparedAt: "2026-07-31T12:00:00.000Z",
    playlistId: "PLabc123",
    requestedBy: "test:board",
  };

  await assert.rejects(
    () => createScheduledYouTubeLaunchPackageLocal(input),
    /cannot schedule.*published/i,
  );

  const rows = await readLaunchRows(videoId);
  assert.equal(rows.work.length, 0);
  const preserved = await withClient((client) => client.query(
    "select status, published_at, current_url from public.pipeline_items where id = $1",
    [exact.id],
  ));
  assert.equal(preserved.rowCount, 1);
  assert.equal(preserved.rows[0].status, "published");
  assert.equal(normalizeValue(preserved.rows[0].published_at), "2026-07-01T10:00:00.000Z");
  assert.equal(preserved.rows[0].current_url, publicUrl);
});
