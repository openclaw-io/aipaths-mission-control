import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl,
  databaseUrlForName,
  defaultTestAdminDatabaseUrl,
  generateMissionControlTestDatabaseName,
  quotePostgresIdentifier,
  requireMissionControlTestDatabaseUrl,
} from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationDir = resolve(repoRoot, "ops/migrations/20260731_youtube_scheduled_stage");
const preflightSql = readFileSync(resolve(migrationDir, "preflight.sql"), "utf8");
const forwardSql = readFileSync(resolve(migrationDir, "forward.sql"), "utf8");
const rollbackSql = readFileSync(resolve(migrationDir, "rollback.sql"), "utf8");
const { Client } = pg;
requireMissionControlTestDatabaseUrl();
const adminUrl = assertTestAdminDatabaseUrl(
  process.env.MISSION_CONTROL_TEST_ADMIN_URL || defaultTestAdminDatabaseUrl(),
).toString();
const databaseName = generateMissionControlTestDatabaseName();
const databaseUrl = databaseUrlForName(adminUrl, databaseName);
const admin = new Client({ connectionString: adminUrl });
let databaseCreated = false;

before(async () => {
  await admin.connect();
  await admin.query(`create database ${quotePostgresIdentifier(databaseName)}`);
  databaseCreated = true;
  const scratch = new Client({ connectionString: databaseUrl });
  try {
    await scratch.connect();
    await scratch.query(readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8"));
  } finally {
    await scratch.end().catch(() => {});
  }
});

after(async () => {
  if (databaseCreated) {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()",
      [databaseName],
    ).catch(() => {});
    await admin.query(`drop database if exists ${quotePostgresIdentifier(databaseName)}`).catch(() => {});
  }
  await admin.end().catch(() => {});
});

function client() {
  return new Client({ connectionString: databaseUrl });
}

