import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const completionSource = resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts");
const agentCompletionSource = resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts");
const youtubeSource = resolve(repoRoot, "src/lib/youtube-pipeline.ts");

function transpileModule(sourcePath, requires = {}) {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
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
    Date,
    Number,
    Set,
    JSON,
    String,
    RegExp,
    Object,
    Array,
    Math,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const youtubePipeline = transpileModule(youtubeSource);
const { orchestrateWorkItemCompletion, buildPublicationVerificationRequest } = transpileModule(completionSource, {
  "@/lib/youtube-pipeline": youtubePipeline,
  "@/lib/work-items/git-artifact": {
    verifyRepositoryCommit: async (repositoryPath, sha) => ({ repositoryPath, repositoryRoot: repositoryPath, sha }),
  },
});

const databaseUrl = requireMissionControlTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const agentCompletion = transpileModule(agentCompletionSource, {
  "@/lib/content/live-verification": {
    verifyPublishedContent: async () => {
      throw new Error("verification unavailable");
    },
  },
  "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": {
    query: (text, params) => pool.query(text, params),
    withTransaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await run(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  },
  "@/lib/work-items/completion-orchestration": { orchestrateWorkItemCompletion, buildPublicationVerificationRequest },
});

before(async () => {
  await pool.query("select 1 from public.work_items limit 1");
});

after(async () => {
  await pool.end();
});

async function inRollbackTransaction(run) {
  const client = await pool.connect();
  await client.query("begin");
  try {
    await run(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function insertPipelineItem(client, overrides = {}) {
  const id = randomUUID();
  const values = {
    pipeline_type: "community_post",
    title: "Test pipeline item",
    status: "draft",
    metadata: {},
    ...overrides,
  };
  const result = await client.query(
    `insert into public.pipeline_items
       (id, pipeline_type, title, slug, status, priority, owner_agent, requested_by,
        source_type, source_id, scheduled_for, published_at, current_url, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     returning *`,
    [
      id,
      values.pipeline_type,
      values.title,
      values.slug || null,
      values.status,
      values.priority || "medium",
      values.owner_agent || "test",
      values.requested_by || "test",
      values.source_type || "manual",
      values.source_id || null,
      values.scheduled_for || null,
      values.published_at || null,
      values.current_url || null,
      JSON.stringify(values.metadata),
    ],
  );
  return result.rows[0];
}

async function insertWorkItem(client, pipelineItem, payloadOverrides = {}) {
  const id = randomUUID();
  const payload = {
    pipeline_type: pipelineItem.pipeline_type,
    pipeline_item_id: pipelineItem.id,
    relation_type: "draft",
    action: "develop_community_post",
    ...payloadOverrides,
  };
  const result = await client.query(
    `insert into public.work_items
       (id, kind, source_type, source_id, title, instruction, status, priority,
        owner_agent, target_agent_id, requested_by, payload)
     values ($1,'task','pipeline_item',$2,$3,'test','in_progress','medium',$4,$4,'test',$5::jsonb)
     returning *`,
    [id, pipelineItem.id, `Complete ${pipelineItem.title}`, payloadOverrides.owner_agent || "test", JSON.stringify(payload)],
  );
  return result.rows[0];
}

function completed(workItem) {
  return { ...workItem, status: "done", completed_at: new Date(), updated_at: new Date() };
}

const verifyPublishedContent = async ({ url }) => ({
  ok: true,
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  errors: [],
  checks: { reachable: true },
});

test("community completion persists output copy and moves the pipeline card to ready_for_review", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, { metadata: { copy: { text: "" } } });
    const workItem = await insertWorkItem(client, pipelineItem);

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { copy: { text: "Copy final para Discord" } } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.equal(row.metadata.copy.text, "Copy final para Discord");
    assert.equal(row.metadata.runtime_feedback.last_status, "copy_saved");
  });
});

test("community scheduling creates one future publish work item and is replay-safe", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      status: "approved",
      metadata: { copy: { text: "Copy aprobada" }, kind: "news" },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "schedule",
      action: "schedule_community_post",
    });
    const body = { status: "done", output: { scheduled_for: "2026-08-03T12:00:00.000Z" } };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });
    await orchestrateWorkItemCompletion(client, {
      existing: completed(workItem),
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });

    const pipeline = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(pipeline.status, "scheduled");
    assert.equal(new Date(pipeline.metadata.schedule.scheduled_for).toISOString(), "2026-08-03T12:00:00.000Z");
    const publishWork = await client.query(
      "select id, scheduled_for, payload from public.work_items where source_id = $1 and payload ->> 'action' = 'publish_community_post'",
      [pipelineItem.id],
    );
    assert.equal(publishWork.rowCount, 1);
    assert.equal(new Date(publishWork.rows[0].scheduled_for).toISOString(), "2026-08-03T12:00:00.000Z");
    assert.equal(pipeline.metadata.schedule.publish_work_item_id, publishWork.rows[0].id);
  });
});

test("email_draft completion stores the draft and moves email_campaign to ready_for_review", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "email_campaign",
      status: "drafting",
      metadata: { kind: "video_announcement" },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "marketing_email_campaign",
      action: "draft_video_announcement",
    });
    const emailDraft = {
      subject: "Nuevo video de AIPaths",
      preview_text: "Una forma práctica de operar con IA",
      body_markdown: "Mirá el nuevo video.",
    };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { email_draft: emailDraft } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.deepEqual(row.metadata.draft, emailDraft);
    assert.equal(row.metadata.review.status, "ready_for_review");
  });
});

