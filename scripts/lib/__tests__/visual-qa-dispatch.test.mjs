import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };

function transpileModule(sourcePath, requires = {}, globals = {}) {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Buffer, Date, JSON, Object, Array, Set, Map, String, Number, RegExp, Promise, Error, console,
    process, setTimeout, clearTimeout, ...globals,
  }, { filename: sourcePath });
  return cjsModule.exports;
}

test("QA dispatch route returns a closed scheduler union and never exposes the raw capability", async () => {
  let result;
  const route = transpileModule(resolve(repoRoot, "src/app/api/qa/dispatch/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": { withTransaction: async () => { throw new Error("unused"); } },
    "@/lib/qa/dispatch": { dispatchQa: async () => result, isQaDispatchError: () => false },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "qa-dispatch-key";
  const request = {
    headers: { get: (name) => name === "authorization" ? "Bearer qa-dispatch-key" : null },
    json: async () => ({ work_item_id: randomUUID() }),
  };
  try {
    const cases = [
      [{ ok: true, already_running: false, state_claimed: true, execution_id: randomUUID(), status: "running", capability: "SECRET" }, 202,
        { ok: true, state_claimed: true, started: true, execution_id: undefined, status: "running" }],
      [{ ok: true, already_running: false, state_claimed: true, execution_id: randomUUID(), status: "succeeded", capability: "SECRET" }, 202,
        { ok: true, state_claimed: true, started: true, execution_id: undefined, status: "succeeded" }],
      [{ ok: true, already_running: true, state_claimed: true, execution_id: randomUUID(), status: "running", capability: "SECRET" }, 409,
        { ok: true, already_running: true, state_claimed: true, execution_id: undefined, status: "running" }],
      [{ ok: true, already_running: false, state_claimed: true, execution_id: randomUUID(), status: "failed", capability: "SECRET" }, 500,
        { ok: false, state_claimed: true, execution_id: undefined, error: "qa_execution_failed" }],
    ];
    for (const [dispatchResult, expectedStatus, expectedBody] of cases) {
      result = dispatchResult;
      const response = await route.POST(request);
      assert.equal(response.status, expectedStatus);
      assert.equal(JSON.stringify(response.payload).includes("SECRET"), false, "raw capability leaked in route response");
      assert.deepEqual(JSON.parse(JSON.stringify(response.payload)), {
        ...expectedBody,
        execution_id: dispatchResult.execution_id,
      });
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = previous;
  }
});

test("QA dispatch route preserves claim certainty for pre-claim and post-claim failures", async () => {
  const claimedExecutionId = randomUUID();
  class QaDispatchError extends Error {
    constructor(message, state_claimed, execution_id) {
      super(message);
      this.kind = "qa_dispatch_error";
      this.state_claimed = state_claimed;
      this.execution_id = execution_id;
    }
  }
  let thrown;
  const route = transpileModule(resolve(repoRoot, "src/app/api/qa/dispatch/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": { withTransaction: async () => { throw new Error("unused"); } },
    "@/lib/qa/dispatch": {
      dispatchQa: async () => { throw thrown; },
      isQaDispatchError: (error) => error?.kind === "qa_dispatch_error",
    },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "qa-dispatch-key";
  const request = {
    headers: { get: (name) => name === "authorization" ? "Bearer qa-dispatch-key" : null },
    json: async () => ({ work_item_id: randomUUID() }),
  };
  try {
    thrown = new QaDispatchError("qa_claim_state_conflict", false);
    let response = await route.POST(request);
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(JSON.stringify(response.payload)), {
      error: "qa_claim_state_conflict",
      state_claimed: false,
    });

    thrown = new QaDispatchError("qa_spawn_failed:postgres://admin:secret@127.0.0.1/db", true, claimedExecutionId);
    response = await route.POST(request);
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(JSON.stringify(response.payload)), {
      error: "qa_dispatch_failed",
      state_claimed: true,
      execution_id: claimedExecutionId,
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = previous;
  }
});

test("QA launcher passes only execution id in argv, allowlisted runtime env, and capability only through FD 3", async () => {
  let spawnCall;
  let fd3 = "";
  let fd3Finished = false;
  const configured = {
    MISSION_CONTROL_DATABASE_URL: "postgres://aipaths_mc_app@127.0.0.1/qa_dispatch_test",
    HERMES_VISUAL_QA_BIN: "/safe/hermes-visual",
    HERMES_VISUAL_QA_PROFILE: "reviewer",
    HERMES_VISUAL_QA_MODEL: "gpt-5.6-sol",
    HERMES_VISUAL_QA_PROVIDER: "openai-codex",
    HERMES_VISUAL_QA_ARTIFACT_ROOT: "/safe/artifacts",
    AGENT_BROWSER_BIN: "/safe/agent-browser",
    AGENT_BROWSER_EXECUTABLE_PATH: "/safe/chrome",
    QA_AUTHORITY_HMAC_KEY: "must-not-propagate",
    SUPER_SECRET_API_KEY: "must-not-propagate",
  };
  const previous = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 5151;
      const fd3Stream = new EventEmitter();
      fd3Stream.write = () => {};
      fd3Stream.end = (value, _encoding, callback) => {
        fd3 += value;
        setTimeout(() => {
          fd3Finished = true;
          fd3Stream.emit("finish");
          callback?.();
        }, 5);
      };
      this.stdio = [null, null, null, fd3Stream];
    }
    unref() { this.unreffed = true; }
    kill() { this.killed = true; }
  }
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": {
      spawn: (file, args, options) => {
        spawnCall = { file, args, options };
        const child = new FakeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, failQaExecution: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  }, { queueMicrotask });
  const capability = randomBytes(32).toString("base64url");
  const executionId = randomUUID();
  const birthToken = "Tue Aug 4 12:34:56 2026";
  try {
    const launched = await dispatch.launchVisualQaRunner(executionId, capability, {
      readIdentity: async () => `5151 5151 ${birthToken} ${process.execPath} ${resolve(repoRoot, "scripts/visual-qa-runner.mjs")} ${executionId}`,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(launched)), { pid: 5151, birth_token: birthToken });
    assert.equal(spawnCall.args.length, 2);
    assert.match(spawnCall.args[0], /scripts\/visual-qa-runner\.mjs$/);
    assert.match(spawnCall.args[1], /^[0-9a-f-]{36}$/);
    assert.equal(spawnCall.args.includes(capability), false);
    assert.equal(Object.values(spawnCall.options.env).includes(capability), false);
    for (const key of ["MISSION_CONTROL_DATABASE_URL", "HERMES_VISUAL_QA_BIN", "HERMES_VISUAL_QA_PROFILE",
      "HERMES_VISUAL_QA_MODEL", "HERMES_VISUAL_QA_PROVIDER", "HERMES_VISUAL_QA_ARTIFACT_ROOT", "AGENT_BROWSER_BIN",
      "AGENT_BROWSER_EXECUTABLE_PATH"]) {
      assert.equal(spawnCall.options.env[key], configured[key], key);
    }
    assert.equal(spawnCall.options.env.QA_AUTHORITY_HMAC_KEY, undefined);
    assert.equal(spawnCall.options.env.SUPER_SECRET_API_KEY, undefined);
    assert.deepEqual(Array.from(spawnCall.options.stdio), ["ignore", "ignore", "ignore", "pipe"]);
    assert.equal(fd3, capability);
    assert.equal(fd3Finished, true, "launcher must await FD 3 finish/end callback before reporting success");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("macOS captures and revalidates a real detached runner identity through /bin/ps", {
  skip: process.platform !== "darwin",
}, async () => {
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": await import("node:child_process"),
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  });
  const executionId = randomUUID();
  const runnerPath = resolve(repoRoot, "scripts/visual-qa-runner.mjs");
  const runner = spawn(process.execPath, [runnerPath, executionId], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    runner.once("spawn", resolveSpawn);
    runner.once("error", rejectSpawn);
  });
  let terminated = false;
  try {
    const identity = await dispatch.captureQaRunnerProcessIdentity(runner.pid, executionId);
    assert.ok(identity,
      "real macOS ps output must preserve the exact executable and argv instead of truncating comm");
    assert.equal(identity.pid, runner.pid);
    assert.equal(await dispatch.verifyQaRunnerProcessIdentity(identity, executionId), true);
    runner.kill("SIGKILL");
    await new Promise((resolveExit) => runner.once("exit", resolveExit));
    terminated = true;
    assert.throws(() => process.kill(runner.pid, 0), (error) => error?.code === "ESRCH");
  } finally {
    runner.stdio[3]?.destroy();
    if (!terminated) {
      try { process.kill(-runner.pid, "SIGKILL"); } catch {}
    }
  }
});

test("runner environment pins the exact Hermes model/provider and rejects overrides", async () => {
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": await import("node:child_process"),
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  });
  const oldModel = process.env.HERMES_VISUAL_QA_MODEL;
  const oldProvider = process.env.HERMES_VISUAL_QA_PROVIDER;
  try {
    delete process.env.HERMES_VISUAL_QA_MODEL;
    delete process.env.HERMES_VISUAL_QA_PROVIDER;
    const env = dispatch.safeVisualQaRunnerEnv();
    assert.equal(env.HERMES_VISUAL_QA_MODEL, "gpt-5.6-sol");
    assert.equal(env.HERMES_VISUAL_QA_PROVIDER, "openai-codex");
    process.env.HERMES_VISUAL_QA_MODEL = "other-model";
    assert.throws(() => dispatch.safeVisualQaRunnerEnv(), /^Error: qa_hermes_contract_override$/);
    process.env.HERMES_VISUAL_QA_MODEL = "gpt-5.6-sol";
    process.env.HERMES_VISUAL_QA_PROVIDER = "other-provider";
    assert.throws(() => dispatch.safeVisualQaRunnerEnv(), /^Error: qa_hermes_contract_override$/);
  } finally {
    if (oldModel === undefined) delete process.env.HERMES_VISUAL_QA_MODEL;
    else process.env.HERMES_VISUAL_QA_MODEL = oldModel;
    if (oldProvider === undefined) delete process.env.HERMES_VISUAL_QA_PROVIDER;
    else process.env.HERMES_VISUAL_QA_PROVIDER = oldProvider;
  }
});

