import assert from "node:assert/strict";
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
      `select id, status, to_char(scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scheduled_for, payload
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

test("local scheduled launch package reruns update open schedules without duplicating and preserve terminal work", async () => {
  const videoId = "V2mvpAAA002";
  await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP reschedule",
    publishAt: "2026-07-07T14:00:00.000Z",
    preparedAt: "2026-07-07T10:00:00.000Z",
    requestedBy: "test:dev",
  });
  await createScheduledYouTubeLaunchPackageLocal({
    videoId,
    title: "V2 MVP reschedule",
    publishAt: "2026-07-08T15:00:00.000Z",
    preparedAt: "2026-07-08T10:00:00.000Z",
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
    requestedBy: "test:dev",
  });

  rows = await readLaunchRows(videoId);
  byRelation = workByRelation(rows.work);
  assert.equal(rows.work.length, 9);
  assert.equal(byRelation.get("website_publish_video").id, websiteWorkId);
  assert.equal(byRelation.get("website_publish_video").status, "done");
  assert.equal(byRelation.get("website_publish_video").scheduled_for, "2026-07-08T15:15:00.000Z");
  assert.equal(byRelation.get("video_launch_activate").scheduled_for, "2026-07-09T16:02:00.000Z");
  assert.equal(byRelation.get("youtube_launch_preflight").scheduled_for, "2026-07-09T15:30:00.000Z");
});
