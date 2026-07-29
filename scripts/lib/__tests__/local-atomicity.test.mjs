import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pipelineSource = resolve(repoRoot, "src/lib/db/pipeline-local.ts");
const reviewRouteSource = resolve(repoRoot, "src/app/api/loops/[id]/review/route.ts");
const executionInstructionSource = resolve(repoRoot, "src/lib/loops/execution-instruction.ts");

function transpileModule(sourcePath, requires, globals = {}) {
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

function makePipelineHarness({ failOn, existing = null } = {}) {
  const durable = { workItems: [], maps: [], events: [] };
  const log = [];
  const postgres = {
    query: async () => {
      throw new Error("pipeline helper must use its transaction client");
    },
    withTransaction: async (run) => {
      const pending = structuredClone(durable);
      const client = {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          log.push(normalized);
          if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (normalized.startsWith("select id, title, status") && normalized.includes("from work_items")) {
            return { rows: existing ? [existing] : [] };
          }
          if (normalized.startsWith("insert into work_items")) {
            const row = { id: "work-1", title: params[1], status: "ready", payload: JSON.parse(params[7]) };
            pending.workItems.push(row);
            return { rows: [row] };
          }
          if (normalized.startsWith("insert into pipeline_work_map")) {
            if (failOn === "map") throw new Error("map insert failed");
            if (!pending.maps.some((row) => row.pipelineItemId === params[0] && row.workItemId === params[1] && row.relationType === params[2])) {
              pending.maps.push({ pipelineItemId: params[0], workItemId: params[1], relationType: params[2] });
            }
            return { rows: [] };
          }
          if (normalized.startsWith("insert into pipeline_events")) {
            if (failOn === "event") throw new Error("event insert failed");
            const event = JSON.parse(params[1]);
            if (!pending.events.some((row) => row.work_item_id === event.work_item_id)) pending.events.push(event);
            return { rows: [] };
          }
          throw new Error(`Unexpected pipeline SQL: ${normalized}`);
        },
      };
      try {
        const result = await run(client);
        Object.assign(durable, pending);
        log.push("commit");
        return result;
      } catch (error) {
        log.push("rollback");
        throw error;
      }
    },
  };
  const pipelineModule = transpileModule(pipelineSource, {
    "@/lib/db/mission-control": { normalizeRow: (row) => row },
    "@/lib/db/postgres": postgres,
    "@/lib/work-items/pipeline-materializer": {},
  });
  return { pipelineModule, durable, log };
}

function pipelineInput() {
  return {
    pipelineItemId: "pipeline-1",
    pipelineType: "blog",
    relationType: "draft",
    trigger: "test",
    action: "draft_blog",
    title: "Draft blog",
    instruction: "Draft it",
    ownerAgent: "content",
    requestedBy: "test",
  };
}

for (const failOn of ["map", "event"]) {
  test(`createPipelineWorkItemLocal rolls the work item back when the ${failOn} insert fails`, async () => {
    const harness = makePipelineHarness({ failOn });

    await assert.rejects(
      () => harness.pipelineModule.createPipelineWorkItemLocal(pipelineInput()),
      new RegExp(`${failOn} insert failed`),
    );

    assert.deepEqual(harness.durable, { workItems: [], maps: [], events: [] });
    assert.equal(harness.log.at(-1), "rollback");
    assert.equal(harness.log.includes("commit"), false);
  });
}

test("createPipelineWorkItemLocal is replay-safe after taking its transaction-scoped lock", async () => {
  const existing = { id: "existing-work", title: "Draft blog", status: "ready", payload: { relation_type: "draft" } };
  const harness = makePipelineHarness({ existing });

  const result = await harness.pipelineModule.createPipelineWorkItemLocal(pipelineInput());
  const replay = await harness.pipelineModule.createPipelineWorkItemLocal(pipelineInput());

  assert.equal(result.created, false);
  assert.equal(replay.created, false);
  assert.equal(result.workItem.id, "existing-work");
  assert.equal(harness.log.some((sql) => sql.includes("pg_advisory_xact_lock")), true);
  assert.equal(harness.log.some((sql) => sql.startsWith("insert into work_items")), false);
  assert.equal(harness.durable.workItems.length, 0);
  assert.equal(harness.durable.maps.length, 1);
  assert.equal(harness.durable.events.length, 1);
});