test("FD 3 EPIPE cleans and verifies the entire spawned group before launch failure is exposed", async () => {
  const executionId = randomUUID();
  const birthToken = "Tue Aug 4 12:34:56 2026";
  const cleanupEvents = [];
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 5252;
      const fd3Stream = new EventEmitter();
      fd3Stream.write = () => {};
      fd3Stream.end = () => queueMicrotask(() => {
        const error = new Error("broken pipe");
        error.code = "EPIPE";
        fd3Stream.emit("error", error);
      });
      this.stdio = [null, null, null, fd3Stream];
    }
    unref() { cleanupEvents.push("unref"); }
    kill() { throw new Error("leader-only kill forbidden"); }
  }
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": { spawn: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    } },
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  }, { queueMicrotask });
  const runner = resolve(repoRoot, "scripts/visual-qa-runner.mjs");
  await assert.rejects(dispatch.launchVisualQaRunner(executionId, randomBytes(32).toString("base64url"), {
    readIdentity: async () => `5252 5252 ${birthToken} ${process.execPath} ${runner} ${executionId}`,
    terminate: async (identity, id) => {
      cleanupEvents.push([identity.pid, identity.birth_token, id]);
      return true;
    },
  }), /qa_spawn_failed/);
  assert.deepEqual(cleanupEvents, [[5252, birthToken, executionId]],
    "post-spawn failure must not escape until verified group cleanup completes");
});

