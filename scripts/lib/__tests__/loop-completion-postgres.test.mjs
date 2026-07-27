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

function transpileModule(sourcePath, requires = {}, globals = {}) {
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
    console,
    process: { env: { AGENT_API_KEY: "test-key" } },
    ...globals,
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

const executionInstruction = transpileModule(resolve(repoRoot, "src/lib/loops/execution-instruction.ts"));
const reviewRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/[id]/review/route.ts"), {
  "next/server": { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } },
  "node:crypto": { randomUUID },
  "@/lib/auth/local": {
    isLocalAuthDisabled: () => true,
    getLocalMissionControlUser: () => ({ email: "concurrency-reviewer@example.test" }),
  },
  "@/lib/db/postgres": {
    withTransaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '5s'");
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
  "@/lib/supabase/server": { createClient: async () => { throw new Error("unexpected cloud auth"); } },
  "@/lib/supabase/admin": { createServiceClient: () => { throw new Error("unexpected cloud client"); } },
  "@/lib/loops/execution-instruction": executionInstruction,
  "@/lib/loops/lifecycle": {
    getPrimaryExecutionWorkItem: async () => null,
    isPrimaryExecutionOpen: (status) => Boolean(status && !["done", "failed", "canceled"].includes(status)),
    reconcileLoopStatusWithPrimaryExecution: async () => {},
  },
}, { fetch: async () => ({ ok: true, status: 200 }), console });

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

test("replaying done for the same execution attempt is a true no-op", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const attemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Finish once", status: "pending" }],
      payload: { execution_attempt_id: attemptId, execution_generation: 1, counter: 4 },
    });
    await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      status: "done",
      execution_attempt_id: attemptId,
      output: { value: "first" },
      payload_increment: { counter: 2 },
      result: "first result",
    });
    const before = (await pool.query(
      "select status, instruction, payload, completed_at, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    const eventsBefore = Number((await pool.query(
      "select count(*)::int as count from public.event_log where entity_id = $1",
      [workItemId],
    )).rows[0].count);

    const replay = await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      status: "done",
      execution_attempt_id: attemptId,
      output: { value: "must-not-overwrite" },
      payload_increment: { counter: 100 },
      payload_patch: { injected: true },
      result: "must not be appended",
    });
    const after = (await pool.query(
      "select status, instruction, payload, completed_at, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    const eventsAfter = Number((await pool.query(
      "select count(*)::int as count from public.event_log where entity_id = $1",
      [workItemId],
    )).rows[0].count);

    assert.equal(replay.status, "done");
    assert.deepEqual(after, before);
    assert.equal(after.payload.counter, 6);
    assert.deepEqual(after.payload.output, { value: "first" });
    assert.equal(after.payload.injected, undefined);
    assert.equal(eventsAfter, eventsBefore);
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("a late completion from a superseded execution attempt is rejected without mutation", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const currentAttemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Current generation", status: "pending" }],
      payload: { execution_attempt_id: currentAttemptId, execution_generation: 2, dispatch_state: "ready_for_rework" },
    });
    const before = (await pool.query("select status, payload, updated_at from public.work_items where id = $1", [workItemId])).rows[0];

    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "done",
        execution_attempt_id: "superseded-attempt",
        output: { stale: true },
      }),
      /stale_execution_attempt/,
    );

    const after = (await pool.query("select status, payload, updated_at from public.work_items where id = $1", [workItemId])).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("terminal status matrix rejects late done/failed inversions", async () => {
  for (const [firstStatus, lateStatus] of [["done", "failed"], ["failed", "done"]]) {
    const loopId = randomUUID();
    const workItemId = randomUUID();
    const attemptId = randomUUID();
    try {
      await insertLoopGraph({
        loopId,
        workItemId,
        plan: [{ id: "step-1", title: "Terminal once", status: "pending" }],
        payload: { execution_attempt_id: attemptId, execution_generation: 1 },
      });
      await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: firstStatus,
        execution_attempt_id: attemptId,
      });
      const before = (await pool.query("select status, payload, completed_at, updated_at from public.work_items where id = $1", [workItemId])).rows[0];

      await assert.rejects(
        () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
          status: lateStatus,
          execution_attempt_id: attemptId,
        }),
        /terminal_status_conflict/,
      );

      const after = (await pool.query("select status, payload, completed_at, updated_at from public.work_items where id = $1", [workItemId])).rows[0];
      assert.deepEqual(after, before);
    } finally {
      await cleanupLoopGraph(loopId, workItemId);
    }
  }
});