test("YouTube gate completion updates gate history once and derives terminal completion state", async () => {
  await inRollbackTransaction(async (client) => {
    const gates = Object.fromEntries(youtubePipeline.YOUTUBE_GATE_ORDER.map((key) => [key, { status: key === "postmortem" ? "not_started" : "pass", history: [] }]));
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "published",
      published_at: "2026-07-01T10:00:00.000Z",
      metadata: { gates, scores: { reach: 8, retention: 7, conversion: 6, confidence: 9 } },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "postmortem",
      action: "youtube_gate_postmortem",
      owner_agent: "youtube",
    });
    const body = { status: "done", gate_status: "pass", output: { evidence_summary: "Learning loop complete" } };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });
    await orchestrateWorkItemCompletion(client, {
      existing: completed(workItem),
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "archived");
    assert.equal(row.metadata.gates.postmortem.status, "pass");
    assert.equal(row.metadata.gates.postmortem.evidence_summary, "Learning loop complete");
    assert.equal(row.metadata.gates.postmortem.history.length, 1);
  });
});

for (const pipelineType of ["blog", "guide"]) {
  test(`${pipelineType} publish completion verifies and persists live publication state`, async () => {
    await inRollbackTransaction(async (client) => {
      const pipelineItem = await insertPipelineItem(client, {
        pipeline_type: pipelineType,
        slug: `test-${pipelineType}`,
        status: "scheduled",
        metadata: { seo: { meta_description: `Test ${pipelineType}` } },
      });
      const workItem = await insertWorkItem(client, pipelineItem, {
        relation_type: "publish",
        action: pipelineType === "blog" ? "publish_blog" : "publish_guide",
        owner_agent: "dev",
      });
      const url = `https://aipaths.academy/${pipelineType}s/test-${pipelineType}`;

      const completionBody = { status: "done", current_url: url, published_at: "2026-07-26T10:00:00.000Z" };
      const verificationRequest = buildPublicationVerificationRequest(completed(workItem), pipelineItem, completionBody);
      await orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: completionBody,
        publicationVerification: {
          request: verificationRequest,
          result: await verifyPublishedContent({ url }),
          workItemId: workItem.id,
          workItemUpdatedAt: workItem.updated_at ? String(workItem.updated_at) : null,
          pipelineItemId: pipelineItem.id,
          pipelineItemUpdatedAt: pipelineItem.updated_at ? String(pipelineItem.updated_at) : null,
        },
      });

      const row = (await client.query("select status, current_url, published_at, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
      assert.equal(row.status, "live");
      assert.equal(row.current_url, url);
      assert.equal(new Date(row.published_at).toISOString(), "2026-07-26T10:00:00.000Z");
      assert.equal(row.metadata.publication_verification.result.ok, true);

      if (pipelineType === "guide") {
        const announcement = await client.query(
          "select id, status from public.pipeline_items where pipeline_type = 'community_post' and source_id = $1",
          [pipelineItem.id],
        );
        assert.equal(announcement.rowCount, 1);
        const announcementWork = await client.query(
          "select id from public.work_items where source_id = $1 and payload ->> 'action' = 'draft_guide_announcement'",
          [announcement.rows[0].id],
        );
        assert.equal(announcementWork.rowCount, 1);
      }
    });
  });
}

test("publication completion rejects stale preflight evidence under the row lock before applying live state", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "blog",
      title: "CAS publication",
      slug: "cas-publication",
      status: "scheduled",
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "publish",
      action: "publish_blog",
      owner_agent: "dev",
    });
    const body = { status: "done", current_url: "https://aipaths.academy/blogs/cas-publication" };
    const updated = completed(workItem);
    const request = buildPublicationVerificationRequest(updated, pipelineItem, body);

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated,
        body,
        publicationVerification: {
          request,
          result: { ok: true, finalUrl: body.current_url },
          workItemId: workItem.id,
          workItemUpdatedAt: workItem.updated_at ? String(workItem.updated_at) : null,
          pipelineItemId: pipelineItem.id,
          pipelineItemUpdatedAt: "stale-version",
        },
      }),
      /verification snapshot changed/,
    );

    const row = (await client.query("select status, current_url from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.current_url, null);
  });
});

test("agent completion rolls the work item and pipeline effects back together when publication verification throws", async () => {
  const pipelineId = randomUUID();
  const workItemId = randomUUID();
  try {
    await pool.query(
      `insert into public.pipeline_items (id, pipeline_type, title, slug, status, metadata)
       values ($1, 'blog', 'Atomic publication test', 'atomic-publication-test', 'scheduled', '{}'::jsonb)`,
      [pipelineId],
    );
    await pool.query(
      `insert into public.work_items
         (id, kind, source_type, source_id, title, instruction, status, owner_agent, payload)
       values ($1, 'task', 'pipeline_item', $2, 'Publish atomic test', 'test', 'in_progress', 'dev', $3::jsonb)`,
      [workItemId, pipelineId, JSON.stringify({
        pipeline_type: "blog",
        pipeline_item_id: pipelineId,
        relation_type: "publish",
        action: "publish_blog",
      })],
    );

    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "done",
        current_url: "https://aipaths.academy/blogs/atomic-publication-test",
      }),
      /verification unavailable/,
    );

    const workItem = (await pool.query("select status, completed_at from public.work_items where id = $1", [workItemId])).rows[0];
    const pipelineItem = (await pool.query("select status, current_url from public.pipeline_items where id = $1", [pipelineId])).rows[0];
    const events = await pool.query("select id from public.event_log where entity_id = $1", [workItemId]);
    assert.equal(workItem.status, "in_progress");
    assert.equal(workItem.completed_at, null);
    assert.equal(pipelineItem.status, "scheduled");
    assert.equal(pipelineItem.current_url, null);
    assert.equal(events.rowCount, 0);
  } finally {
    await pool.query("delete from public.work_items where id = $1", [workItemId]);
    await pool.query("delete from public.pipeline_items where id = $1", [pipelineId]);
  }
});