async function insertVideo(db, values) {
  const id = randomUUID();
  await db.query(
    `insert into public.pipeline_items
       (id, pipeline_type, title, status, scheduled_for, published_at, current_url, metadata)
     values ($1, 'video', $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, values.title, values.status, values.scheduledFor || null, values.publishedAt || null, values.currentUrl || null, JSON.stringify(values.metadata)],
  );
  return id;
}

async function insertActivation(db, pipelineItemId, { generation, publishAt, payload = {}, sourceId = pipelineItemId, map = true } = {}) {
  const id = randomUUID();
  const activationPayload = {
    trigger: "youtube_launch_package_v1",
    action: "video_launch_activate",
    pipeline_type: "video",
    pipeline_item_id: pipelineItemId,
    source_video_pipeline_item_id: pipelineItemId,
    relation_type: "video_launch_activate",
    launch_generation: generation,
    publish_at: publishAt,
    ...payload,
  };
  await db.query(
    `insert into public.work_items
       (id,kind,source_type,source_id,title,instruction,status,owner_agent,target_agent_id,payload)
     values ($1,'task','pipeline_item',$2,'Scheduled activation','test','ready','strategist','strategist',$3::jsonb)`,
    [id, sourceId, JSON.stringify(activationPayload)],
  );
  if (map) {
    await db.query(
      "insert into public.pipeline_work_map (pipeline_item_id,work_item_id,relation_type) values ($1,$2,'followup')",
      [pipelineItemId, id],
    );
  }
  return id;
}

test("YouTube Scheduled cutover migrates both stores' semantic shapes and rollback is one-shot", async () => {
  const db = client();
  await db.connect();
  let ownsBackup = false;
  const learningId = await insertVideo(db, {
    title: "Legacy learning",
    status: "learning",
    publishedAt: "2026-05-01T12:00:00.000Z",
    currentUrl: "https://www.youtube.com/watch?v=LegacyVid01",
    metadata: { youtube_v0: { stage: "learning" }, postmortem: { keep: true } },
  });
  const scheduledId = await insertVideo(db, {
    title: "Active scheduled launch",
    status: "editing",
    scheduledFor: "2026-08-04T12:00:00.000Z",
    currentUrl: "https://www.youtube.com/watch?v=Schedule001",
    metadata: {
      youtube_v0: { stage: "editing", video_id: "Schedule001" },
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        status: "scheduled",
        video_id: "Schedule001",
        publish_at: "2026-08-04T12:00:00.000Z",
        launch_generation: "youtube-launch-v1:Schedule001:2026-08-04T12:00:00.000Z",
      },
    },
  });
  const scheduledActivationId = await insertActivation(db, scheduledId, {
    generation: "youtube-launch-v1:Schedule001:2026-08-04T12:00:00.000Z",
    publishAt: "2026-08-04T12:00:00.000Z",
  });
  await db.query(
    "update pipeline_items set metadata=jsonb_set(metadata,'{launch_package,activation_work_item_id}',to_jsonb($1::text),true) where id=$2",
    [scheduledActivationId, scheduledId],
  );
  const unrelatedId = await insertVideo(db, {
    title: "Unrelated editing",
    status: "editing",
    metadata: { youtube_v0: { stage: "editing" } },
  });

  try {
    await db.query(preflightSql);
    await db.query(forwardSql);
    ownsBackup = true;
    const migrated = await db.query(
      "select id, status, scheduled_for, published_at, current_url, metadata from public.pipeline_items where id = any($1::uuid[]) order by id",
      [[learningId, scheduledId, unrelatedId]],
    );
    const byId = new Map(migrated.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(learningId).status, "published");
    assert.equal(byId.get(learningId).metadata.youtube_v0.stage, "published");
    assert.equal(byId.get(learningId).metadata.postmortem.keep, true);
    assert.equal(byId.get(learningId).published_at.toISOString(), "2026-05-01T12:00:00.000Z");
    assert.equal(byId.get(scheduledId).status, "scheduled");
    assert.equal(byId.get(scheduledId).metadata.youtube_v0.stage, "scheduled");
    assert.equal(byId.get(scheduledId).current_url, null);
    assert.equal(byId.get(scheduledId).published_at, null);
    assert.equal(byId.get(unrelatedId).status, "editing");

    await db.query(rollbackSql);
    const restored = await db.query(
      "select id, status, current_url, metadata from public.pipeline_items where id = any($1::uuid[])",
      [[learningId, scheduledId]],
    );
    const restoredById = new Map(restored.rows.map((row) => [row.id, row]));
    assert.equal(restoredById.get(learningId).status, "learning");
    assert.equal(restoredById.get(learningId).metadata.youtube_v0.stage, "learning");
    assert.equal(restoredById.get(scheduledId).status, "editing");
    assert.equal(restoredById.get(scheduledId).current_url, "https://www.youtube.com/watch?v=Schedule001");

    await assert.rejects(() => db.query(rollbackSql), /refusing destructive rollback/);
    await db.query("rollback");
  } finally {
    if (ownsBackup) await db.query("drop schema mission_control_migration_backup cascade").catch(() => {});
    await db.query("delete from public.work_items where id=$1", [scheduledActivationId]).catch(() => {});
    await db.query("delete from public.pipeline_items where id = any($1::uuid[])", [[learningId, scheduledId, unrelatedId]]).catch(() => {});
    await db.end();
  }
});

test("forward cutover rejects malformed activation identity fixtures", async (t) => {
  const fixtures = [
    ["stored activation ID", async (db, context) => {
      await db.query(
        "update pipeline_items set metadata=jsonb_set(metadata,'{launch_package,activation_work_item_id}',to_jsonb($1::text),true) where id=$2",
        [randomUUID(), context.pipelineId],
      );
    }],
    ["terminal activation", async (db, context) => {
      await db.query("update work_items set status='done' where id=$1", [context.activationId]);
    }],
    ["payload generation", async (db, context) => {
      await db.query("update work_items set payload=jsonb_set(payload,'{launch_generation}','\"wrong-generation\"'::jsonb) where id=$1", [context.activationId]);
    }],
    ["payload publish_at", async (db, context) => {
      await db.query("update work_items set payload=jsonb_set(payload,'{publish_at}','\"2026-09-01T00:00:00.000Z\"'::jsonb) where id=$1", [context.activationId]);
    }],
    ["source parent", async (db, context) => {
      await db.query("update work_items set source_id=$1 where id=$2", [randomUUID(), context.activationId]);
    }],
    ["followup mapping", async (db, context) => {
      await db.query("delete from pipeline_work_map where pipeline_item_id=$1 and work_item_id=$2", [context.pipelineId, context.activationId]);
    }],
    ["duplicate open activation", async (db, context) => {
      context.workIds.push(await insertActivation(db, context.pipelineId, {
        generation: context.generation,
        publishAt: context.publishAt,
      }));
    }],
  ];

  for (const [label, mutate] of fixtures) {
    await t.test(label, async () => {
      const db = client();
      await db.connect();
      const publishAt = "2026-08-20T12:00:00.000Z";
      const generation = `youtube-launch-v1:NegFixture1:${publishAt}:fixture`;
      const pipelineId = await insertVideo(db, {
        title: `Negative ${label}`,
        status: "editing",
        scheduledFor: publishAt,
        metadata: {
          youtube_v0: { stage: "editing", video_id: "NegFixture1" },
          launch_package: {
            kind: "scheduled_youtube_launch_package_v1",
            status: "scheduled",
            video_id: "NegFixture1",
            publish_at: publishAt,
            launch_generation: generation,
          },
        },
      });
      const activationId = await insertActivation(db, pipelineId, { generation, publishAt });
      const context = { pipelineId, activationId, generation, publishAt, workIds: [activationId] };
      await db.query(
        "update pipeline_items set metadata=jsonb_set(metadata,'{launch_package,activation_work_item_id}',to_jsonb($1::text),true) where id=$2",
        [activationId, pipelineId],
      );
      try {
        await mutate(db, context);
        await assert.rejects(() => db.query(preflightSql), /preflight found one or more blocker/i);
        await assert.rejects(() => db.query(forwardSql), /requires exactly one valid open activation/i);
        await db.query("rollback");
      } finally {
        await db.query("rollback").catch(() => {});
        await db.query("drop schema if exists mission_control_migration_backup cascade").catch(() => {});
        await db.query("delete from pipeline_work_map where pipeline_item_id=$1 or work_item_id=any($2::uuid[])", [pipelineId, context.workIds]).catch(() => {});
        await db.query("delete from work_items where id=any($1::uuid[])", [context.workIds]).catch(() => {});
        await db.query("delete from pipeline_items where id=$1", [pipelineId]).catch(() => {});
        await db.end();
      }
    });
  }
});

test("preflight and forward SQL encode the full activation identity contract", () => {
  for (const sql of [preflightSql, forwardSql]) {
    assert.match(sql, /activation_work_item_id/);
    assert.match(sql, /launch_generation/);
    assert.match(sql, /publish_at/);
    assert.match(sql, /source_video_pipeline_item_id/);
    assert.match(sql, /source_type\s*=\s*'pipeline_item'/);
    assert.match(sql, /source_id\s*=\s*(?:p|pipeline_items)\.id::text/);
    assert.match(sql, /relation_type\s*=\s*'followup'/);
    assert.match(sql, /count\(\*\)[\s\S]*<> 1/);
  }
  assert.match(preflightSql, /raise exception 'YouTube Scheduled preflight found one or more BLOCKER rows'/);
  assert.match(rollbackSql, /lock table public\.pipeline_items/i);
  assert.match(rollbackSql, /rollback did not restore every backed-up row exactly/i);
});

test("YouTube Scheduled rollback refuses when a migrated target row was deleted", async () => {
  const db = client();
  await db.connect();
  let ownsBackup = false;
  const id = await insertVideo(db, {
    title: "Deleted after cutover",
    status: "learning",
    publishedAt: "2026-05-02T12:00:00.000Z",
    currentUrl: "https://www.youtube.com/watch?v=DeletedVid1",
    metadata: { youtube_v0: { stage: "learning" } },
  });
  try {
    await db.query(forwardSql);
    ownsBackup = true;
    await db.query("delete from public.pipeline_items where id=$1", [id]);
    await assert.rejects(() => db.query(rollbackSql), /missing after cutover|refusing destructive rollback/i);
    await db.query("rollback");
  } finally {
    if (ownsBackup) await db.query("drop schema mission_control_migration_backup cascade").catch(() => {});
    await db.query("delete from public.pipeline_items where id=$1", [id]).catch(() => {});
    await db.end();
  }
});