test("every terminal work-item state rejects delayed nonterminal agent updates", async () => {
  for (const firstStatus of ["done", "failed", "canceled"]) {
    for (const lateStatus of ["ready", "in_progress"]) {
      const loopId = randomUUID();
      const workItemId = randomUUID();
      const attemptId = randomUUID();
      try {
        await insertLoopGraph({
          loopId,
          workItemId,
          plan: [{ id: "step-1", title: "Never reopen implicitly", status: "in_progress" }],
          payload: { execution_attempt_id: attemptId, execution_generation: 1 },
        });
        await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
          status: firstStatus,
          execution_attempt_id: attemptId,
        });
        const before = (await pool.query(
          "select status, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
          [workItemId],
        )).rows[0];

        await assert.rejects(
          () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
            status: lateStatus,
            execution_attempt_id: attemptId,
            payload_patch: { delayed_update: true },
          }),
          /terminal_status_conflict/,
        );

        const after = (await pool.query(
          "select status, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
          [workItemId],
        )).rows[0];
        assert.deepEqual(after, before);
      } finally {
        await cleanupLoopGraph(loopId, workItemId);
      }
    }
  }
});

test("attempt identity protects every effective attempt-scoped agent PATCH", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const attemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Protect current attempt", status: "in_progress" }],
      payload: { execution_attempt_id: attemptId, execution_generation: 2, counter: 3 },
    });
    const before = (await pool.query(
      "select status, scheduled_for, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];

    const mutations = [
      { status: "in_progress", payload_patch: { dispatch_state: "claimed_by_agent", claimed_by: "stale-agent" } },
      { status: "ready" },
      { scheduled_for: "2099-05-01T12:00:00.000Z" },
      { output: { stale: true } },
      { result: "stale result" },
      { payload_patch: { stale_patch: true } },
      { payload_increment: { counter: 10 } },
    ];
    for (const mutation of mutations) {
      for (const executionAttemptId of [undefined, "superseded-attempt"]) {
        await assert.rejects(
          () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
            ...mutation,
            ...(executionAttemptId ? { execution_attempt_id: executionAttemptId } : {}),
          }),
          /stale_execution_attempt/,
        );
      }
    }

    const after = (await pool.query(
      "select status, scheduled_for, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    assert.deepEqual(after, before);

    const scheduledFor = "2099-05-01T12:00:00.000Z";
    await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      execution_attempt_id: attemptId,
      scheduled_for: scheduledFor,
    });
    const accepted = (await pool.query(
      "select scheduled_for from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    assert.equal(new Date(accepted.scheduled_for).toISOString(), scheduledFor);
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("empty and semantic no-op agent PATCHes are rejected without timestamps or events", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const attemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Do not touch no-ops", status: "in_progress" }],
      payload: {
        execution_attempt_id: attemptId,
        execution_generation: 1,
        counter: 3,
        context: { alpha: 1, beta: 2 },
      },
    });
    const before = (await pool.query(
      "select status, scheduled_for, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    const eventsBefore = Number((await pool.query(
      "select count(*)::int as count from public.event_log where entity_id = $1",
      [workItemId],
    )).rows[0].count);

    for (const noOp of [
      {},
      { execution_attempt_id: attemptId },
      { execution_attempt_id: attemptId, status: "in_progress" },
      { execution_attempt_id: attemptId, scheduled_for: null },
      { execution_attempt_id: attemptId, payload_patch: { counter: 3 } },
      { execution_attempt_id: attemptId, payload_patch: { context: { beta: 2, alpha: 1 } } },
      { execution_attempt_id: attemptId, payload_increment: { counter: 0 } },
    ]) {
      await assert.rejects(
        () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, noOp),
        /empty_work_item_patch/,
      );
    }

    const after = (await pool.query(
      "select status, scheduled_for, started_at, completed_at, payload, updated_at from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    const eventsAfter = Number((await pool.query(
      "select count(*)::int as count from public.event_log where entity_id = $1",
      [workItemId],
    )).rows[0].count);
    assert.deepEqual(after, before);
    assert.equal(eventsAfter, eventsBefore);
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("canceling a primary execution atomically closes dispatch and blocks its Loop with an event", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const attemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Canceled step", status: "in_progress" }],
      payload: {
        execution_attempt_id: attemptId,
        execution_generation: 1,
        dispatch_state: "notified_agent",
      },
    });

    await pool.query(`
      create or replace function pg_temp.reject_test_loop_cancel_event() returns trigger language plpgsql as $$
      begin
        if new.loop_id = '${loopId}'::uuid and new.event_type = 'loop.primary_execution_canceled' then
          raise exception 'injected Loop cancellation event failure';
        end if;
        return new;
      end $$;
      create trigger reject_test_loop_cancel_event before insert on public.loop_events
      for each row execute function pg_temp.reject_test_loop_cancel_event();
    `);

    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "canceled",
        execution_attempt_id: attemptId,
        result: "operator canceled execution",
      }),
      /injected Loop cancellation event failure/,
    );
    const rolledBackLoop = (await pool.query("select status from public.loops where id = $1", [loopId])).rows[0];
    const rolledBackWork = (await pool.query(
      "select status, instruction, completed_at, payload from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    assert.equal(rolledBackLoop.status, "in_progress");
    assert.equal(rolledBackWork.status, "in_progress");
    assert.equal(rolledBackWork.instruction, "Original instruction");
    assert.equal(rolledBackWork.completed_at, null);
    assert.equal(rolledBackWork.payload.dispatch_state, "notified_agent");
    await pool.query("drop trigger reject_test_loop_cancel_event on public.loop_events");

    await agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
      status: "canceled",
      execution_attempt_id: attemptId,
      result: "operator canceled execution",
    });

    const loop = (await pool.query("select status, plan from public.loops where id = $1", [loopId])).rows[0];
    const work = (await pool.query(
      "select status, completed_at, payload from public.work_items where id = $1",
      [workItemId],
    )).rows[0];
    const events = await pool.query(
      `select event_type, from_status, to_status, payload
         from public.loop_events
        where loop_id = $1 and event_type = 'loop.primary_execution_canceled'`,
      [loopId],
    );

    assert.equal(work.status, "canceled");
    assert.ok(work.completed_at);
    assert.equal(work.payload.dispatch_state, "canceled");
    assert.ok(work.payload.dispatch_completed_at);
    assert.equal(loop.status, "blocked");
    assert.equal(loop.plan[0].status, "in_progress");
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].from_status, "in_progress");
    assert.equal(events.rows[0].to_status, "blocked");
    assert.equal(events.rows[0].payload.work_item_id, workItemId);
    assert.equal(events.rows[0].payload.work_item_status, "canceled");
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});