function makeReviewHarness({ failEvent = false, failWork = false, notifyError = null } = {}) {
  const executionInstruction = transpileModule(executionInstructionSource, {});
  let state = {
    loop: {
      id: "loop-1",
      status: "in_review",
      name: "Atomic loop",
      summary: "Keep context",
      description: "Review atomically",
      plan: [{ title: "Ship" }],
      metadata: {
        existing_loop_context: true,
        latest_deliverable_feedback_history: ["older feedback"],
        original_input: "No modificar archivos ni servicios",
      },
      approval_scope: {
        allowed_actions: ["inspect"],
        forbidden_actions: ["modify_files", "restart_services"],
        notes: "Read-only",
      },
      owner_agent: "dev",
    },
    workItem: {
      work_item_id: "work-1",
      status: "done",
      payload: {
        loop_id: "loop-1",
        execution_context: { branch: "feature/review" },
        result: { summary: "Previous deliverable" },
        prior_review_feedback: ["payload feedback"],
        dispatch_state: "completed",
        dispatch_session_id: "old-session-id",
        dispatch_session_key: "old-session-key",
      },
      updated_at: "2026-07-25T10:00:00.000Z",
      created_at: "2026-07-24T10:00:00.000Z",
    },
    events: [],
  };
  const log = [];
  let notifyCalls = 0;

  const postgres = {
    query: async () => {
      throw new Error("local review used a query outside its transaction");
    },
    withTransaction: async (run) => {
      const pending = structuredClone(state);
      const client = {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          log.push(normalized);
          if (normalized.startsWith("select id, status") && normalized.includes("from loops")) {
            assert.match(normalized, /for update$/);
            return { rows: pending.loop ? [pending.loop] : [] };
          }
          if (normalized.startsWith("select metadata from loops")) {
            assert.match(normalized, /for update$/);
            return { rows: pending.loop ? [{ metadata: pending.loop.metadata }] : [] };
          }
          if (normalized.includes("from loop_work_items lwi") && normalized.includes("join work_items wi")) {
            assert.match(normalized, /for update of wi$/);
            return { rows: pending.workItem ? [pending.workItem] : [] };
          }
          if (normalized.startsWith("update loops set metadata")) {
            pending.loop.metadata = JSON.parse(params[0]);
            return { rows: [{ id: pending.loop.id }] };
          }
          if (normalized.startsWith("update loops")) {
            pending.loop.status = params[0];
            pending.loop.metadata = JSON.parse(params[1]);
            return { rows: [{ id: pending.loop.id }] };
          }
          if (normalized.startsWith("insert into loop_events")) {
            if (failEvent) throw new Error("loop event insert failed");
            pending.events.push({
              eventType: params[1],
              fromStatus: params[2],
              toStatus: params[3],
              payload: JSON.parse(params[5]),
            });
            return { rows: [] };
          }
          if (normalized.startsWith("update work_items")) {
            if (failWork) throw new Error("work reset failed");
            pending.workItem.status = "ready";
            pending.workItem.instruction = params[1];
            pending.workItem.payload = JSON.parse(params[2]);
            pending.workItem.completed_at = null;
            return { rows: [{ id: pending.workItem.work_item_id }] };
          }
          throw new Error(`Unexpected review SQL: ${normalized}`);
        },
      };
      try {
        const result = await run(client);
        state = pending;
        log.push("commit");
        return result;
      } catch (error) {
        log.push("rollback");
        throw error;
      }
    },
  };

  const fetch = async () => {
    notifyCalls += 1;
    log.push("notify");
    if (notifyError) throw notifyError;
    return { ok: true, status: 200 };
  };

  const route = transpileModule(reviewRouteSource, {
    "next/server": {
      NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) },
    },
    "@/lib/auth/local": {
      isLocalAuthDisabled: () => true,
      getLocalMissionControlUser: () => ({ email: "reviewer@example.test" }),
    },
    "@/lib/db/postgres": postgres,
    "@/lib/supabase/server": { createClient: async () => { throw new Error("unexpected cloud auth"); } },
    "@/lib/supabase/admin": { createServiceClient: () => { throw new Error("unexpected cloud client"); } },
    "node:crypto": { randomUUID: () => "attempt-2" },
    "@/lib/loops/execution-instruction": executionInstruction,
    "@/lib/loops/lifecycle": {
      getPrimaryExecutionWorkItem: async () => null,
      isPrimaryExecutionOpen: (status) => Boolean(status && !["done", "failed", "canceled"].includes(status)),
      reconcileLoopStatusWithPrimaryExecution: async () => {},
    },
  }, { fetch, console: { ...console, error() {} } });

  const request = {
    json: async () => ({
      decision_id: "77777777-7777-4777-8777-777777777777",
      action: "request_changes",
      feedback: "Please preserve the execution context",
    }),
  };

  return {
    route,
    request,
    log,
    get state() { return state; },
    get notifyCalls() { return notifyCalls; },
  };
}

