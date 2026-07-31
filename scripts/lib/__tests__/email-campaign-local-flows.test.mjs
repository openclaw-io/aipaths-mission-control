import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helperSource = resolve(repoRoot, "src/lib/email-campaigns/local.ts");
const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl() });
let failOnSql = null;

async function withTestTransaction(run) {
  const client = await pool.connect();
  const proxy = {
    query(text, params) {
      if (failOnSql?.test(String(text))) throw new Error("injected transaction failure");
      return client.query(text, params);
    },
  };
  try {
    await client.query("begin");
    const result = await run(proxy);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function transpileModule(sourcePath, requires) {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Date, Set, JSON, String, Object, Array, Error,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const localFlows = transpileModule(helperSource, {
  "@/lib/db/postgres": { withTransaction: withTestTransaction },
  "@/lib/db/mission-control": { normalizeRow: (row) => row, normalizeRows: (rows) => rows },
});
const createdPipelineIds = new Set();

before(async () => {
  await pool.query("select 1 from public.pipeline_items limit 1");
});

after(async () => {
  failOnSql = null;
  if (createdPipelineIds.size) {
    const ids = [...createdPipelineIds];
    await pool.query("delete from public.event_log where entity_id = any($1::uuid[])", [ids]);
    await pool.query("delete from public.pipeline_items where id = any($1::uuid[])", [ids]);
  }
  await pool.end();
});

async function insertTopic(title = "Tema para newsletter") {
  const id = randomUUID();
  createdPipelineIds.add(id);
  await pool.query(
    `insert into public.pipeline_items
       (id, pipeline_type, title, status, priority, source_type, source_id, metadata)
     values ($1, 'email_campaign', $2, 'candidate', 'medium', 'intel_inbox', $3, $4::jsonb)`,
    [id, title, `test-topic-${id}`, JSON.stringify({
      intel_source_type: "intel_inbox",
      intel_destination_key: "email",
      summary: "Resumen de prueba",
      custom_topic_metadata: "keep-me",
    })],
  );
  return id;
}

async function insertCampaign(overrides = {}) {
  const id = randomUUID();
  createdPipelineIds.add(id);
  const metadata = {
    kind: "weekly_newsletter",
    draft: { subject: "Asunto", preview_text: "Preview", body_markdown: "Body" },
    custom_campaign_metadata: "keep-me",
    ...(overrides.metadata || {}),
  };
  await pool.query(
    `insert into public.pipeline_items
       (id, pipeline_type, title, status, priority, owner_agent, requested_by, source_type, source_id, metadata)
     values ($1, 'email_campaign', $2, $3, 'medium', 'marketing', 'test', 'manual', $4, $5::jsonb)`,
    [id, overrides.title || "Campaign test", overrides.status || "ready_for_review", `test-campaign-${id}`, JSON.stringify(metadata)],
  );
  return id;
}

async function workRowsFor(pipelineItemId, action) {
  return (await pool.query(
    `select * from public.work_items
      where source_id = $1 and payload ->> 'action' = $2
      order by created_at`,
    [pipelineItemId, action],
  )).rows;
}

test("newsletter rerun reuses the pipeline/work IDs and does not duplicate maps or events", async () => {
  const topicIds = [await insertTopic("Tema A"), await insertTopic("Tema B")];
  const input = { topicIds, requestedBy: "test@aipaths.dev", now: "2099-01-07T10:00:00.000Z" };
  const [first, concurrentRerun] = await Promise.all([
    localFlows.assembleNewsletterLocalAtomic(input),
    localFlows.assembleNewsletterLocalAtomic(input),
  ]);
  createdPipelineIds.add(first.newsletter.id);
  assert.equal(concurrentRerun.newsletter.id, first.newsletter.id);
  assert.equal(concurrentRerun.workItem.id, first.workItem.id);
  await pool.query("update public.pipeline_items set status = 'sent' where id = $1", [first.newsletter.id]);
  await pool.query("update public.work_items set status = 'done', completed_at = now() where id = $1", [first.workItem.id]);
  await pool.query("update public.pipeline_items set status = 'archived' where id = $1", [topicIds[0]]);
  const second = await localFlows.assembleNewsletterLocalAtomic(input);

  assert.equal(second.newsletter.id, first.newsletter.id);
  assert.equal(second.workItem.id, first.workItem.id);
  assert.equal(second.newsletter.status, "sent");
  assert.equal(second.workItem.status, "done");
  assert.equal((await pool.query("select status from public.pipeline_items where id = $1", [topicIds[0]])).rows[0].status, "archived");
  const counts = (await pool.query(
    `select
       (select count(*)::int from public.pipeline_items where source_id = $1) newsletter_count,
       (select count(*)::int from public.work_items where source_id = $2 and payload ->> 'action' = 'draft_weekly_newsletter') work_count,
       (select count(*)::int from public.pipeline_work_map where pipeline_item_id = $2::uuid) map_count,
       (select count(*)::int from public.pipeline_events where pipeline_item_id = $2::uuid and event_type = 'pipeline_item.work_item_created') pipeline_event_count,
       (select count(*)::int from public.event_log where entity_id = $2::uuid and event_type = 'email_campaign.newsletter_requested') event_log_count`,
    ["email-newsletter-2099-01-07", first.newsletter.id],
  )).rows[0];
  assert.deepEqual(counts, { newsletter_count: 1, work_count: 1, map_count: 1, pipeline_event_count: 1, event_log_count: 1 });
});

test("newsletter creation rolls every write back when a late transaction step fails", async () => {
  const topicId = await insertTopic("Tema rollback");
  failOnSql = /insert into public\.event_log/i;
  await assert.rejects(
    () => localFlows.assembleNewsletterLocalAtomic({
      topicIds: [topicId], requestedBy: "test@aipaths.dev", now: "2099-01-08T10:00:00.000Z",
    }),
    /injected transaction failure/,
  );
  failOnSql = null;

  const newsletter = await pool.query("select id from public.pipeline_items where source_id = 'email-newsletter-2099-01-08'");
  const topic = (await pool.query("select status, metadata from public.pipeline_items where id = $1", [topicId])).rows[0];
  assert.equal(newsletter.rowCount, 0);
  assert.equal(topic.status, "candidate");
  assert.equal(topic.metadata.newsletter_usage, undefined);
});

test("request_changes is replay-safe, preserves payload, and rolls work/campaign changes back together", async () => {
  const campaignId = await insertCampaign();
  const input = {
    campaignId,
    feedback: "Hacer el inicio más concreto",
    actorIdentity: "reviewer@aipaths.dev",
    now: "2099-02-01T10:00:00.000Z",
  };
  const first = await localFlows.requestEmailChangesLocalAtomic(input);
  await pool.query("update public.work_items set payload = payload || '{\"custom_payload\":\"keep-me\"}'::jsonb where id = $1", [first.workItem.id]);
  const second = await localFlows.requestEmailChangesLocalAtomic(input);

  assert.equal(second.workItem.id, first.workItem.id);
  const workRows = await workRowsFor(campaignId, "revise_email_draft");
  assert.equal(workRows.length, 1);
  assert.equal(workRows[0].payload.custom_payload, "keep-me");
  const campaign = (await pool.query("select status, metadata from public.pipeline_items where id = $1", [campaignId])).rows[0];
  assert.equal(campaign.status, "drafting");
  assert.equal(campaign.metadata.custom_campaign_metadata, "keep-me");
  assert.equal(campaign.metadata.draft_versions.length, 1);

  await pool.query("update public.work_items set status = 'failed', completed_at = now() where id = $1", [first.workItem.id]);
  const terminalBefore = (await pool.query("select title, instruction, status, scheduled_for, payload from public.work_items where id = $1", [first.workItem.id])).rows[0];
  const third = await localFlows.requestEmailChangesLocalAtomic({ ...input, now: "2099-02-01T11:00:00.000Z" });
  const terminalAfter = (await pool.query("select title, instruction, status, scheduled_for, payload from public.work_items where id = $1", [first.workItem.id])).rows[0];
  assert.equal(third.workItem.id, first.workItem.id);
  assert.deepEqual(terminalAfter, terminalBefore);
  assert.equal((await pool.query("select jsonb_array_length(metadata -> 'draft_versions') count from public.pipeline_items where id = $1", [campaignId])).rows[0].count, 1);

  const rollbackCampaignId = await insertCampaign({ title: "Rollback review" });
  failOnSql = /update public\.pipeline_items/i;
  await assert.rejects(
    () => localFlows.requestEmailChangesLocalAtomic({ ...input, campaignId: rollbackCampaignId, feedback: "Rollback feedback" }),
    /injected transaction failure/,
  );
  failOnSql = null;
  assert.equal((await workRowsFor(rollbackCampaignId, "revise_email_draft")).length, 0);
  assert.equal((await pool.query("select status from public.pipeline_items where id = $1", [rollbackCampaignId])).rows[0].status, "ready_for_review");
});

test("schedule rerun updates one open work item but never rewrites terminal work or its payload", async () => {
  const campaignId = await insertCampaign({ title: "Schedule replay" });
  const first = await localFlows.scheduleEmailCampaignLocalAtomic({
    campaignId, scheduledFor: "2099-03-01T12:00:00.000Z", actorIdentity: "reviewer@aipaths.dev", now: "2099-02-02T10:00:00.000Z",
  });
  await pool.query("update public.work_items set payload = payload || '{\"custom_payload\":\"keep-me\"}'::jsonb where id = $1", [first.workItem.id]);
  const second = await localFlows.scheduleEmailCampaignLocalAtomic({
    campaignId, scheduledFor: "2099-03-02T12:00:00.000Z", actorIdentity: "reviewer@aipaths.dev", now: "2099-02-02T11:00:00.000Z",
  });
  assert.equal(second.workItem.id, first.workItem.id);
  const work = (await workRowsFor(campaignId, "send_email_campaign"))[0];
  assert.equal(work.payload.custom_payload, "keep-me");
  assert.equal(new Date(work.scheduled_for).toISOString(), "2099-03-02T12:00:00.000Z");

  await pool.query("update public.work_items set status = 'done', completed_at = now() where id = $1", [work.id]);
  const terminalBefore = (await pool.query("select title, instruction, status, scheduled_for, payload from public.work_items where id = $1", [work.id])).rows[0];
  const third = await localFlows.scheduleEmailCampaignLocalAtomic({
    campaignId, scheduledFor: "2099-03-03T12:00:00.000Z", actorIdentity: "reviewer@aipaths.dev", now: "2099-02-02T12:00:00.000Z",
  });
  const terminalAfter = (await pool.query("select title, instruction, status, scheduled_for, payload from public.work_items where id = $1", [work.id])).rows[0];

  assert.equal(third.workItem.id, work.id);
  assert.deepEqual(terminalAfter, terminalBefore);
  assert.equal((await workRowsFor(campaignId, "send_email_campaign")).length, 1);

  const rollbackCampaignId = await insertCampaign({ title: "Rollback schedule" });
  failOnSql = /update public\.pipeline_items/i;
  await assert.rejects(
    () => localFlows.scheduleEmailCampaignLocalAtomic({
      campaignId: rollbackCampaignId,
      scheduledFor: "2099-03-04T12:00:00.000Z",
      actorIdentity: "reviewer@aipaths.dev",
      now: "2099-02-02T13:00:00.000Z",
    }),
    /injected transaction failure/,
  );
  failOnSql = null;
  assert.equal((await workRowsFor(rollbackCampaignId, "send_email_campaign")).length, 0);
  const rolledBackCampaign = (await pool.query("select status, scheduled_for from public.pipeline_items where id = $1", [rollbackCampaignId])).rows[0];
  assert.equal(rolledBackCampaign.status, "ready_for_review");
  assert.equal(rolledBackCampaign.scheduled_for, null);
});

test("Email Campaigns UI copy treats approval as auto-scheduled for Scheduled Launch emails", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/email-campaigns/EmailCampaignsClient.tsx"), "utf8");
  assert.match(source, /Email aprobado y programado/);
  assert.match(source, /Aprobar y programar/);
  assert.doesNotMatch(source, /Email aprobado\. Queda en Aprobados para programar\./);
});
