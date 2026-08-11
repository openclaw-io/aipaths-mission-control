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
const sourcePath = resolve(repoRoot, "src/lib/db/pipeline-local.ts");
const databaseUrl = requireMissionControlTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });

function transpileModule(path, requires) {
  const source = readFileSync(path, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText;
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require: ${specifier}`);
    },
    console,
    Date,
    JSON,
    Object,
    Array,
    String,
  };
  vm.runInNewContext(output, sandbox, { filename: path });
  return cjsModule.exports;
}

const localPipeline = transpileModule(sourcePath, {
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
});

const {
  createPipelineWorkItemLocal,
  insertPipelineTransitionEventLocal,
  updatePipelineItemLocal,
  withLockedPipelineItemLocal,
} = localPipeline;

const cases = [
  { pipelineType: "blog", relationType: "investigate", action: "develop_blog_draft", target: "researching" },
  { pipelineType: "blog", relationType: "blog_final_package", action: "prepare_blog_final_package", target: "localizing" },
  { pipelineType: "community_post", relationType: "publish", action: "publish_community_post", target: "scheduled" },
  { pipelineType: "guide", relationType: "followup", action: "localize_guide_to_en", target: "localizing" },
  { pipelineType: "video", relationType: "concept", action: "youtube_gate_concept", target: "researching" },
];

before(async () => {
  await pool.query("select 1 from public.pipeline_items limit 1");
});

after(async () => {
  await pool.end();
});

async function insertPipelineItem(config) {
  const id = randomUUID();
  await pool.query(
    `insert into public.pipeline_items (id, pipeline_type, title, status, priority, metadata)
     values ($1, $2, $3, 'draft', 'medium', '{}'::jsonb)`,
    [id, config.pipelineType, `Atomic ${config.pipelineType}`],
  );
  return id;
}

function workInput(id, config) {
  return {
    pipelineItemId: id,
    pipelineType: config.pipelineType,
    title: `Work ${config.pipelineType}`,
    instruction: "Transactional test",
    priority: "medium",
    ownerAgent: "test",
    requestedBy: "transition-test",
    relationType: config.relationType,
    action: config.action,
    trigger: "manual_transition",
  };
}

async function runFlow(id, config, failAfterWrites = false) {
  return withLockedPipelineItemLocal(id, [config.pipelineType], async ({ client, item }) => {
    assert.equal(item.id, id);
    const work = await createPipelineWorkItemLocal(workInput(id, config), client);
    await updatePipelineItemLocal(id, { status: config.target, updated_at: new Date().toISOString() }, client);
    await insertPipelineTransitionEventLocal(client, {
      domain: config.pipelineType,
      eventType: `${config.pipelineType}.${config.action}`,
      pipelineItemId: id,
      actor: "transition-test",
      dedupeKey: config.action,
      payload: { work_item_id: work.workItem.id },
    });
    if (failAfterWrites) throw new Error("injected transition failure");
    return work;
  });
}

for (const config of cases) {
  test(`${config.pipelineType} local transition rolls all writes back after an intermediate failure`, async () => {
    const id = await insertPipelineItem(config);
    try {
      await assert.rejects(runFlow(id, config, true), /injected transition failure/);
      const pipeline = (await pool.query("select status from pipeline_items where id = $1", [id])).rows[0];
      const work = await pool.query("select id from work_items where source_id = $1", [id]);
      const maps = await pool.query("select id from pipeline_work_map where pipeline_item_id = $1", [id]);
      const pipelineEvents = await pool.query("select id from pipeline_events where pipeline_item_id = $1", [id]);
      const transitionEvents = await pool.query("select id from event_log where entity_id = $1", [id]);
      assert.equal(pipeline.status, "draft");
      assert.equal(work.rowCount, 0);
      assert.equal(maps.rowCount, 0);
      assert.equal(pipelineEvents.rowCount, 0);
      assert.equal(transitionEvents.rowCount, 0);
    } finally {
      await pool.query("delete from pipeline_items where id = $1", [id]);
    }
  });

  test(`${config.pipelineType} concurrent local transition reruns dedupe work, map, and events`, async () => {
    const id = await insertPipelineItem(config);
    try {
      const [first, second] = await Promise.all([runFlow(id, config), runFlow(id, config)]);
      assert.equal(first.workItem.id, second.workItem.id);
      assert.equal([first.created, second.created].filter(Boolean).length, 1);

      const work = await pool.query("select id from work_items where source_id = $1 and payload ->> 'relation_type' = $2", [id, config.relationType]);
      const maps = await pool.query("select id from pipeline_work_map where pipeline_item_id = $1", [id]);
      const pipelineEvents = await pool.query("select id from pipeline_events where pipeline_item_id = $1 and event_type = 'pipeline_item.work_item_created'", [id]);
      const transitionEvents = await pool.query("select id from event_log where entity_id = $1 and payload ->> 'dedupe_key' = $2", [id, config.action]);
      assert.equal(work.rowCount, 1);
      assert.equal(maps.rowCount, 1);
      assert.equal(pipelineEvents.rowCount, 1);
      assert.equal(transitionEvents.rowCount, 1);
    } finally {
      await pool.query("delete from pipeline_items where id = $1", [id]);
    }
  });
}
