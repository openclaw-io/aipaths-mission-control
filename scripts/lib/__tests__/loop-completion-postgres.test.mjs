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

const youtubePipeline = transpileModule(resolve(repoRoot, "src/lib/youtube-pipeline.ts"));
const completion = transpileModule(resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts"), {
  "@/lib/youtube-pipeline": youtubePipeline,
});
const databaseUrl = requireMissionControlTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const agentCompletion = transpileModule(resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts"), {
  "@/lib/content/live-verification": { verifyPublishedContent: async () => { throw new Error("unexpected verification"); } },
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
  "@/lib/work-items/completion-orchestration": completion,
});

before(async () => {
  await pool.query("select 1 from public.loops limit 1");
});

after(async () => {
  await pool.end();
});

async function insertLoopGraph({ loopId, workItemId, plan, payload }) {
  await pool.query(
    `insert into public.loops (id, key, name, status, plan, metadata, approval_scope)
     values ($1, $2, 'Loop completion test', 'in_progress', $3::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [loopId, `loop-completion-${loopId}`, JSON.stringify(plan)],
  );
  await pool.query(
    `insert into public.work_items
       (id, loop_id, kind, source_type, source_id, title, instruction, status, owner_agent, payload)
     values ($1::uuid, $2::uuid, 'task', 'loop', $2::uuid::text, 'Execute Loop', 'Original instruction', 'in_progress', 'systems', $3::jsonb)`,
    [workItemId, loopId, JSON.stringify(payload)],
  );
  await pool.query(
    `insert into public.loop_work_items (loop_id, work_item_id, relation_type)
     values ($1, $2, 'primary_execution')`,
    [loopId, workItemId],
  );
}

async function cleanupLoopGraph(loopId, workItemId) {
  await pool.query("delete from public.loop_events where loop_id = $1", [loopId]);
  await pool.query("delete from public.loop_work_items where loop_id = $1", [loopId]);
  await pool.query("delete from public.event_log where entity_id = $1", [workItemId]);
  await pool.query("delete from public.work_items where id = $1", [workItemId]);
  await pool.query("delete from public.loops where id = $1", [loopId]);
}

test("primary Loop completion atomically enters review, completes the plan, and preserves payload context", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const originalPayload = {
    dispatch_state: "notified_agent",
    dispatch_session_key: "agent:systems:mission-control:work-item:test",
    result: { summary: "Existing durable result" },
    execution_context: { branch: "fix/loop-cycle" },
  };
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [
        { id: "step-1", title: "Inspect", status: "pending", notes: "keep" },
        { id: "step-2", title: "Report", status: "in_progress" },
      ],
      payload: originalPayload,
    });

    const first = await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      status: "done",
      output: { diagnosis: "No mutations performed" },
    });
    await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      status: "done",
      output: { diagnosis: "No mutations performed" },
    });

    const loop = (await pool.query("select status, plan from public.loops where id = $1", [loopId])).rows[0];
    const work = (await pool.query("select status, instruction, payload from public.work_items where id = $1", [workItemId])).rows[0];
    const events = await pool.query(
      "select event_type, from_status, to_status from public.loop_events where loop_id = $1 and event_type = 'loop.primary_execution_completed'",
      [loopId],
    );

    assert.equal(first.status, "done");
    assert.equal(loop.status, "in_review");
    assert.deepEqual(loop.plan, [
      { id: "step-1", title: "Inspect", status: "done", notes: "keep" },
      { id: "step-2", title: "Report", status: "done" },
    ]);
    assert.equal(work.status, "done");
    assert.equal(work.instruction, "Original instruction");
    assert.equal(work.payload.dispatch_state, "completed");
    assert.equal(work.payload.dispatch_session_key, originalPayload.dispatch_session_key);
    assert.deepEqual(work.payload.result, originalPayload.result);
    assert.deepEqual(work.payload.execution_context, originalPayload.execution_context);
    assert.deepEqual(work.payload.output, { diagnosis: "No mutations performed" });
    assert.equal(events.rowCount, 1);
    assert.deepEqual(events.rows[0], {
      event_type: "loop.primary_execution_completed",
      from_status: "in_progress",
      to_status: "in_review",
    });
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("Loop reconciliation failure rolls back the work item completion", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Stay pending", status: "pending" }],
      payload: { dispatch_state: "notified_agent", session_context: { id: "keep" } },
    });
    await pool.query(`
      create or replace function pg_temp.reject_test_loop_event() returns trigger language plpgsql as $$
      begin
        if new.loop_id = '${loopId}'::uuid and new.event_type = 'loop.primary_execution_completed' then
          raise exception 'injected Loop event failure';
        end if;
        return new;
      end $$;
      create trigger reject_test_loop_event before insert on public.loop_events
      for each row execute function pg_temp.reject_test_loop_event();
    `);

    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, { status: "done" }),
      /injected Loop event failure/,
    );

    const loop = (await pool.query("select status, plan from public.loops where id = $1", [loopId])).rows[0];
    const work = (await pool.query("select status, completed_at, payload from public.work_items where id = $1", [workItemId])).rows[0];
    assert.equal(loop.status, "in_progress");
    assert.equal(loop.plan[0].status, "pending");
    assert.equal(work.status, "in_progress");
    assert.equal(work.completed_at, null);
    assert.equal(work.payload.dispatch_state, "notified_agent");
    assert.deepEqual(work.payload.session_context, { id: "keep" });
  } finally {
    await pool.query("drop trigger if exists reject_test_loop_event on public.loop_events");
    await cleanupLoopGraph(loopId, workItemId);
  }
});