test("Loop review rejects approval and rework outside the valid in-review/done-primary matrix", async () => {
  const invalidCases = [
    { action: "approve_deliverable", loopStatus: "in_progress", primaryStatus: "done", error: "invalid_review_state" },
    { action: "approve_deliverable", loopStatus: "in_review", primaryStatus: "failed", error: "primary_execution_not_done" },
    { action: "approve_deliverable", loopStatus: "in_review", primaryStatus: "canceled", error: "primary_execution_not_done" },
    { action: "approve_deliverable", loopStatus: "in_review", primaryStatus: null, error: "primary_execution_missing" },
    { action: "request_changes", loopStatus: "completed", primaryStatus: "done", error: "invalid_review_state" },
    { action: "request_changes", loopStatus: "in_review", primaryStatus: "failed", error: "primary_execution_not_done" },
  ];

  for (const testCase of invalidCases) {
    const loopId = randomUUID();
    const workItemId = randomUUID();
    try {
      await insertLoopGraph({
        loopId,
        workItemId,
        plan: [{ id: "step-1", title: "Review gate", status: "done" }],
        payload: { execution_attempt_id: randomUUID(), execution_generation: 1 },
      });
      await pool.query("update public.loops set status = $1 where id = $2", [testCase.loopStatus, loopId]);
      if (testCase.primaryStatus === null) {
        await pool.query("delete from public.loop_work_items where loop_id = $1", [loopId]);
      } else {
        await pool.query("update public.work_items set status = $1, completed_at = now() where id = $2", [testCase.primaryStatus, workItemId]);
      }
      const beforeLoop = (await pool.query("select status, metadata, updated_at from public.loops where id = $1", [loopId])).rows[0];
      const beforeWork = (await pool.query("select status, payload, updated_at from public.work_items where id = $1", [workItemId])).rows[0];

      const response = await reviewRoute.POST(
        { json: async () => ({ action: testCase.action, feedback: "must not mutate invalid source state" }) },
        { params: Promise.resolve({ id: loopId }) },
      );

      assert.equal(response.status, 409);
      assert.equal(response.payload.error, testCase.error);
      const afterLoop = (await pool.query("select status, metadata, updated_at from public.loops where id = $1", [loopId])).rows[0];
      const afterWork = (await pool.query("select status, payload, updated_at from public.work_items where id = $1", [workItemId])).rows[0];
      assert.deepEqual(afterLoop, beforeLoop);
      assert.deepEqual(afterWork, beforeWork);
    } finally {
      await cleanupLoopGraph(loopId, workItemId);
    }
  }
});