test("dispatch uses the extracted QA claim invariant and hashes only the child-bound capability", async () => {
  const sourceClaim = readFileSync(resolve(repoRoot, "src/app/api/qa/claim/route.ts"), "utf8");
  const sourceDispatch = readFileSync(resolve(repoRoot, "src/lib/qa/dispatch.ts"), "utf8");
  assert.match(sourceClaim, /claimQaWorkItem/);
  assert.match(sourceDispatch, /claimQaWorkItem/);

  const executionId = randomUUID();
  const capability = randomBytes(32).toString("base64url");
  let committed = false;
  let launchedToken;
  let claimOptions;
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": {
      claimQaWorkItem: async (workItemId, options) => {
        claimOptions = options;
        assert.match(workItemId, /^[0-9a-f-]{36}$/i);
        await options.withTransaction(async () => undefined);
        return {
          alreadyRunning: false,
          execution_id: executionId,
          qa_run_id: randomUUID(),
          task_id: randomUUID(),
          work_item_id: workItemId,
          execution_attempt_id: randomUUID(),
          target_sha: "a".repeat(40),
          policy_hash: "b".repeat(64),
          qa_session_id: "20260803_120000_a1b2c3",
          capability,
          capability_expires_at: new Date(Date.now() + 90 * 60_000).toISOString(),
        };
      },
    },
    "@/lib/qa/execution": { lockQaExecution: async () => null, failQaExecution: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  });
  const client = {
    async query(sql) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select attach_visual_qa_execution_pid")) {
        return { rowCount: 1, rows: [{ status: "running" }] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  const result = await dispatch.dispatchQa(randomUUID(), {
    withTransaction: async (run) => {
      const value = await run(client);
      committed = true;
      return value;
    },
    launch: async (_id, token) => {
      assert.equal(committed, true);
      launchedToken = token;
      return { pid: 6161, birth_token: "Tue Aug 4 12:34:56 2026" };
    },
  });
  assert.equal(result.status, "running");
  assert.equal(result.execution_id, executionId);
  assert.equal(result.capability, undefined);
  assert.equal(launchedToken, capability);
  assert.equal(claimOptions.allowAlreadyRunning, true);
  assert.equal(createHash("sha256").update(launchedToken).digest("hex").length, 64);

  committed = false;
  await assert.rejects(dispatch.dispatchQa(randomUUID(), {
    withTransaction: async (run) => {
      const value = await run(client);
      committed = true;
      return value;
    },
    launch: async () => { throw new Error("postgres://admin:***@127.0.0.1/db"); },
  }), (error) => error?.message === "qa_spawn_failed"
    && !JSON.stringify(error).includes("secret"));

  let cleanupFailureTransactions = 0;
  await assert.rejects(dispatch.dispatchQa(randomUUID(), {
    withTransaction: async (run) => {
      cleanupFailureTransactions += 1;
      return run(client);
    },
    launch: async () => { throw new Error("qa_runner_cleanup_failed"); },
  }), (error) => error?.message === "qa_runner_cleanup_failed");
  assert.equal(cleanupFailureTransactions, 1,
    "unverified post-spawn cleanup must retain running authority instead of entering failLaunch");
});

