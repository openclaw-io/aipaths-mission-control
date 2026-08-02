import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function transpile(sourcePath, requires = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, {
    module: cjs,
    exports: cjs.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected import ${specifier}`);
    },
    Date, JSON, Object, Array, String, Number, RegExp, Error,
    ...globals,
  }, { filename: sourcePath });
  return cjs.exports;
}

test("generic scheduler notify identity is canonical and timestamp-bound", () => {
  const contract = transpile(resolve(repoRoot, "src/lib/work-items/generic-notify-contract.ts"), {
    "node:crypto": { createHash },
  });
  const row = {
    id: "10000000-0000-4000-8000-000000000001",
    status: "in_progress",
    updated_at: new Date("2026-07-30T10:00:00.000Z"),
    source_type: "loop",
    source_id: "20000000-0000-4000-8000-000000000002",
    owner_agent: "systems",
    target_agent_id: null,
    payload: { runtime_contract: "implementation_v1", run_role: "implementation" },
  };
  const expected = contract.buildGenericNotifyClassificationIdentity(row);
  assert.equal(contract.genericNotifyIdentityMatches(expected, row), true);
  assert.equal(contract.genericNotifyIdentityMatches(expected, {
    ...row,
    updated_at: "2026-07-30 11:00:00.000456+01",
  }), true);
  assert.equal(contract.genericNotifyIdentityMatches(expected, {
    ...row,
    updated_at: new Date("2026-07-30T10:00:01.000Z"),
  }), false);
  assert.equal(contract.isVisualQaLikeWorkItem({ ...row, payload: {
    runtime_contract: "visual_qa_vl",
    run_role: "QA",
    target_run_id: row.id,
    target_sha: "a".repeat(40),
    execution_attempt_id: row.id,
    quality_cycle: 1,
    qa_policy_hash: "b".repeat(64),
  } }), true);
  assert.equal(contract.isVisualQaLikeWorkItem({ ...row, payload: { policy_hash: "b".repeat(64) } }), false);
});

test("generic scheduler notify revalidates the locked current row before wake", () => {
  const route = readFileSync(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), "utf8");
  assert.match(route, /caller === "generic_scheduler_v1"/);
  assert.match(route, /genericNotifyIdentityMatches\(schedulerClassificationIdentity, current\)/);
  assert.match(route, /current\.status !== "ready"/);
  assert.match(route, /generic_notify_live_gate_blocked/);
  assert.match(route, /for update/);
  assert.match(route, /withTransaction[\s\S]*wakeAgent\(/);
  assert.match(route, /idempotencyKey/);
  assert.match(route, /generic_notify_lease/);
});

test("generic scheduler notify does not wake a live-gate blocked row", async () => {
  const contract = transpile(resolve(repoRoot, "src/lib/work-items/generic-notify-contract.ts"), {
    "node:crypto": { createHash },
  });
  const statusPayload = transpile(resolve(repoRoot, "src/lib/work-items/status-payload.ts"));
  const row = {
    id: "10000000-0000-4000-8000-000000000010",
    loop_id: null,
    title: "Publish community post",
    instruction: "Publish only when live",
    status: "ready",
    priority: "high",
    owner_agent: "community",
    target_agent_id: "community",
    requested_by: "scheduler",
    scheduled_for: null,
    source_type: "pipeline_item",
    source_id: "20000000-0000-4000-8000-000000000020",
    updated_at: "2026-08-04T13:30:00.000Z",
    payload: {
      pipeline_type: "community_post",
      relation_type: "publish",
      action: "publish_community_post",
      dispatch_state: "blocked_live_gate",
    },
  };
  let spawned = false;
  const route = transpile(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), {
    "node:child_process": { spawn: () => { spawned = true; throw new Error("should not spawn"); } },
    "node:crypto": { randomUUID: () => "30000000-0000-4000-8000-000000000030" },
    "next/server": { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } },
    "@supabase/supabase-js": { createClient: () => ({}) },
    "@/lib/agent-routing": { AGENT_ROUTING: { community: { agentId: "community" } }, isRoutedAgent: (agent) => agent === "community" },
    "@/lib/auth/local": { isLocalAuthDisabled: () => true },
    "@/lib/db/postgres": {
      query: async () => ({ rows: [row] }),
      withTransaction: async (run) => run({ query: async () => ({ rows: [row] }) }),
    },
    "@/lib/loops/execution-instruction": { buildLoopWakeContext: () => "" },
    "@/lib/work-items/generic-notify-contract": contract,
    "@/lib/work-items/status-payload": statusPayload,
  }, {
    process: { env: { AGENT_API_KEY: "test-key" }, cwd: () => repoRoot },
    console: { ...console, error() {}, log() {} },
  });

  const response = await route.POST({
    headers: { get: (key) => key.toLowerCase() === "authorization" ? "Bearer test-key" : null },
    json: async () => ({
      workItemId: row.id,
      agent: "community",
      action: "created",
      caller: "generic_scheduler_v1",
      idempotencyKey: "generic-notify-live-gate-0001",
      expectedClassificationIdentity: contract.buildGenericNotifyClassificationIdentity(row),
    }),
  });

  assert.equal(response.status, 409);
  assert.equal(response.payload.error, "generic_notify_live_gate_blocked");
  assert.equal(spawned, false);
});

function createNotifyHarness({
  initialRow,
  now = "2026-08-04T13:30:00.000Z",
  failSpawn = false,
  asyncSpawnError = null,
}) {
  const contract = transpile(resolve(repoRoot, "src/lib/work-items/generic-notify-contract.ts"), {
    "node:crypto": { createHash },
  });
  const statusPayload = transpile(resolve(repoRoot, "src/lib/work-items/status-payload.ts"));
  let row = structuredClone(initialRow);
  let spawnCount = 0;
  let directWriteCount = 0;
  let transactionTail = Promise.resolve();
  const NativeDate = Date;
  const FixedDate = class extends NativeDate {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return new NativeDate(now).getTime(); }
  };

  const route = transpile(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), {
    "node:child_process": {
      spawn: () => {
        spawnCount += 1;
        if (failSpawn) throw new Error("simulated_spawn_failure");
        const child = new EventEmitter();
        child.pid = 42;
        child.unref = () => {};
        // Avoid EventEmitter's process-fatal default while the RED production
        // implementation has not subscribed to the asynchronous error yet.
        child.on("error", () => {});
        setTimeout(() => {
          if (asyncSpawnError) child.emit("error", new Error(asyncSpawnError));
          else child.emit("spawn");
        }, 0);
        return child;
      },
    },
    "node:crypto": { randomUUID: () => "30000000-0000-4000-8000-000000000030" },
    "next/server": { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } },
    "@supabase/supabase-js": { createClient: () => ({}) },
    "@/lib/agent-routing": { AGENT_ROUTING: { systems: { agentId: "systems" } }, isRoutedAgent: (agent) => agent === "systems" },
    "@/lib/auth/local": { isLocalAuthDisabled: () => true },
    "@/lib/db/postgres": {
      query: async (sql) => {
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.startsWith("select status")) return { rows: [{ status: row.status }] };
        if (normalized.startsWith("update public.work_items")) directWriteCount += 1;
        return { rows: [structuredClone(row)] };
      },
      withTransaction: async (run) => {
        const previous = transactionTail;
        let release;
        transactionTail = new Promise((resolveRelease) => { release = resolveRelease; });
        await previous;
        try {
          return await run({
            query: async (sql, params = []) => {
              const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
              if (normalized.includes("from public.work_items") && normalized.includes("for update")) {
                return { rows: [structuredClone(row)] };
              }
              if (normalized.startsWith("update public.work_items") && normalized.includes("payload=$2::jsonb")) {
                row.payload = typeof params[1] === "string" ? JSON.parse(params[1]) : structuredClone(params[1]);
                row.updated_at = now;
                return { rows: [structuredClone(row)] };
              }
              throw new Error(`Unexpected transaction query: ${normalized}`);
            },
          });
        } finally {
          release();
        }
      },
    },
    "@/lib/loops/execution-instruction": { buildLoopWakeContext: () => "" },
    "@/lib/work-items/generic-notify-contract": contract,
    "@/lib/work-items/status-payload": statusPayload,
  }, {
    process: {
      env: { AGENT_API_KEY: "test-key", GENERIC_NOTIFY_LEASE_MS: "60000" },
      cwd: () => repoRoot,
    },
    console: { ...console, error() {}, log() {} },
    structuredClone,
    Date: FixedDate,
    setTimeout,
    clearTimeout,
  });

  const post = (idempotencyKey, identity = contract.buildGenericNotifyClassificationIdentity(row)) => route.POST({
    headers: { get: (key) => key.toLowerCase() === "authorization" ? "Bearer test-key" : null },
    json: async () => ({
      workItemId: row.id,
      agent: "systems",
      action: "created",
      caller: "generic_scheduler_v1",
      idempotencyKey,
      expectedClassificationIdentity: identity,
    }),
  });

  return {
    contract,
    post,
    getRow: () => structuredClone(row),
    getSpawnCount: () => spawnCount,
    getDirectWriteCount: () => directWriteCount,
    isTrustedImplementationDispatchSessionId: transpile(
      resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts"),
      {
        "@/lib/youtube-pipeline": {},
        "@/lib/youtube-launch-package": {},
        "@/lib/work-items/git-artifact": {},
      },
    ).isTrustedImplementationDispatchSessionId,
  };
}

const atomicReadyRow = {
  id: "10000000-0000-4000-8000-000000000011",
  loop_id: null,
  title: "Atomic generic dispatch",
  instruction: "Do it once",
  status: "ready",
  priority: "high",
  owner_agent: "systems",
  target_agent_id: "systems",
  requested_by: "scheduler",
  scheduled_for: null,
  source_type: "pipeline_item",
  source_id: "20000000-0000-4000-8000-000000000021",
  updated_at: "2026-08-04T13:29:00.000Z",
  payload: { pipeline_type: "generic", preserved: { nested: true } },
};

test("concurrent same-key generic notify spawns once with one pending replay and one accepted outcome", async () => {
  const harness = createNotifyHarness({ initialRow: atomicReadyRow });
  const identity = harness.contract.buildGenericNotifyClassificationIdentity(atomicReadyRow);
  const key = "generic-notify-attempt-same-0001";
  const responses = await Promise.all([harness.post(key, identity), harness.post(key, identity)]);

  assert.equal(harness.getSpawnCount(), 1);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 202]);
  assert.deepEqual(responses.map((response) => response.payload.idempotent).sort(), [false, true]);
  assert.deepEqual(responses.map((response) => response.payload.outcome).sort(), ["accepted", "leased"]);
  const pending = responses.find((response) => response.payload.outcome === "leased");
  assert.equal(pending.payload.accepted, false);
  assert.equal(pending.payload.pending, true);
  assert.equal(harness.getRow().payload.preserved.nested, true, "lease updates must preserve existing payload");
  assert.equal(harness.getRow().payload.generic_notify_lease.key, key);
  assert.equal(harness.getRow().payload.generic_notify_lease.outcome, "accepted");
});

test("concurrent different-key notify requests serialize to one spawn and one active-lease rejection", async () => {
  const harness = createNotifyHarness({ initialRow: atomicReadyRow });
  const originalIdentity = harness.contract.buildGenericNotifyClassificationIdentity(atomicReadyRow);
  const responses = await Promise.all([
    harness.post("generic-notify-attempt-first-0001", originalIdentity),
    harness.post("generic-notify-attempt-other-0002", originalIdentity),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const rejected = responses.find((response) => response.status === 409);
  assert.equal(rejected.payload.error, "generic_notify_lease_active");
  assert.equal(harness.getSpawnCount(), 1);
});

test("an expired lease permits a freshly classified key to wake", async () => {
  const expiredRow = structuredClone(atomicReadyRow);
  expiredRow.payload.generic_notify_lease = {
    version: "generic_notify_lease_v1",
    key: "generic-notify-attempt-expired-0001",
    outcome: "accepted",
    leased_at: "2026-08-04T13:28:00.000Z",
    outcome_at: "2026-08-04T13:28:00.000Z",
    expires_at: "2026-08-04T13:29:59.000Z",
    mode: "hermes_cli_spawn",
    session_key: "old-session",
    error: null,
  };
  const harness = createNotifyHarness({ initialRow: expiredRow, now: "2026-08-04T13:30:00.000Z" });
  const identity = harness.contract.buildGenericNotifyClassificationIdentity(expiredRow);
  const response = await harness.post("generic-notify-attempt-fresh-0002", identity);

  assert.equal(response.status, 200);
  assert.equal(response.payload.idempotent, false);
  assert.equal(harness.getSpawnCount(), 1);
});

test("wake failure is persisted once and same-key retry cannot spawn again", async () => {
  const harness = createNotifyHarness({ initialRow: atomicReadyRow, failSpawn: true });
  const identity = harness.contract.buildGenericNotifyClassificationIdentity(atomicReadyRow);
  const key = "generic-notify-attempt-failed-0001";
  const first = await harness.post(key, identity);
  const retry = await harness.post(key, identity);

  assert.equal(first.status, 503);
  assert.equal(retry.status, 503);
  assert.equal(retry.payload.idempotent, true);
  assert.equal(harness.getSpawnCount(), 1);
  assert.equal(harness.getRow().payload.wake_failure_count, 1);
  assert.equal(harness.getRow().payload.generic_notify_lease.outcome, "failed");
  assert.equal(harness.getRow().payload.generic_notify_lease.error, "simulated_spawn_failure");
});

test("an asynchronous child spawn error fails the wake and persists one failed lease", async () => {
  const harness = createNotifyHarness({
    initialRow: atomicReadyRow,
    asyncSpawnError: "spawn ENOENT",
  });
  const identity = harness.contract.buildGenericNotifyClassificationIdentity(atomicReadyRow);
  const response = await harness.post("generic-notify-async-enoent-0001", identity);

  assert.equal(response.status, 503);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.woke, false);
  assert.equal(response.payload.outcome, "failed");
  assert.equal(response.payload.error, "spawn ENOENT");
  assert.equal(harness.getSpawnCount(), 1);
  assert.equal(harness.getRow().payload.wake_failure_count, 1);
  assert.equal(harness.getRow().payload.generic_notify_lease.outcome, "failed");
  assert.equal(harness.getRow().payload.generic_notify_lease.error, "spawn ENOENT");
});

test("a replayed committed lease from the pre-spawn crash window is pending, never accepted", async () => {
  const leasedRow = structuredClone(atomicReadyRow);
  const key = "generic-notify-crash-window-0001";
  leasedRow.payload.generic_notify_lease = {
    version: "generic_notify_lease_v1",
    key,
    outcome: "leased",
    leased_at: "2026-08-04T13:29:59.000Z",
    expires_at: "2026-08-04T13:30:59.000Z",
    outcome_at: null,
    mode: null,
    session_key: null,
    error: null,
  };
  const harness = createNotifyHarness({ initialRow: leasedRow });
  const response = await harness.post(key);

  assert.equal(response.status, 202);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.accepted, false);
  assert.equal(response.payload.pending, true);
  assert.equal(response.payload.outcome, "leased");
  assert.equal(response.payload.idempotent, true);
  assert.equal(harness.getSpawnCount(), 0);
});

test("generic fresh-review rejection occurs before dispatch-session assignment or any write", async () => {
  const freshReview = {
    ...structuredClone(atomicReadyRow),
    loop_id: "40000000-0000-4000-8000-000000000041",
    source_type: "loop",
    source_id: "50000000-0000-4000-8000-000000000051",
    payload: {
      runtime_contract: "fresh_review_v1",
      run_role: "review",
      source_loop_id: "40000000-0000-4000-8000-000000000041",
    },
  };
  const harness = createNotifyHarness({ initialRow: freshReview });
  const response = await harness.post("generic-notify-fresh-review-0001");

  assert.equal(response.status, 409);
  assert.equal(response.payload.error, "generic_notify_fresh_review_rejected");
  assert.equal(harness.getDirectWriteCount(), 0);
  assert.equal(harness.getRow().payload.dispatch_session_id, undefined);
  assert.equal(harness.getSpawnCount(), 0);
});

test("generic fresh-review rejection cannot be bypassed by replaying a pre-existing lease", async () => {
  const key = "generic-notify-review-replay-0001";
  const freshReview = {
    ...structuredClone(atomicReadyRow),
    loop_id: "40000000-0000-4000-8000-000000000044",
    source_type: "loop",
    source_id: "50000000-0000-4000-8000-000000000054",
    payload: {
      runtime_contract: "fresh_review_v1",
      run_role: "review",
      source_loop_id: "40000000-0000-4000-8000-000000000044",
      generic_notify_lease: {
        version: "generic_notify_lease_v1",
        key,
        outcome: "accepted",
        leased_at: "2026-08-04T13:29:59.000Z",
        expires_at: "2026-08-04T13:30:59.000Z",
        outcome_at: "2026-08-04T13:30:00.000Z",
        mode: "hermes_cli_spawn",
        session_key: "untrusted-review-session",
        error: null,
      },
    },
  };
  const harness = createNotifyHarness({ initialRow: freshReview });
  const before = harness.getRow();
  const response = await harness.post(key);

  assert.equal(response.status, 409);
  assert.equal(response.payload.error, "generic_notify_fresh_review_rejected");
  assert.deepEqual(harness.getRow(), before);
  assert.equal(harness.getSpawnCount(), 0);
});

test("generic fresh-review implementation gets a server UUID accepted by completion and replay preserves it", async () => {
  const implementation = {
    ...structuredClone(atomicReadyRow),
    loop_id: "40000000-0000-4000-8000-000000000042",
    source_type: "loop",
    source_id: "50000000-0000-4000-8000-000000000052",
    payload: {
      runtime_contract: "fresh_review_v1",
      run_role: "implementation",
      source_loop_id: "40000000-0000-4000-8000-000000000042",
      loop_task_id: "50000000-0000-4000-8000-000000000052",
    },
  };
  const harness = createNotifyHarness({ initialRow: implementation });
  const key = "generic-notify-fresh-implementation-0001";
  const first = await harness.post(key);
  const assigned = harness.getRow().payload.dispatch_session_id;
  const replay = await harness.post(key);

  assert.equal(first.status, 200);
  assert.equal(first.payload.dispatchSessionId, assigned);
  assert.equal(assigned, "30000000-0000-4000-8000-000000000030");
  assert.equal(harness.isTrustedImplementationDispatchSessionId(assigned), true);
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.idempotent, true);
  assert.equal(replay.payload.dispatchSessionId, assigned);
  assert.equal(harness.getRow().payload.dispatch_session_id, assigned);
  assert.equal(harness.getSpawnCount(), 1);
});

test("generic fresh-review implementation preserves an existing trusted dispatch UUID", async () => {
  const existingSessionId = "60000000-0000-4000-8000-000000000060";
  const implementation = {
    ...structuredClone(atomicReadyRow),
    loop_id: "40000000-0000-4000-8000-000000000043",
    source_type: "loop",
    source_id: "50000000-0000-4000-8000-000000000053",
    payload: {
      runtime_contract: "fresh_review_v1",
      run_role: "implementation",
      source_loop_id: "40000000-0000-4000-8000-000000000043",
      loop_task_id: "50000000-0000-4000-8000-000000000053",
      dispatch_session_id: existingSessionId,
    },
  };
  const harness = createNotifyHarness({ initialRow: implementation });
  const response = await harness.post("generic-notify-preserve-session-0001");

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.dispatchSessionId, existingSessionId);
  assert.equal(harness.getRow().payload.dispatch_session_id, existingSessionId);
});

test("generic fresh-review implementation replaces an untrusted dispatch session with a server UUID", async () => {
  const implementation = {
    ...structuredClone(atomicReadyRow),
    loop_id: "40000000-0000-4000-8000-000000000045",
    source_type: "loop",
    source_id: "50000000-0000-4000-8000-000000000055",
    payload: {
      runtime_contract: "fresh_review_v1",
      run_role: "implementation",
      source_loop_id: "40000000-0000-4000-8000-000000000045",
      loop_task_id: "50000000-0000-4000-8000-000000000055",
      dispatch_session_id: "caller-controlled-session",
    },
  };
  const harness = createNotifyHarness({ initialRow: implementation });
  const response = await harness.post("generic-notify-replace-session-0001");
  const assigned = harness.getRow().payload.dispatch_session_id;

  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(assigned, "30000000-0000-4000-8000-000000000030");
  assert.equal(harness.isTrustedImplementationDispatchSessionId(assigned), true);
  assert.equal(response.payload.dispatchSessionId, assigned);
});