test("exact approve/request_changes review replays return 200 before the source-state matrix, while new actions remain invalid", async () => {
  for (const action of ["approve_deliverable", "request_changes"]) {
    const loopId = randomUUID();
    const workItemId = randomUUID();
    const attemptId = randomUUID();
    const feedback = action === "approve_deliverable" ? "Ship this exact deliverable" : "Revise this exact detail";
    try {
      await insertLoopGraph({
        loopId,
        workItemId,
        plan: [{ id: "step-1", title: "Replay review exactly", status: "done" }],
        payload: { execution_attempt_id: attemptId, execution_generation: 1 },
      });
      await pool.query("update public.loops set status = 'in_review' where id = $1", [loopId]);
      await pool.query("update public.work_items set status = 'done', completed_at = now() where id = $1", [workItemId]);

      const invoke = (nextFeedback) => reviewRoute.POST(
        { json: async () => ({ action, feedback: nextFeedback }) },
        { params: Promise.resolve({ id: loopId }) },
      );
      const first = await invoke(feedback);
      assert.equal(first.status, 200);
      const beforeReplayLoop = (await pool.query(
        "select status, metadata, updated_at from public.loops where id = $1",
        [loopId],
      )).rows[0];
      const beforeReplayWork = (await pool.query(
        "select status, instruction, payload, updated_at from public.work_items where id = $1",
        [workItemId],
      )).rows[0];
      const eventsBefore = Number((await pool.query(
        "select count(*)::int as count from public.loop_events where loop_id = $1",
        [loopId],
      )).rows[0].count);

      const replay = await invoke(feedback);
      assert.equal(replay.status, 200);
      assert.equal(replay.payload.status, action === "approve_deliverable" ? "completed" : "in_progress");
      assert.deepEqual((await pool.query(
        "select status, metadata, updated_at from public.loops where id = $1",
        [loopId],
      )).rows[0], beforeReplayLoop);
      assert.deepEqual((await pool.query(
        "select status, instruction, payload, updated_at from public.work_items where id = $1",
        [workItemId],
      )).rows[0], beforeReplayWork);
      assert.equal(Number((await pool.query(
        "select count(*)::int as count from public.loop_events where loop_id = $1",
        [loopId],
      )).rows[0].count), eventsBefore);

      const changedAction = await invoke(`${feedback} changed`);
      assert.equal(changedAction.status, 409);
      assert.equal(changedAction.payload.error, "invalid_review_state");
    } finally {
      await cleanupLoopGraph(loopId, workItemId);
    }
  }
});

test("concurrent completion and request_changes serialize without deadlock and reject any superseded attempt", async () => {
  const loopId = randomUUID();
  const workItemId = randomUUID();
  const attemptId = randomUUID();
  try {
    await insertLoopGraph({
      loopId,
      workItemId,
      plan: [{ id: "step-1", title: "Concurrent handoff", status: "in_progress" }],
      payload: {
        execution_attempt_id: attemptId,
        execution_generation: 1,
        dispatch_state: "notified_agent",
        dispatch_session_key: "old-session",
        durable_context: { preserve: true },
      },
    });
    await pool.query("update public.loops set status = 'in_review' where id = $1", [loopId]);
    await pool.query(
      "update public.work_items set status = 'done', completed_at = now(), payload = payload || $1::jsonb where id = $2",
      [JSON.stringify({ dispatch_state: "completed", dispatch_completed_at: new Date().toISOString() }), workItemId],
    );

    const [completionResult, reworkResult] = await Promise.allSettled([
      agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "done",
        execution_attempt_id: attemptId,
        output: { candidate: "possibly completed before rework" },
      }),
      reviewRoute.POST(
        { json: async () => ({ action: "request_changes", feedback: "Run a fresh attempt" }) },
        { params: Promise.resolve({ id: loopId }) },
      ),
    ]);

    assert.equal(reworkResult.status, "fulfilled");
    if (completionResult.status === "rejected") {
      assert.match(String(completionResult.reason), /stale_execution_attempt/);
    }
    for (const result of [completionResult, reworkResult]) {
      if (result.status === "rejected") assert.doesNotMatch(String(result.reason), /deadlock|lock timeout/i);
    }

    const loop = (await pool.query("select status from public.loops where id = $1", [loopId])).rows[0];
    const work = (await pool.query("select status, started_at, completed_at, payload from public.work_items where id = $1", [workItemId])).rows[0];
    assert.equal(loop.status, "in_progress");
    assert.equal(work.status, "ready");
    assert.equal(work.started_at, null);
    assert.equal(work.completed_at, null);
    assert.notEqual(work.payload.execution_attempt_id, attemptId);
    assert.equal(work.payload.execution_generation, 2);
    assert.equal(work.payload.dispatch_state, "ready_for_rework");
    assert.equal(work.payload.dispatch_session_key, undefined);
    assert.deepEqual(work.payload.durable_context, { preserve: true });
  } finally {
    await cleanupLoopGraph(loopId, workItemId);
  }
});