test("dispatch cleanup signals the detached runner process group and ignores unsafe PIDs", async () => {
  const capability = randomBytes(32).toString("base64url");
  const executionId = randomUUID();
  async function runCase(pid, terminate) {
    const kills = [];
    let killed = false;
    let failed = false;
    const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
      "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
      "node:path": { isAbsolute, resolve },
      "@/lib/qa/claim": {
        claimQaWorkItem: async () => ({
          alreadyRunning: false,
          execution_id: executionId,
          qa_run_id: randomUUID(),
          task_id: randomUUID(),
          work_item_id: randomUUID(),
          execution_attempt_id: randomUUID(),
          target_sha: "a".repeat(40),
          policy_hash: "b".repeat(64),
          qa_session_id: "20260803_120000_a1b2c3",
          capability,
          capability_expires_at: new Date(Date.now() + 90 * 60_000).toISOString(),
        }),
      },
      "@/lib/qa/execution": {
        lockQaExecution: async () => null,
        applyQaResult: async () => { failed = true; },
      },
      "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
    }, {
      process: { ...process, env: process.env, cwd: process.cwd.bind(process), execPath: process.execPath,
        kill: (target, signal) => {
          if (signal === 0 && killed) {
            const error = new Error("gone");
            error.code = "ESRCH";
            throw error;
          }
          kills.push([target, signal]);
          if (signal === "SIGKILL") killed = true;
        } },
    });
    assert.equal(dispatch.qaRunnerProcessGroupAlive(0), false);
    assert.equal(dispatch.qaRunnerProcessGroupAlive(-1), false);
    await assert.rejects(dispatch.dispatchQa(randomUUID(), {
      withTransaction: async (run) => run({
        query: async () => { throw new Error("pid_persist_failure postgres://admin:secret@127.0.0.1/db"); },
      }),
      launch: async () => ({ pid, birth_token: "Tue Aug 4 12:34:56 2026" }),
      terminate: terminate || ((identity, id) => dispatch.terminateQaRunnerProcessGroup(identity, id, {
        verify: async () => true, termWaitMs: 1, killWaitMs: 5, pollIntervalMs: 1,
      })),
    }), (error) => error?.message === (terminate ? "qa_runner_cleanup_failed" : "qa_pid_persistence_failed"));
    assert.equal(failed, false);
    return kills;
  }

  const cleanupCalls = await runCase(4242);
  assert.ok(cleanupCalls.some(([target, signal]) => target === -4242 && signal === "SIGTERM"));
  assert.ok(cleanupCalls.some(([target, signal]) => target === -4242 && signal === "SIGKILL"));
  assert.deepEqual(await runCase(4242, async () => {
    throw new Error("cleanup failed postgres://admin:secret@127.0.0.1/db");
  }), []);
});

