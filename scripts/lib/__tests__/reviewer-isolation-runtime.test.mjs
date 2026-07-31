import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import {
  assertWriteDenied,
  buildPackage,
  cleanChildEnv,
  generateSandboxPolicy,
  parseHermesOutput,
  parseReviewerResult,
  verifyHermesSession,
} from "../reviewer-runtime.mjs";
import {
  MAX_HERMES_REVIEW_MS,
  REVIEW_CAPABILITY_TTL_MS,
  REVIEW_PACKAGE_PREPARATION_BUDGET_MS,
  REVIEW_STATE_AND_HTTP_MARGIN_MS,
} from "../reviewer-contract.mjs";
import { REVIEWER_DISPATCH_CONTRACT } from "./fixtures/reviewer-dispatch-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };
const reviewerTimingContract = { REVIEW_CAPABILITY_TTL_MS };

test("capability TTL covers package preparation, full Hermes timeout and completion margin", () => {
  assert.ok(REVIEW_CAPABILITY_TTL_MS >= REVIEW_PACKAGE_PREPARATION_BUDGET_MS
    + MAX_HERMES_REVIEW_MS + REVIEW_STATE_AND_HTTP_MARGIN_MS);
});

test("dispatch route emits the scheduler closed union for running, fast success, duplicate, and claimed failure", async () => {
  const { cases } = REVIEWER_DISPATCH_CONTRACT;
  let result;
  const route = transpileModule(resolve(repoRoot, "src/app/api/reviewer/dispatch/route.ts"), {
    "next/server": nextServer,
    "@/lib/db/postgres": { withTransaction: async () => { throw new Error("unused"); } },
    "@/lib/reviewer/dispatch": { dispatchReviewer: async () => result },
  });
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "test-key";
  const request = { headers: { get: (name) => name === "authorization" ? "Bearer test-key" : null },
    json: async () => ({ work_item_id: randomUUID() }) };
  const plain = (response) => JSON.parse(JSON.stringify(response.payload));
  try {
    for (const contractCase of [cases.running, cases.fastSucceeded, cases.duplicate, cases.claimedTerminal]) {
      result = contractCase.result;
      const response = await route.POST(request);
      assert.equal(response.status, contractCase.status);
      assert.deepEqual(plain(response), contractCase.body);
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = previous;
  }
});

test("real route and dispatch preserve claim certainty for spawn/PID failures and known pre-claim rejection", async () => {
  const { executionId, cases } = REVIEWER_DISPATCH_CONTRACT;
  const previous = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "dispatch-contract-key";
  try {
    for (const [mode, contractCase] of [
      ["spawn", cases.postClaimSpawn],
      ["pid", cases.postClaimPid],
      ["preclaim-invalid", cases.preClaimRejection],
      ["preclaim-relation", cases.preClaimRelation],
      ["preclaim-identity", cases.preClaimIdentity],
      ["preclaim-state", cases.preClaimState],
      ["ambiguous-commit", cases.ambiguousCommit],
    ]) {
      const workItemId = randomUUID();
      const executionAttemptId = randomUUID();
      const targetRunId = randomUUID();
      const targetSha = "c".repeat(40);
      const planRevisionId = randomUUID();
      const row = {
        loop_id: randomUUID(), loop_status: "in_progress", workflow_version: 2, approval_scope: {},
        plan_revision_id: planRevisionId, revision_status: "approved", plan_hash: "plan", plan_snapshot: {},
        stage_id: randomUUID(), task_id: randomUUID(),
        task_status: mode === "preclaim-state" ? "blocked" : "review_pending",
        task_key: "task", task_title: "Task",
        task_description: null, task_metadata: {}, work_item_id: workItemId, work_status: "ready",
        work_payload: { runtime_contract: "fresh_review_v1", run_role: "review", execution_attempt_id: executionAttemptId,
          target_run_id: targetRunId, target_sha: mode === "preclaim-identity" ? "e".repeat(40) : targetSha,
          plan_revision_id: planRevisionId, plan_hash: "plan" },
        review_run_id: randomUUID(), review_run_status: "queued", run_role: "review", quality_cycle: 1,
        execution_attempt_id: executionAttemptId, target_run_id: targetRunId, target_sha: targetSha,
        base_sha: "d".repeat(40), repository_id: randomUUID(), implementation_status: "succeeded",
        implementation_role: "implementation", implementation_sha: targetSha, implementer_session_id: "implementer",
        review_id: randomUUID(), review_status: "pending", reviewed_sha: targetSha,
        repository_key: "repo", canonical_root: repoRoot, git_common_dir: resolve(repoRoot, ".git"), object_format: "sha1",
        repository_enabled: true, max_diff_bytes: 1000, max_package_bytes: 2000,
      };
      let insertedExecutionId;
      let closedLaunches = 0;
      let transactions = 0;
      const client = { async query(sql, params = []) {
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.startsWith("select l.id")) return { rows: mode === "preclaim-relation" ? [] : [row] };
        if (normalized.startsWith("update work_items")) return { rowCount: 1, rows: [{ id: workItemId }] };
        if (normalized.startsWith("update loop_task_runs")) return { rowCount: 1, rows: [{ id: row.review_run_id }] };
        if (normalized.startsWith("insert into reviewer_executions")) {
          insertedExecutionId = params[0];
          return { rowCount: 1, rows: [] };
        }
        if (normalized.startsWith("update reviewer_executions set pid")) throw new Error("pid_test_failure");
        if (normalized.startsWith("update reviewer_executions set status='failed'")) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected query: ${normalized}`);
      } };
      const withTransaction = async (run) => {
        transactions += 1;
        const value = await run(client);
        if (mode === "ambiguous-commit" && transactions === 1) throw new Error("ambiguous_commit_outcome");
        return value;
      };
      const dispatch = transpileModule(resolve(repoRoot, "src/lib/reviewer/dispatch.ts"), {
        "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
        "node:crypto": { createHash, randomBytes, randomUUID: () => executionId }, "node:path": { resolve },
        "@/lib/reviewer/package": { buildReviewerPackage: async () => ({ sha256: REVIEWER_DISPATCH_CONTRACT.packageSha256 }) },
        "@/lib/reviewer/execution-context": { lockReviewerExecution: async () => ({ id: executionId, status: "running" }) },
        "@/lib/reviewer/review-completion": { failReviewerExecution: async () => { closedLaunches += 1; } },
        "../../../scripts/lib/reviewer-contract.mjs": reviewerTimingContract,
      });
      const dispatchReviewer = (id, dependencies) => dispatch.dispatchReviewer(id, {
        ...dependencies,
        launch: mode === "spawn" ? async () => { throw new Error("spawn_test_failure"); } : async () => 4242,
        terminate: () => {},
      });
      const route = transpileModule(resolve(repoRoot, "src/app/api/reviewer/dispatch/route.ts"), {
        "next/server": nextServer,
        "@/lib/db/postgres": { withTransaction },
        "@/lib/reviewer/dispatch": { ...dispatch, dispatchReviewer },
      });
      const request = {
        headers: { get: (name) => name === "authorization" ? "Bearer dispatch-contract-key" : null },
        json: async () => ({ work_item_id: mode === "preclaim-invalid" ? "not-a-uuid" : workItemId }),
      };
      const response = await route.POST(request);
      assert.equal(response.status, contractCase.status, mode);
      assert.deepEqual(JSON.parse(JSON.stringify(response.payload)), contractCase.body, mode);
      if (mode === "ambiguous-commit") {
        assert.equal(transactions, 1);
        assert.equal(insertedExecutionId, executionId);
        assert.equal(closedLaunches, 0);
      } else if (mode.startsWith("preclaim")) {
        assert.equal(transactions, mode === "preclaim-invalid" ? 0 : 1);
        assert.equal(insertedExecutionId, undefined);
        assert.equal(closedLaunches, 0);
      } else {
        assert.equal(insertedExecutionId, executionId);
        assert.equal(closedLaunches, 1);
        assert.ok(transactions >= 2);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = previous;
  }
});

function transpileModule(sourcePath, requires = {}, globals = {}) {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule, exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Buffer, Date, Number, Set, Map, JSON, String, RegExp, Object, Array, Math, Promise, Error, console,
    process, setTimeout, clearTimeout, ...globals,
  }, { filename: sourcePath });
  return cjsModule.exports;
}

const sourceReviewer = transpileModule(resolve(repoRoot, "src/lib/reviewer/package.ts"), {
  "node:crypto": { createHash },
  "@/lib/work-items/git-artifact": {},
});
const reviewerResultParsers = [
  ["detached runtime", parseReviewerResult],
  ["application", sourceReviewer.parseReviewerResult],
];

const validApproved = JSON.stringify({ verdict: "approved", feedback: null, findings: [] });
const usefulFinding = {
  severity: "major",
  title: "Missing rollback coverage",
  evidence: "The changed path has no rollback assertion.",
  recommendation: "Add a focused rollback assertion.",
};

function capabilityRequest(token, body) {
  return {
    headers: { get: (name) => name === "authorization" ? `ReviewCapability ${token}` : null },
    json: async () => body,
  };
}

test("reviewer accepts the observed approved result with empty feedback", () => {
  const observedResult = '{"verdict":"approved","feedback":"","findings":[]}';
  assert.deepEqual(parseReviewerResult(observedResult), { verdict: "approved", feedback: null, findings: [] });
});

test("reviewer feedback verdict matrix is consistent across runtime parsers", () => {
  const accepted = [
    ["approved null", { verdict: "approved", feedback: null, findings: [] }, null],
    ["approved empty", { verdict: "approved", feedback: "", findings: [] }, null],
    ["approved whitespace", { verdict: "approved", feedback: " \n\t ", findings: [] }, null],
    ["approved substantive", { verdict: "approved", feedback: " Looks good. ", findings: [] }, "Looks good."],
    ["changes_requested substantive", {
      verdict: "changes_requested", feedback: " Please add coverage. ", findings: [usefulFinding],
    }, "Please add coverage."],
  ];
  const rejected = [
    ["changes_requested empty", { verdict: "changes_requested", feedback: "", findings: [usefulFinding] }],
    ["changes_requested whitespace", { verdict: "changes_requested", feedback: " \n\t ", findings: [usefulFinding] }],
  ];
  for (const [parserName, parse] of reviewerResultParsers) {
    for (const [caseName, input, feedback] of accepted) {
      const result = JSON.parse(JSON.stringify(parse(JSON.stringify(input))));
      assert.deepEqual(result, { verdict: input.verdict, feedback, findings: input.findings }, `${parserName}: ${caseName}`);
    }
    for (const [caseName, input] of rejected) {
      assert.throws(() => parse(JSON.stringify(input)), /reviewer_changes_require_feedback_and_finding/, `${parserName}: ${caseName}`);
    }
  }
});

test("reviewer result parsing is strict JSON with exact schemas and no repair", () => {
  assert.deepEqual(parseReviewerResult(validApproved), { verdict: "approved", feedback: null, findings: [] });
  for (const [text, error] of [
    ["prefix " + validApproved, /reviewer_stdout_invalid_json/],
    [JSON.stringify({ verdict: "approved", feedback: null, findings: [], extra: true }), /reviewer_result_invalid/],
    [JSON.stringify({ verdict: "approved", feedback: null, findings: [{ ...usefulFinding, extra: true }] }), /reviewer_finding_invalid/],
    [JSON.stringify({ verdict: "approved", feedback: null, findings: [usefulFinding] }), /reviewer_approval_has_blocking_findings/],
    [JSON.stringify({ verdict: "changes_requested", feedback: null, findings: [usefulFinding] }), /reviewer_changes_require_feedback_and_finding/],
    [JSON.stringify({ verdict: "changes_requested", feedback: "Please add coverage.", findings: [] }), /reviewer_changes_require_feedback_and_finding/],
    [JSON.stringify({ verdict: "unknown", feedback: null, findings: [] }), /reviewer_verdict_invalid/],
    [JSON.stringify({ verdict: "approved", findings: [] }), /reviewer_result_invalid/],
    [JSON.stringify({ verdict: "approved", feedback: 1, findings: [] }), /reviewer_feedback_invalid/],
    [JSON.stringify({ verdict: "approved", feedback: "x".repeat(20_001), findings: [] }), /reviewer_feedback_invalid/],
  ]) assert.throws(() => parseReviewerResult(text), error);
});

test("Hermes output contains strict JSON on stdout and exactly one anchored session id on stderr", () => {
  const sessionId = "20260729_123456_a1b2c3";
  assert.deepEqual(parseHermesOutput(validApproved, `session_id: ${sessionId}\n`), {
    sessionId, result: { verdict: "approved", feedback: null, findings: [] },
  });
  assert.throws(() => parseHermesOutput(validApproved, ""), /reviewer_session_id_cardinality/);
  assert.throws(() => parseHermesOutput(validApproved, `session_id: ${sessionId}\nsession_id: ${sessionId}\n`), /reviewer_session_id_cardinality/);
  assert.throws(() => parseHermesOutput(validApproved, `log ${sessionId}\n`), /reviewer_session_id_cardinality/);
  assert.throws(() => parseHermesOutput(`session_id: ${sessionId}\n${validApproved}`, `session_id: ${sessionId}\n`), /reviewer_stdout_invalid_json/);
});

test("state.db verification pins dedicated source evidence, exact model, one turn and bounded start time", async () => {
  const sessionId = "20260729_123456_a1b2c3";
  const base = { id: sessionId, source: "mission-control-reviewer", started_at: 105,
    model: "gpt-5.6-sol", model_config: JSON.stringify({ max_iterations: 1 }) };
  const invoke = (row) => verifyHermesSession("/fake/state.db", sessionId, 100, 110, "gpt-5.6-sol",
    async (file, args) => {
      assert.equal(file, "/usr/bin/sqlite3");
      assert.deepEqual(args.slice(0, 2), ["-json", "/fake/state.db"]);
      return { stdout: JSON.stringify([row]), stderr: "" };
    });
  await invoke(base);
  await invoke({ ...base, source: "cli" });
  await assert.rejects(invoke({ ...base, source: "chat" }), /reviewer_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, model: "other" }), /reviewer_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, model_config: JSON.stringify({ max_iterations: 2 }) }), /reviewer_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, started_at: "not-a-time" }), /reviewer_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, started_at: 500 }), /reviewer_state_db_session_mismatch/);
});

test("child environment is allowlisted and excludes process or caller secrets", () => {
  const old = process.env.SUPER_SECRET_API_KEY;
  process.env.SUPER_SECRET_API_KEY = "must-not-leak";
  try {
    const env = cleanChildEnv({ API_TOKEN: "also-must-not-leak", GIT_NO_REPLACE_OBJECTS: "1", MALICIOUS: "x" });
    assert.equal(env.SUPER_SECRET_API_KEY, undefined);
    assert.equal(env.API_TOKEN, undefined);
    assert.equal(env.MALICIOUS, undefined);
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.deepEqual(Object.keys(env).sort(), ["GIT_NO_REPLACE_OBJECTS", "HOME", "LANG", "PATH", "TMPDIR"]);
  } finally {
    if (old === undefined) delete process.env.SUPER_SECRET_API_KEY; else process.env.SUPER_SECRET_API_KEY = old;
  }
});

test("sandbox policy preserves provider network while denying repository and external common-dir writes; probe is fail-closed", async () => {
  const policy = generateSandboxPolicy('/repo/with"quote', "/tmp/worktree", "/external/git/common");
  assert.match(policy, /\(allow default\)/);
  assert.doesNotMatch(policy, /deny network/);
  assert.match(policy, /deny file-write\*/);
  assert.match(policy, /with\\"quote/);
  assert.match(policy, /external\/git\/common/);
  await assertWriteDenied(policy, "/repo", async () => ({ stdout: "WRITE_DENIED\n", stderr: "" }));
  await assert.rejects(assertWriteDenied(policy, "/repo", async () => ({ stdout: "WRITE_ALLOWED\n", stderr: "" })),
    /reviewer_sandbox_write_probe_unexpectedly_succeeded/);
  await assert.rejects(assertWriteDenied(policy, "/repo", async () => { throw new Error("sandbox unavailable"); }),
    /sandbox unavailable/);
  await assert.rejects(assertWriteDenied(policy, "/repo", async () => ({ stdout: "", stderr: "" })),
    /reviewer_sandbox_write_probe_inconclusive/);
});

test("runtime package rejects secrets anywhere and package oversize", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-reviewer-package-"));
  try {
    execFileSync("git", ["init", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Reviewer Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "reviewer@test.invalid"]);
    await writeFile(resolve(root, "evidence.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-m", "base"]);
    const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(resolve(root, "evidence.txt"), "target\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-m", "target"]);
    const target = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const row = {
      id: randomUUID(), review_run_id: randomUUID(), work_item_id: randomUUID(), execution_attempt_id: randomUUID(),
      repository_key: "test", object_format: "sha1", canonical_root: root, base_sha: base, target_sha: target,
      plan_snapshot: { acceptance_criteria: ["clean"] }, approval_scope: {}, task_key: "task", task_title: "Task",
      task_description: "Clean", task_metadata: {}, max_diff_bytes: 1024 * 1024, max_package_bytes: 1024 * 1024,
    };
    const built = await buildPackage(row);
    assert.match(built.json, /target/);
    await assert.rejects(buildPackage({ ...row, approval_scope: { notes: "token='abcdefghijklmnop'" } }),
      /review_package_secret_detected:credential_assignment/);
    for (const secret of [
      "API_KEY=abcdefghijklmnop",
      'config={"client_secret":"abcdefghijklmnop"}',
      "DATABASE_URL=postgres://admin:abcdefghijklmnop@db.example.test/app",
      ["OPENAI", "API", "KEY"].join("_") + "=" + ["sk", "test", "abcdefghijklmnop"].join("-"),
      ["SLACK", "TOKEN"].join("_") + "=" + ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
      ["GITLAB", "TOKEN"].join("_") + "=" + ["glpat", "abcdefghijklmnop"].join("-"),
      ["NPM", "TOKEN"].join("_") + "=" + ["npm", "abcdefghijklmnop"].join("_"),
      ["GITHUB", "TOKEN"].join("_") + "=" + ["github", "pat", "abcdefghijklmnop"].join("_"),
    ]) {
      await assert.rejects(buildPackage({ ...row, approval_scope: { notes: secret } }),
        /review_package_secret_detected/, secret);
    }
    await assert.rejects(buildPackage({ ...row, max_package_bytes: 100 }),
      /review_package_oversize_manual_review_required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detached launcher passes only execution id in argv, allowlisted operational env, and capability only through FD 3", async () => {
  let spawnCall;
  let fd3 = "";
  const configured = {
    MISSION_CONTROL_DATABASE_URL: "postgres://reviewer@127.0.0.1/reviewer_test",
    HERMES_REVIEWER_BIN: "/safe/hermes-reviewer",
    HERMES_REVIEWER_PROFILE: "reviewer",
    HERMES_REVIEWER_MODEL: "review-model",
    HERMES_REVIEWER_PROVIDER: "review-provider",
    SUPER_SECRET_API_KEY: "must-not-propagate",
  };
  const previous = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4242;
      this.stdio = [null, null, null, {
        write() {},
        end(value) { fd3 += value; },
      }];
    }
    unref() { this.unreffed = true; }
    kill() { this.killed = true; }
  }
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/reviewer/dispatch.ts"), {
    "node:child_process": { spawn: (file, args, options) => {
      spawnCall = { file, args, options };
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child;
    } },
    "node:crypto": { createHash, randomBytes, randomUUID },
    "node:path": { resolve },
    "@/lib/reviewer/package": { buildReviewerPackage: async () => ({ sha256: "a".repeat(64) }) },
    "@/lib/reviewer/execution-context": { lockReviewerExecution: async () => null },
    "@/lib/reviewer/review-completion": { failReviewerExecution: async () => {} },
    "../../../scripts/lib/reviewer-contract.mjs": reviewerTimingContract,
  }, { queueMicrotask });
  const capability = randomBytes(32).toString("base64url");
  assert.equal(await dispatch.launchReviewerRunner(randomUUID(), capability), 4242);
  assert.equal(spawnCall.args.length, 2);
  assert.match(spawnCall.args[0], /scripts\/reviewer-runner\.mjs$/);
  assert.match(spawnCall.args[1], /^[0-9a-f-]{36}$/);
  assert.equal(spawnCall.args.includes(capability), false);
  assert.equal(Object.values(spawnCall.options.env).includes(capability), false);
  for (const key of ["MISSION_CONTROL_DATABASE_URL", "HERMES_REVIEWER_BIN", "HERMES_REVIEWER_PROFILE", "HERMES_REVIEWER_MODEL", "HERMES_REVIEWER_PROVIDER"]) {
    assert.equal(spawnCall.options.env[key], configured[key], key);
  }
  assert.equal(spawnCall.options.env.SUPER_SECRET_API_KEY, undefined);
  assert.deepEqual(Array.from(spawnCall.options.stdio), ["ignore", "ignore", "ignore", "pipe"]);
  assert.equal(fd3, capability);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("bounded child heartbeats periodically and stops the timer after completion", async () => {
  let heartbeats = 0;
  const { runBounded } = await import("../reviewer-runtime.mjs");
  const result = await runBounded(process.execPath, ["-e", "setTimeout(() => process.stdout.write('ok'), 45)"], {
    heartbeat: async () => { heartbeats += 1; },
    heartbeatIntervalMs: 10,
    timeoutMs: 2_000,
  });
  assert.equal(result.stdout, "ok");
  assert.ok(heartbeats >= 2);
  const stoppedAt = heartbeats;
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(heartbeats, stoppedAt);
});

test("dispatch hashes a random capability and launches only after DB state is durable", async () => {
  const packageSha = "b".repeat(64);
  const executionAttemptId = randomUUID();
  const targetRunId = randomUUID();
  const targetSha = "c".repeat(40);
  const planRevisionId = randomUUID();
  const row = {
    loop_id: randomUUID(), loop_status: "in_progress", workflow_version: 2, approval_scope: {},
    plan_revision_id: planRevisionId, revision_status: "approved", plan_hash: "plan", plan_snapshot: {},
    stage_id: randomUUID(), task_id: randomUUID(), task_status: "review_pending", task_key: "task", task_title: "Task",
    task_description: null, task_metadata: {}, work_item_id: randomUUID(), work_status: "ready",
    work_payload: { runtime_contract: "fresh_review_v1", run_role: "review", execution_attempt_id: executionAttemptId,
      target_run_id: targetRunId, target_sha: targetSha, plan_revision_id: planRevisionId, plan_hash: "plan" },
    review_run_id: randomUUID(), review_run_status: "queued", run_role: "review", quality_cycle: 1,
    execution_attempt_id: executionAttemptId, target_run_id: targetRunId, target_sha: targetSha, base_sha: "d".repeat(40), repository_id: randomUUID(),
    implementation_status: "succeeded", implementation_role: "implementation", implementation_sha: targetSha,
    implementer_session_id: "implementer", review_id: randomUUID(), review_status: "pending", reviewed_sha: targetSha,
    repository_key: "repo", canonical_root: repoRoot, git_common_dir: resolve(repoRoot, ".git"), object_format: "sha1",
    repository_enabled: true, max_diff_bytes: 1000, max_package_bytes: 2000,
  };
  let insertedHash;
  let committed = false;
  let launcherToken;
  let fastTerminal = false;
  const client = { async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select l.id")) return { rows: [row] };
    if (normalized.startsWith("update work_items")) return { rowCount: 1, rows: [{ id: row.work_item_id }] };
    if (normalized.startsWith("update loop_task_runs")) return { rowCount: 1, rows: [{ id: row.review_run_id }] };
    if (normalized.startsWith("insert into reviewer_executions")) { insertedHash = params[8]; return { rowCount: 1, rows: [] }; }
    if (normalized.startsWith("update reviewer_executions set pid")) return fastTerminal
      ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: params[0] }] };
    if (normalized.startsWith("select status,pid from reviewer_executions")) return { rowCount: 1, rows: [{ status: "succeeded", pid: null }] };
    throw new Error(`unexpected query: ${normalized}`);
  } };
  const dispatch = transpileModule(resolve(repoRoot, "src/lib/reviewer/dispatch.ts"), {
    "node:child_process": { spawn() { throw new Error("real spawn forbidden"); } },
    "node:crypto": { createHash, randomBytes, randomUUID }, "node:path": { resolve },
    "@/lib/reviewer/package": { buildReviewerPackage: async () => ({ sha256: packageSha }) },
    "@/lib/reviewer/execution-context": { lockReviewerExecution: async () => null },
    "@/lib/reviewer/review-completion": { failReviewerExecution: async () => {} },
    "../../../scripts/lib/reviewer-contract.mjs": reviewerTimingContract,
  });
  const result = await dispatch.dispatchReviewer(row.work_item_id, {
    withTransaction: async (run) => { const value = await run(client); committed = true; return value; },
    launch: async (_id, token) => { assert.equal(committed, true); launcherToken = token; return 77; },
  });
  assert.equal(result.package_sha256, packageSha);
  assert.match(launcherToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(insertedHash).toString("hex"), createHash("sha256").update(launcherToken).digest("hex"));
  assert.notEqual(Buffer.from(insertedHash).toString("utf8"), launcherToken);

  fastTerminal = true;
  const fastResult = await dispatch.dispatchReviewer(row.work_item_id, {
    withTransaction: async (run) => run(client),
    launch: async () => 78,
    terminate: () => { throw new Error("legitimately completed child must not be terminated"); },
  });
  assert.equal(fastResult.status, "succeeded");
});

test("completion route rejects wrong, expired, replayed and binding/session mismatches before apply", async () => {
  const goodToken = randomBytes(32).toString("base64url");
  const execution = {
    id: randomUUID(), status: "running", capability_hash: createHash("sha256").update(goodToken).digest(),
    capability_expires_at: new Date(Date.now() + 60_000), capability_consumed_at: null, capability_revoked_at: null,
    package_sha256: "a".repeat(64), execution_attempt_id: randomUUID(), reviewer_session_id: null,
  };
  let applies = 0;
  const route = transpileModule(resolve(repoRoot, "src/app/api/reviewer/executions/[id]/complete/route.ts"), {
    "node:crypto": { createHash, timingSafeEqual: (a, b) => Buffer.from(a).equals(Buffer.from(b)) },
    "next/server": nextServer,
    "@/lib/db/postgres": { withTransaction: async (run) => run({ query: async () => ({ rowCount: 1, rows: [{ id: execution.id }] }) }) },
    "@/lib/reviewer/execution-context": { lockReviewerExecution: async () => execution },
    "@/lib/reviewer/package": { parseReviewerResult: (text) => parseReviewerResult(text) },
    "@/lib/reviewer/review-completion": { applyReviewerResult: async () => { applies += 1; return { effect: "approved" }; } },
  });
  const body = { session_id: "20260729_123456_a1b2c3", package_sha256: execution.package_sha256,
    execution_attempt_id: execution.execution_attempt_id, result: JSON.parse(validApproved) };
  const invoke = (token = goodToken, patch = {}) => route.POST(capabilityRequest(token, { ...body, ...patch }), { params: Promise.resolve({ id: execution.id }) });
  assert.equal((await invoke(randomBytes(32).toString("base64url"))).status, 401);
  assert.equal((await invoke(goodToken, { package_sha256: "b".repeat(64) })).status, 409);
  assert.equal((await invoke(goodToken, { execution_attempt_id: randomUUID() })).status, 409);
  execution.reviewer_session_id = "20260729_000000_abcdef";
  assert.equal((await invoke()).status, 409);
  execution.reviewer_session_id = null;
  execution.capability_expires_at = new Date(Date.now() - 1);
  assert.equal((await invoke()).status, 410);
  execution.capability_expires_at = new Date(Date.now() + 60_000);
  execution.capability_consumed_at = new Date();
  assert.equal((await invoke()).status, 409);
  assert.equal(applies, 0);
});

test("generic notifier rejects fresh review before any spawn", async () => {
  const oldApiKey = process.env.AGENT_API_KEY;
  process.env.AGENT_API_KEY = "test-key";
  let spawns = 0;
  try {
    const route = transpileModule(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), {
      "node:child_process": { spawn: () => { spawns += 1; throw new Error("spawn forbidden"); } },
      "node:crypto": { randomUUID }, "next/server": nextServer,
      "@supabase/supabase-js": { createClient: () => { throw new Error("cloud forbidden"); } },
      "@/lib/agent-routing": { AGENT_ROUTING: {}, isRoutedAgent: () => true },
      "@/lib/auth/local": { isLocalAuthDisabled: () => true },
      "@/lib/db/postgres": { query: async () => ({ rows: [{ id: randomUUID(), loop_id: randomUUID(), title: "review",
        status: "ready", owner_agent: "systems", target_agent_id: null, payload: { runtime_contract: "fresh_review_v1", run_role: "review" } }] }) },
      "@/lib/loops/execution-instruction": { buildLoopWakeContext: () => "" },
    "@/lib/work-items/generic-notify-contract": {
      isVisualQaLikeWorkItem: (row) => row?.payload?.runtime_contract === "visual_qa_v1" || row?.payload?.run_role === "qa",
      parseGenericNotifyClassificationIdentity: () => null,
      genericNotifyIdentityMatches: () => true,
    },
    }, { fetch: async () => { throw new Error("network forbidden"); } });
    const response = await route.POST({ headers: { get: () => "Bearer test-key" }, json: async () => ({ work_item_id: randomUUID(), agent: "systems" }) });
    assert.equal(response.status, 409);
    assert.match(response.payload.error, /dedicated reviewer dispatch/);
    assert.equal(spawns, 0);
  } finally {
    if (oldApiKey === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = oldApiKey;
  }
});

test("generic requeue rejects fresh review before mutation", async () => {
  let writes = 0;
  const route = transpileModule(resolve(repoRoot, "src/app/api/work-items/[id]/requeue/route.ts"), {
    "next/server": nextServer,
    "@/lib/supabase/admin": { supabaseAdmin: new Proxy({}, { get() { throw new Error("cloud forbidden"); } }) },
    "@/lib/auth/local": { isLocalAuthDisabled: () => true },
    "@/lib/db/mission-control": { normalizeRow: (row) => row },
    "@/lib/db/postgres": { withTransaction: async (run) => run({
      query: async (sql) => {
        if (/^\s*select/i.test(sql)) return { rows: [{ id: randomUUID(), title: "review", status: "in_progress",
          payload: { runtime_contract: "fresh_review_v1", run_role: "review" } }] };
        writes += 1;
        throw new Error("mutation forbidden");
      },
    }) },
  });
  const response = await route.POST({ json: async () => ({ reason: "must reject" }) }, {
    params: Promise.resolve({ id: randomUUID() }),
  });
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /cannot be generically requeued/);
  assert.equal(writes, 0);
});

test("runner source requires FD3, verifies capability hash, and never accepts capability via argv/env", () => {
  const source = readFileSync(resolve(repoRoot, "scripts/reviewer-runner.mjs"), "utf8");
  assert.match(source, /readCapabilityOnce\(\)/);
  assert.match(source, /timingSafeEqual\(storedHash, suppliedHash\)/);
  assert.doesNotMatch(source, /process\.argv\[[^\]]+\].*capabil/i);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*CAPABIL/i);
  assert.match(source, /HERMES_REVIEWER_PROFILE \|\| "reviewer"/);
  assert.match(source, /"--toolsets", "safe", "--safe-mode", "--ignore-rules"/);
  assert.match(source, /"--max-turns", "1", "--pass-session-id"/);
  assert.match(source, /reviewPackage\.json/);
  assert.match(source, /generateSandboxPolicy\(repositoryRoot, worktree, gitCommonDir\)/);
  assert.match(source, /cwd:\s*launcherDir/);
  assert.match(source, /heartbeat:/);
  assert.doesNotMatch(source, /cwd:\s*worktree/);
  assert.doesNotMatch(source, /"--profile"/);
  assert.match(source, /parseHermesOutput\(hermesResult\.stdout, hermesResult\.stderr\)/);
  assert.doesNotMatch(source, /Read the canonical review package at/);
  assert.match(readFileSync(resolve(repoRoot, "src/lib/reviewer/dispatch.ts"), "utf8"), /stdio:\s*\["ignore", "ignore", "ignore", "pipe"\]/);
});