async function postReview(harness) {
  return harness.route.POST(harness.request, { params: Promise.resolve({ id: "loop-1" }) });
}

test("local Loop review commits loop, event and work reset before best-effort notification while preserving payload", async () => {
  const harness = makeReviewHarness({ notifyError: new Error("notify unavailable") });

  const response = await postReview(harness);

  assert.equal(response.status, 200);
  assert.equal(response.payload.status, "in_progress");
  assert.equal(harness.state.loop.status, "in_progress");
  assert.equal(harness.state.events.length, 1);
  assert.equal(harness.state.workItem.status, "ready");
  assert.equal(harness.state.workItem.payload.loop_id, "loop-1");
  assert.deepEqual(harness.state.workItem.payload.execution_context, { branch: "feature/review" });
  assert.deepEqual(harness.state.workItem.payload.result, { summary: "Previous deliverable" });
  assert.deepEqual(harness.state.workItem.payload.prior_review_feedback, ["payload feedback"]);
  assert.equal(harness.state.workItem.payload.review_feedback, "Please preserve the execution context");
  assert.equal(harness.state.workItem.payload.execution_attempt_id, "attempt-2");
  assert.equal(harness.state.workItem.payload.execution_generation, 1);
  assert.equal(harness.state.workItem.payload.dispatch_state, "ready_for_rework");
  assert.equal(harness.state.workItem.payload.dispatch_session_key, undefined);
  assert.equal(harness.state.workItem.payload.dispatch_session_id, undefined);
  assert.match(harness.state.workItem.instruction, /No modificar archivos ni servicios/);
  assert.match(harness.state.workItem.instruction, /Forbidden actions:\n- modify_files\n- restart_services/);
  assert.ok(harness.log.indexOf("commit") < harness.log.indexOf("notify"));
  assert.equal(harness.notifyCalls, 1);
});

test("local Loop review rolls every database change back when event persistence fails", async () => {
  const harness = makeReviewHarness({ failEvent: true });
  const before = structuredClone(harness.state);

  await assert.rejects(() => postReview(harness), /loop event insert failed/);

  assert.deepEqual(harness.state, before);
  assert.equal(harness.log.at(-1), "rollback");
  assert.equal(harness.notifyCalls, 0);
});

test("local Loop review rolls loop and event changes back when the work reset fails", async () => {
  const harness = makeReviewHarness({ failWork: true });
  const before = structuredClone(harness.state);

  await assert.rejects(() => postReview(harness), /work reset failed/);

  assert.deepEqual(harness.state, before);
  assert.equal(harness.log.at(-1), "rollback");
  assert.equal(harness.notifyCalls, 0);
});

test("replaying the same local review action does not duplicate history, event, reset or notification", async () => {
  const harness = makeReviewHarness();

  await postReview(harness);
  const once = structuredClone(harness.state);
  await postReview(harness);

  assert.deepEqual(harness.state, once);
  assert.equal(harness.state.loop.metadata.review_history.length, 1);
  assert.equal(harness.state.events.length, 1);
  assert.equal(harness.notifyCalls, 1);
});