test("lockQaExecution locks execution and related authority rows in a consistent order", async () => {
  const statements = [];
  const execution = transpileModule(resolve(repoRoot, "src/lib/qa/execution.ts"), {
    "node:crypto": { randomUUID },
  });
  await execution.lockQaExecution({
    query: async (sql) => {
      statements.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
      return statements.length === 1 ? { rows: [{ locked: true }] } : { rows: [] };
    },
  }, randomUUID());
  assert.match(statements[0], /^select lock_visual_qa_execution\(\$1\) locked$/);
  assert.match(statements[1], /for update of qr,wi,t,l$/);
});

test("dispatch process-group cleanup waits boundedly and throws when SIGKILL cannot stop the runner", async () => {
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  }, { setTimeout, clearTimeout });

  const calls = [];
  let killed = false;
  const killEventuallyExits = (target, signal) => {
    if (signal === 0 && killed) {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
    calls.push([target, signal]);
    if (signal === "SIGKILL") killed = true;
    return true;
  };
  const executionId = randomUUID();
  const birthToken = "Tue Aug 4 12:34:56 2026";
  assert.equal(await dispatch.terminateQaRunnerProcessGroup({ pid: 5151, birth_token: birthToken }, executionId, {
    verify: async () => true,
    kill: killEventuallyExits,
    termWaitMs: 1,
    killWaitMs: 5,
    pollIntervalMs: 1,
  }), true);
  assert.ok(calls.some(([target, signal]) => target === -5151 && signal === "SIGTERM"));
  assert.ok(calls.some(([target, signal]) => target === -5151 && signal === "SIGKILL"));

  await assert.rejects(dispatch.terminateQaRunnerProcessGroup({ pid: 6161, birth_token: birthToken }, executionId, {
    verify: async () => true,
    kill: () => true,
    termWaitMs: 1,
    killWaitMs: 1,
    pollIntervalMs: 1,
  }), /visual_qa_runner_process_group_alive_after_sigkill/);

  const runner = resolve(repoRoot, "scripts/visual-qa-runner.mjs");
  const psBirthToken = "Tue Aug  4 12:34:56 2026";
  const identity = { pid: 7171, birth_token: psBirthToken };
  const exactSnapshot = `7171 7171 ${psBirthToken} ${process.execPath} ${runner} ${executionId}`;
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    identity, executionId, async () => exactSnapshot), true);
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    { ...identity, birth_token: "Tue Aug  4 12:34:55 2026" }, executionId, async () => exactSnapshot), false);
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    identity, executionId, async () => `${exactSnapshot} --unexpected`), false);
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    identity, executionId, async () => exactSnapshot.replace(process.execPath, "/tmp/node")), false);
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    identity, executionId, async () => { throw new Error("probe unavailable"); }), false);
  assert.equal(await dispatch.verifyQaRunnerProcessIdentity(
    { pid: 0, birth_token: birthToken }, executionId, async () => exactSnapshot), false);
});

test("process-group termination revalidates the persisted identity immediately before TERM and KILL", async () => {
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  }, { setTimeout, clearTimeout });
  const executionId = randomUUID();
  const identity = { pid: 8181, birth_token: "Tue Aug 4 12:34:56 2026" };
  const events = [];
  let killed = false;
  const verify = async (candidate, candidateExecutionId) => {
    events.push("verify");
    return candidate.pid === identity.pid && candidate.birth_token === identity.birth_token
      && candidateExecutionId === executionId;
  };
  const kill = (_target, signal) => {
    if (signal === 0 && killed) {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    }
    if (signal === "SIGTERM" || signal === "SIGKILL") events.push(signal);
    if (signal === "SIGKILL") killed = true;
  };
  assert.equal(await dispatch.terminateQaRunnerProcessGroup(identity, executionId, {
    verify, kill, termWaitMs: 1, killWaitMs: 5, pollIntervalMs: 1,
  }), true);
  assert.deepEqual(events, ["verify", "SIGTERM", "verify", "SIGKILL"]);

  const refusedSignals = [];
  await assert.rejects(dispatch.terminateQaRunnerProcessGroup(identity, executionId, {
    verify: async () => false,
    kill: (_target, signal) => { if (signal !== 0) refusedSignals.push(signal); },
    termWaitMs: 1, killWaitMs: 1, pollIntervalMs: 1,
  }), /identity/);
  assert.deepEqual(refusedSignals, [], "identity probe failure must fail closed without a signal");
});

test("stale reconciliation cleans the verified runner group before terminal authority and fails closed on cleanup error", async () => {
  const executionId = randomUUID();
  let terminalWrites = 0;
  const route = transpileModule(resolve(repoRoot, "src/app/api/qa/reconcile/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": {
      query: async () => ({ rows: [{ id: executionId }] }),
      withTransaction: async (run) => run({
        query: async () => { terminalWrites += 1; return { rows: [] }; },
      }),
    },
    "@/lib/qa/execution": {
      lockQaExecution: async () => ({
        id: executionId,
        status: "running",
        heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        pid: 4242,
        runner_birth_token: "Tue Aug 4 12:34:56 2026",
      }),
      failQaExecution: async () => { terminalWrites += 1; },
    },
    "@/lib/qa/dispatch": {
      qaRunnerProcessGroupAlive: () => true,
      verifyQaRunnerProcessIdentity: async () => true,
      terminateQaRunnerProcessGroup: async () => {
        throw new Error("postgres://admin:secret@127.0.0.1/db");
      },
    },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "reconcile-key";
  try {
    const result = await route.POST({ headers: { get: () => "Bearer reconcile-key" } });
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), {
      reconciled: 0,
      execution_ids: [],
      cleanup_failed: 1,
      cleanup_failed_execution_ids: [executionId],
    });
    assert.equal(terminalWrites, 0, "cleanup failure must retain running authority for a later safe retry");
    assert.doesNotMatch(JSON.stringify(result.payload), /secret|postgres:/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = previous;
  }
});

test("stale reconciliation rolls back failQaExecution when reconcile authority returns false", async () => {
  const executionId = randomUUID();
  let committedTerminalWrites = 0;
  const route = transpileModule(resolve(repoRoot, "src/app/api/qa/reconcile/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": {
      query: async () => ({ rows: [{ id: executionId }] }),
      withTransaction: async (run) => {
        let pendingTerminalWrites = 0;
        const client = {
          query: async () => ({ rows: [{ reconciled: false }] }),
          recordTerminalWrite: () => { pendingTerminalWrites += 1; },
        };
        try {
          const value = await run(client);
          committedTerminalWrites += pendingTerminalWrites;
          return value;
        } catch (error) {
          throw error;
        }
      },
    },
    "@/lib/qa/execution": {
      lockQaExecution: async () => ({
        id: executionId,
        status: "running",
        heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        pid: 4242,
        runner_birth_token: "Tue Aug 4 12:34:56 2026",
      }),
      failQaExecution: async (client) => { client.recordTerminalWrite(); },
    },
    "@/lib/qa/dispatch": {
      qaRunnerProcessGroupAlive: () => false,
      verifyQaRunnerProcessIdentity: async () => true,
      terminateQaRunnerProcessGroup: async () => true,
    },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "reconcile-key";
  try {
    const result = await route.POST({ headers: { get: () => "Bearer reconcile-key" } });
    assert.equal(result.status, 503);
    assert.equal(result.payload.cleanup_failed, 1);
    assert.equal(committedTerminalWrites, 0, "failed reconcile authority must roll back failQaExecution");
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = previous;
  }
});

test("stale reconciliation terminates a real runner process group and its non-detached descendant before terminal write", async () => {
  const executionId = randomUUID();
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/qa/dispatch.ts"), {
    "node:child_process": await import("node:child_process"),
    "node:path": { isAbsolute, resolve },
    "@/lib/qa/claim": { claimQaWorkItem: async () => { throw new Error("unused"); } },
    "@/lib/qa/execution": { lockQaExecution: async () => null, applyQaResult: async () => {} },
    "@/lib/qa/result": { hashQaResult: () => "a".repeat(64) },
  });
  const runner = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid) + "\\n");
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const descendantPid = await new Promise((resolvePid, rejectPid) => {
    const timer = setTimeout(() => rejectPid(new Error("descendant_pid_timeout")), 2_000);
    runner.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolvePid(Number(String(chunk).trim()));
    });
    runner.once("error", rejectPid);
  });
  let terminalWrites = 0;
  const route = transpileModule(resolve(repoRoot, "src/app/api/qa/reconcile/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": {
      query: async () => ({ rows: [{ id: executionId }] }),
      withTransaction: async (run) => run({
        query: async () => ({ rows: [{ reconciled: true }] }),
      }),
    },
    "@/lib/qa/execution": {
      lockQaExecution: async () => ({
        id: executionId,
        status: "running",
        heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        pid: runner.pid,
        runner_birth_token: "Tue Aug 4 12:34:56 2026",
      }),
      failQaExecution: async () => { terminalWrites += 1; },
    },
    "@/lib/qa/dispatch": {
      qaRunnerProcessGroupAlive: dispatch.qaRunnerProcessGroupAlive,
      verifyQaRunnerProcessIdentity: async () => true,
      terminateQaRunnerProcessGroup: (identity, id) => dispatch.terminateQaRunnerProcessGroup(identity, id, {
        verify: async () => true,
        termWaitMs: 2_000, killWaitMs: 2_000, pollIntervalMs: 10,
      }),
    },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "reconcile-key";
  try {
    const result = await route.POST({ headers: { get: () => "Bearer reconcile-key" } });
    assert.equal(result.status, 200);
    assert.equal(result.payload.reconciled, 1);
    assert.equal(terminalWrites, 1);
    for (const pid of [runner.pid, descendantPid]) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = previous;
    try { process.kill(-runner.pid, "SIGKILL"); } catch {}
  }
});
