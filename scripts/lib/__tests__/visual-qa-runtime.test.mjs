import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { startDisposablePreviewDatabase } from "../disposable-preview-postgres.mjs";
import {
  AGENT_BROWSER_VERSION,
  aggregateVisualQaFindings,
  assertBrowserUrlAtPreviewOrigin,
  assertMissionControlAppRole,
  buildAgentBrowserArgs,
  buildVisualQaBrowserNetwork,
  buildAgentBrowserSessionId,
  buildHermesPlannerArgs,
  buildVisualQaInstallEnv,
  buildVisualQaPreviewEnv,
  cleanVisualQaChildEnv,
  createExactPreviewProxy,
  createHermesPlannerSessionAudit,
  createDetachedProcessGroupRegistry,
  createVisualQaHeartbeat,
  createVisualQaLifecycleGuard,
  defaultAgentBrowserBin,
  installVisualQaSignalHandlers,
  isDetachedProcessGroupAlive,
  makeTreeWritable,
  MAX_VISUAL_QA_ACTIONS,
  MAX_VISUAL_QA_BROWSER_MS,
  MAX_VISUAL_QA_COMBINATIONS,
  MAX_VISUAL_QA_FINDINGS,
  MAX_VISUAL_QA_FINDINGS_PER_COMBINATION,
  MAX_VISUAL_QA_HERMES_MS,
  VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION,
  VISUAL_QA_CAPABILITY_TTL_MS,
  VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS,
  parseVisualHermesOutput,
  prepareVisualQaTargetTrees,
  remapQaTargetUrl,
  resolveAgentBrowserExecutable,
  resolveArtifactRef,
  runVisualQaAllSettledSteps,
  runVisualQaCleanup,
  runVisualQaDeadlinePhase,
  sanitizeVisualQaFinish,
  sanitizeVisualQaObservation,
  terminateDetachedProcessGroup,
  VISUAL_QA_CLEANUP_RESERVE_MS,
  VISUAL_QA_FLOW_BUDGET_MS,
  VISUAL_QA_STARTUP_BUDGET_MS,
  VISUAL_QA_TOTAL_WORST_CASE_BUDGET_MS,
  visualQaErrorCode,
  visualQaRemainingWorkBudgetMs,
  validatePlannerActionForPreview,
  validatePlannerAction,
  verifyVisualQaHermesSession,
  writeImmutableArtifact,
} from "../visual-qa-runtime.mjs";

test("Visual QA V1 budgets exactly cover 53 browser commands, startup, every combination, cleanup, and completion", async () => {
  assert.equal(MAX_VISUAL_QA_ACTIONS, 6);
  assert.equal(MAX_VISUAL_QA_HERMES_MS, 60_000);
  assert.equal(MAX_VISUAL_QA_BROWSER_MS, 15_000);
  assert.equal(MAX_VISUAL_QA_COMBINATIONS, 2);
  assert.equal(VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION,
    4 + (MAX_VISUAL_QA_ACTIONS - 1) * 8 + 6 + 3,
    "startup + five non-finish actions + action-six finish observation + final evidence must execute 53 commands");
  assert.equal(VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION, 53);
  assert.equal(VISUAL_QA_FLOW_BUDGET_MS,
    MAX_VISUAL_QA_ACTIONS * MAX_VISUAL_QA_HERMES_MS
      + VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION * MAX_VISUAL_QA_BROWSER_MS
      + MAX_VISUAL_QA_BROWSER_MS,
  "each combination reserves one additional bounded artifact-persistence phase");
  assert.equal(VISUAL_QA_STARTUP_BUDGET_MS, 40 * 60_000);
  assert.equal(VISUAL_QA_CLEANUP_RESERVE_MS, 10 * 60_000);
  assert.equal(VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS, 30_000);
  assert.equal(VISUAL_QA_CAPABILITY_TTL_MS, 90 * 60_000);
  assert.equal(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_BUDGET_MS,
    remainingCombinations: MAX_VISUAL_QA_COMBINATIONS,
  }), VISUAL_QA_STARTUP_BUDGET_MS + MAX_VISUAL_QA_COMBINATIONS * VISUAL_QA_FLOW_BUDGET_MS);
  assert.equal(VISUAL_QA_TOTAL_WORST_CASE_BUDGET_MS,
    VISUAL_QA_STARTUP_BUDGET_MS
      + MAX_VISUAL_QA_COMBINATIONS * VISUAL_QA_FLOW_BUDGET_MS
      + VISUAL_QA_CLEANUP_RESERVE_MS
      + VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS);
  assert.ok(VISUAL_QA_TOTAL_WORST_CASE_BUDGET_MS <= VISUAL_QA_CAPABILITY_TTL_MS);
  assert.ok(MAX_VISUAL_QA_COMBINATIONS * 2 <= 64, "two artifacts per combination must fit result evidence authority");

  const [runner, claim, schema, forward, migration, upgradeMigration] = await Promise.all([
    readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8"),
    readFile(resolve("src/lib/qa/claim.ts"), "utf8"),
    readFile(resolve("ops/local-postgres/schema.sql"), "utf8"),
    readFile(resolve("ops/migrations/20260730_project_loops_v2_phase5b/forward.sql"), "utf8"),
    readFile(resolve("supabase/migrations/035_project_loops_v2_visual_qa.sql"), "utf8"),
    readFile(resolve("supabase/migrations/036_visual_qa_runner_v1.sql"), "utf8"),
  ]);
  const totalBudgetCheck = runner.indexOf("visualQaRemainingWorkBudgetMs({");
  const checkout = runner.indexOf("prepareVisualQaTargetTrees({");
  assert.ok(totalBudgetCheck >= 0 && checkout >= 0 && totalBudgetCheck < checkout,
    "the full remaining startup + combination budget must be checked before checkout");
  assert.match(runner, /remainingCombinations[\s\S]*assertExecutionBudget\([\s\S]*visualQaRemainingWorkBudgetMs/,
    "each combination must reserve every remaining combination, not only the current flow");
  assert.match(runner, /combinations > MAX_VISUAL_QA_COMBINATIONS/);
  assert.match(claim, /VISUAL_QA_CAPABILITY_TTL_MS = 90 \* 60_000/);
  assert.match(claim, /MAX_VISUAL_QA_COMBINATIONS = 2/);
  assert.match(claim, /policyCombinations <= MAX_VISUAL_QA_COMBINATIONS/);
  for (const sql of [schema, forward, migration]) {
    assert.match(sql, /claim_time\+interval '90 minutes'/);
    assert.doesNotMatch(sql, /claim_time\+interval '30 minutes'/);
  }
  assert.match(upgradeMigration,
    /CREATE OR REPLACE FUNCTION public\.claim_visual_qa_execution[\s\S]*claim_time\+interval '90 minutes'/,
    "the additive V1 upgrade must rebind the already-installed claim function to the runtime TTL");
});

test("agent-browser commands are pinned to Chromium, local-only domains, unique session, and no persisted auth", () => {
  assert.equal(AGENT_BROWSER_VERSION, "0.33.2");
  const session = `visual-qa-${randomUUID()}`;
  const network = buildVisualQaBrowserNetwork({
    browserOrigin: "http://vqa-0123456789abcdef.invalid:4123",
    proxyUrl: "http://127.0.0.1:4567",
  });
  const actions = [
    { action: "open", url: "http://vqa-0123456789abcdef.invalid:4123/loops?task=1" },
    { action: "snapshot" },
    { action: "click", ref: "@e1" },
    { action: "fill", ref: "@e2", text: "hello" },
    { action: "type", text: "world" },
    { action: "press", key: "Enter" },
    { action: "scroll", direction: "down", amount: 400 },
    { action: "wait", ms: 250 },
  ];
  for (const action of actions) {
    const args = buildAgentBrowserArgs(session, action, network);
    assert.ok(args.includes("--session"));
    assert.ok(args.includes(session));
    assert.deepEqual(args.slice(args.indexOf("--allowed-domains"), args.indexOf("--allowed-domains") + 2),
      ["--allowed-domains", "vqa-0123456789abcdef.invalid"]);
    assert.deepEqual(args.slice(args.indexOf("--proxy"), args.indexOf("--proxy") + 2),
      ["--proxy", "http://127.0.0.1:4567"]);
    assert.deepEqual(args.slice(args.indexOf("--engine"), args.indexOf("--engine") + 2), ["--engine", "chrome"]);
    for (const forbidden of ["--profile", "--state", "--restore", "--auto-connect", "--allow-file-access"]) {
      assert.equal(args.includes(forbidden), false, `${forbidden} must not be used`);
    }
  }
  assert.deepEqual(buildAgentBrowserArgs(session, { action: "snapshot" }, network).slice(-3), ["snapshot", "-i", "--json"]);
  assert.throws(() => buildAgentBrowserArgs(session, { action: "open", url: "http://127.0.0.1:3001/api" }, network),
    /visual_qa_action_open_origin_mismatch/);
  assert.throws(() => buildVisualQaBrowserNetwork({
    browserOrigin: "http://127.0.0.1:4123",
    proxyUrl: "http://127.0.0.1:4567",
  }), /visual_qa_browser_network_invalid/);
});

test("agent-browser is pinned in package metadata and defaults to this repo installation", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
  assert.equal(pkg.dependencies["agent-browser"], "0.33.2");
  assert.equal(lock.packages[""].dependencies["agent-browser"], "0.33.2");
  assert.equal(lock.packages["node_modules/agent-browser"].version, "0.33.2");
  assert.equal(defaultAgentBrowserBin("/repo/app"), resolve("/repo/app", "node_modules", ".bin", "agent-browser"));
});

test("agent-browser uses a short socket-safe session id", () => {
  const session = buildAgentBrowserSessionId("0123456789");
  assert.equal(session, "q0123456789");
  assert.ok(Buffer.byteLength(session) <= 16);
  assert.throws(() => buildAgentBrowserSessionId("not-hex"), /visual_qa_browser_session_invalid/);
});

test("agent-browser resolves the newest executable from the real runner home", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-browser-home-"));
  try {
    for (const version of ["150.0.1.2", "151.0.2.3"]) {
      const appDir = resolve(home, ".agent-browser", "browsers", `chrome-${version}`,
        "Google Chrome for Testing.app", "Contents", "MacOS");
      await mkdir(appDir, { recursive: true });
      await writeFile(resolve(appDir, "Google Chrome for Testing"), "#!/bin/sh\n", { mode: 0o755 });
    }
    const executable = await resolveAgentBrowserExecutable({ home });
    assert.match(executable, /chrome-151\.0\.2\.3/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("visual QA child environment excludes caller secrets and persisted browser/profile controls", () => {
  const previous = {
    AGENT_BROWSER_PROFILE: process.env.AGENT_BROWSER_PROFILE,
    AGENT_BROWSER_STATE: process.env.AGENT_BROWSER_STATE,
    AGENT_BROWSER_RESTORE: process.env.AGENT_BROWSER_RESTORE,
    DATABASE_URL: process.env.DATABASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  Object.assign(process.env, {
    AGENT_BROWSER_PROFILE: "/tmp/profile",
    AGENT_BROWSER_STATE: "/tmp/state.json",
    AGENT_BROWSER_RESTORE: "1",
    DATABASE_URL: "postgres://secret",
    OPENAI_API_KEY: "sk-secret",
  });
  try {
    const env = cleanVisualQaChildEnv({ HERMES_HOME: "/tmp/hermes", AGENT_BROWSER_IDLE_TIMEOUT_MS: "10000" });
    assert.equal(env.AGENT_BROWSER_PROFILE, undefined);
    assert.equal(env.AGENT_BROWSER_STATE, undefined);
    assert.equal(env.AGENT_BROWSER_RESTORE, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HERMES_HOME, "/tmp/hermes");
    assert.equal(env.AGENT_BROWSER_IDLE_TIMEOUT_MS, "10000");
    assert.deepEqual(Object.keys(env).sort(), ["AGENT_BROWSER_IDLE_TIMEOUT_MS", "HERMES_HOME", "HOME", "LANG", "PATH", "TMPDIR"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("preview environment contains no database credential that target pixels can exfiltrate", () => {
  const databaseUrl = "postgres://aipaths_mc_app@127.0.0.1:55432/postgres";
  const env = buildVisualQaPreviewEnv({ home: "/private/home", tmpdir: "/private/tmp", databaseUrl });
  assert.equal(env.HOME, "/private/home");
  assert.equal(env.TMPDIR, "/private/tmp");
  assert.equal(env.MISSION_CONTROL_LOCAL_AUTH_DISABLED, "true");
  assert.equal(env.MISSION_CONTROL_DATABASE_URL, databaseUrl);
  assert.equal(new URL(env.MISSION_CONTROL_DATABASE_URL).password, "");
  assert.throws(() => buildVisualQaPreviewEnv({
    home: "/private/home",
    tmpdir: "/private/tmp",
    databaseUrl: "postgres://aipaths_mc_app:renderable-secret@127.0.0.1:55432/postgres",
  }), /visual_qa_preview_database_invalid/);
  assert.throws(() => buildVisualQaPreviewEnv({
    home: "/private/home",
    tmpdir: "/private/tmp",
    databaseUrl: "postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local",
  }), /visual_qa_preview_database_invalid/);
  for (const key of ["DATABASE_URL", "DB_PASSWORD", "PASSWORD", "SECRET", "QA_AUTHORITY_HMAC_KEY", "HERMES_HOME", "HERMES_PROFILE"]) {
    assert.equal(env[key], undefined, key);
  }
  const targetRenderedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(JSON.stringify(env), "utf8"),
  ]);
  assert.equal(targetRenderedPng.includes(Buffer.from("renderable-secret")), false,
    "even a malicious target rendering its entire environment receives no redactable DB secret in image bytes");
  const browserEnv = cleanVisualQaChildEnv({
    HOME: "/browser/home",
    TMPDIR: "/browser/tmp",
    HERMES_HOME: "/must/not/leak/to/browser",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000",
    AGENT_BROWSER_SOCKET_DIR: "/private/tmp/ab-socket",
    AGENT_BROWSER_EXECUTABLE_PATH: "/real/chrome",
  }, { allowHermes: false });
  assert.equal(browserEnv.HOME, "/browser/home");
  assert.equal(browserEnv.TMPDIR, "/browser/tmp");
  assert.equal(browserEnv.HERMES_HOME, undefined);
  assert.equal(browserEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS, "1000");
  assert.equal(browserEnv.AGENT_BROWSER_SOCKET_DIR, "/private/tmp/ab-socket");
  assert.equal(browserEnv.AGENT_BROWSER_EXECUTABLE_PATH, "/real/chrome");
});

test("dependency acquisition has no database environment and target lifecycle executes offline under DB-only policy", async () => {
  const installEnv = buildVisualQaInstallEnv({ home: "/private/install-home", tmpdir: "/private/install-tmp" });
  assert.deepEqual(Object.keys(installEnv).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(installEnv.MISSION_CONTROL_DATABASE_URL, undefined);
  assert.equal(installEnv.MISSION_CONTROL_LOCAL_AUTH_DISABLED, undefined);

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  assert.match(runner, /const installEnv = buildVisualQaInstallEnv/);
  assert.match(runner, /npmCi[\s\S]*env:\s*installEnv/,
    "network-capable package acquisition must receive no database URL or target runtime environment");
  assert.match(runner, /npmCi[\s\S]*--ignore-scripts[\s\S]*--cache/,
    "acquisition must never execute target-controlled lifecycle scripts and must populate a private cache");
  assert.match(runner, /npmRebuild = sandboxedCommand\(runtimeSandboxPolicyPath[\s\S]*--offline[\s\S]*--cache/,
    "target-controlled dependency scripts must use only the acquired cache under the DB-only policy");
  assert.match(runner, /npmRebuild[\s\S]*env:\s*previewEnv/);
  assert.ok(runner.indexOf("const installEnv") < runner.indexOf("const previewEnv"));
});

test("Mission Control preview uses local auth only with a disposable database and gives planner children no credentials", async () => {
  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  const runtime = await readFile(resolve("scripts/lib/visual-qa-runtime.mjs"), "utf8");
  assert.match(runtime, /MISSION_CONTROL_LOCAL_AUTH_DISABLED:\s*"true"/);
  assert.match(runner, /startDisposablePreviewDatabase/);
  assert.match(runner, /MISSION_CONTROL_DATABASE_URL/);
  const env = cleanVisualQaChildEnv({ HERMES_HOME: "/tmp/hermes", HERMES_PROFILE: "reviewer" });
  assert.equal(env.MISSION_CONTROL_LOCAL_AUTH_DISABLED, undefined);
  assert.equal(env.MISSION_CONTROL_DATABASE_URL, undefined);
});

test("disposable preview PostgreSQL starts with schema-only app access and stops cleanly", async () => {
  const rootDir = await realpath(await mkdtemp(resolve(tmpdir(), "mc-vqa-postgres-")));
  let database;
  try {
    database = await startDisposablePreviewDatabase({
      rootDir,
      schemaPath: resolve("ops/local-postgres/schema.sql"),
    });
    const url = new URL(database.databaseUrl);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.username, "aipaths_mc_app");
    assert.equal(url.pathname, "/postgres");
    assert.equal(Number(url.port), database.port);
    assert.notEqual(database.port, 5432);
    assert.equal(url.password, "");
    assert.deepEqual(database.targetSecrets, [],
      "the disposable schema-only service must expose no password/token for target code to render");
    assert.deepEqual(Object.keys(database).sort(), ["child", "databaseUrl", "port", "stop", "targetSecrets"]);

    const client = new pg.Client({ connectionString: database.databaseUrl, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      const identity = await client.query("select current_user, current_database(), to_regclass('public.work_items') relation");
      assert.deepEqual(identity.rows[0], {
        current_user: "aipaths_mc_app",
        current_database: "postgres",
        relation: "work_items",
      });
    } finally {
      await client.end().catch(() => {});
    }

    await database.stop();
    const stopped = new pg.Client({ connectionString: database.databaseUrl, connectionTimeoutMillis: 500 });
    await assert.rejects(stopped.connect());
    await stopped.end().catch(() => {});
  } finally {
    await database?.stop().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("target URL remapping preserves only localhost path/query onto an isolated proxy origin", () => {
  assert.equal(remapQaTargetUrl("http://localhost:3001/loops/abc?tab=qa", "http://vqa-0123456789abcdef.invalid:51234"),
    "http://vqa-0123456789abcdef.invalid:51234/loops/abc?tab=qa");
  for (const [target, preview] of [
    ["https://example.com/loops", "http://vqa-0123456789abcdef.invalid:51234"],
    ["http://localhost:3001/loops", "https://vqa-0123456789abcdef.invalid:51234"],
    ["http://localhost:3001/loops", "http://127.0.0.1:51234"],
  ]) assert.throws(() => remapQaTargetUrl(target, preview), /visual_qa_(url_not_loopback|preview_origin_invalid)/);
});

test("Hermes planner actions are strict JSON and executable action names only", () => {
  const open = validatePlannerAction({ action: "open", url: "http://127.0.0.1:4123/loops" });
  assert.deepEqual(open, { action: "open", url: "http://127.0.0.1:4123/loops" });
  for (const invalid of [
    { action: "open", url: "https://example.com", extra: true },
    { action: "open", url: "file:///etc/passwd" },
    { action: "eval", script: "document.cookie" },
    { action: "click", ref: "#raw-selector" },
    { action: "fill", ref: "@e1", text: "" },
    { action: "press", key: "Meta+L" },
    { action: "scroll", direction: "diagonal", amount: 100 },
    { action: "wait", ms: 60_001 },
    { action: "finish", verdict: "pass", summary: "ok", findings: [], extra: true },
  ]) assert.throws(() => validatePlannerAction(invalid), /visual_qa_action/);
});

test("findings are capped deterministically at 25 per combination and 50 globally", () => {
  assert.equal(MAX_VISUAL_QA_FINDINGS, 50);
  assert.equal(MAX_VISUAL_QA_FINDINGS_PER_COMBINATION, 25);
  const finding = (index) => ({
    title: `Issue ${index}`,
    evidence: `Evidence ${index}`,
    recommendation: `Fix ${index}`,
  });
  const first = Array.from({ length: 25 }, (_, index) => finding(index));
  const second = Array.from({ length: 25 }, (_, index) => finding(index + 25));
  const parsed = validatePlannerAction({
    action: "finish",
    verdict: "changes",
    summary: "Found issues",
    findings: first,
  });
  assert.equal(parsed.findings.length, 25);
  assert.throws(() => validatePlannerAction({
    action: "finish",
    verdict: "changes",
    summary: "Too many issues",
    findings: [...first, finding(25)],
  }), /visual_qa_action_finish_invalid/);
  const aggregate = aggregateVisualQaFindings([first, second]);
  assert.equal(aggregate.length, 50);
  assert.deepEqual(aggregate.map(({ title }) => title),
    Array.from({ length: 50 }, (_, index) => `Issue ${index}`),
    "aggregation must preserve viewport/flow traversal order");
  assert.throws(() => aggregateVisualQaFindings([first, second, [finding(50)]]),
    /visual_qa_findings_contract_exceeded/);
});

test("planner open actions must use the exact randomized preview proxy origin", () => {
  const previewOrigin = "http://vqa-0123456789abcdef.invalid:4123";
  assert.deepEqual(validatePlannerActionForPreview({ action: "open", url: `${previewOrigin}/loops?tab=qa` }, previewOrigin),
    { action: "open", url: `${previewOrigin}/loops?tab=qa` });
  assert.deepEqual(validatePlannerActionForPreview({ action: "click", ref: "@e1" }, previewOrigin),
    { action: "click", ref: "@e1" });
  for (const url of [
    "http://vqa-0123456789abcdef.invalid:4124/loops",
    "http://vqa-fedcba9876543210.invalid:4123/loops",
    "http://127.0.0.1:4123/loops",
    "https://vqa-0123456789abcdef.invalid:4123/loops",
  ]) assert.throws(() => validatePlannerActionForPreview({ action: "open", url }, previewOrigin), /visual_qa_action_open/);
});

test("browser URL checks reject proxy-origin port and hostname escapes", () => {
  const preview = "http://vqa-0123456789abcdef.invalid:4123";
  assert.equal(assertBrowserUrlAtPreviewOrigin(`${preview}/loops?task=1`, preview),
    `${preview}/loops?task=1`);
  assert.throws(() => assertBrowserUrlAtPreviewOrigin("http://vqa-0123456789abcdef.invalid:3001/api", preview),
    /visual_qa_browser_origin_mismatch/);
  assert.throws(() => assertBrowserUrlAtPreviewOrigin("http://127.0.0.1:4123/loops", preview),
    /visual_qa_browser_origin_mismatch/);
});

test("exact preview proxy forwards only the randomized browser origin", async () => {
  let upstreamHits = 0;
  const upstream = createServer((request_, response) => {
    upstreamHits += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`upstream:${request_.url}`);
  });
  await new Promise((resolveListen, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const exact = await createExactPreviewProxy({
    upstreamOrigin: `http://127.0.0.1:${address.port}`,
    randomHex: "0123456789abcdef",
  });
  const throughProxy = (absoluteUrl) => new Promise((resolveRequest, reject) => {
    const proxy = new URL(exact.proxyUrl);
    const req = request({
      host: proxy.hostname,
      port: proxy.port,
      path: absoluteUrl,
      method: "GET",
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
  try {
    assert.deepEqual(await throughProxy(`${exact.browserOrigin}/ok?q=1`), { status: 200, body: "upstream:/ok?q=1" });
    const blocked = await throughProxy("http://vqa-0123456789abcdef.invalid:3001/api/work-items");
    assert.equal(blocked.status, 403);
    assert.equal(upstreamHits, 1);
  } finally {
    await exact.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("exact preview proxy force-closes active connections within its cleanup bound", async () => {
  const upstream = createServer(() => {});
  await new Promise((resolveListen, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const exact = await createExactPreviewProxy({
    upstreamOrigin: `http://127.0.0.1:${address.port}`,
    randomHex: "fedcba9876543210",
  });
  const proxy = new URL(exact.proxyUrl);
  const pending = request({ host: proxy.hostname, port: proxy.port, path: `${exact.browserOrigin}/hang` });
  pending.on("error", () => {});
  pending.end();
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  const started = Date.now();
  await exact.close({ timeoutMs: 50 });
  assert.ok(Date.now() - started < 500, "proxy cleanup must be bounded even with active requests");
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("Hermes visual output has one session id and one strict planner action", () => {
  const sessionId = "20260803_120000_a1b2c3";
  assert.deepEqual(parseVisualHermesOutput('{"action":"snapshot"}', `session_id: ${sessionId}\n`), {
    sessionId,
    action: { action: "snapshot" },
  });
  assert.throws(() => parseVisualHermesOutput('{"action":"snapshot"}', ""), /visual_qa_session_id_cardinality/);
  assert.throws(() => parseVisualHermesOutput('{"action":"snapshot"}', `session_id: ${sessionId}\nsession_id: ${sessionId}\n`),
    /visual_qa_session_id_cardinality/);
  assert.throws(() => parseVisualHermesOutput('{"action":"snapshot","extra":true}', `session_id: ${sessionId}\n`),
    /visual_qa_action/);
});

test("Hermes planner CLI uses resume, no cwd restore, and an explicit no-tools selector", () => {
  const first = buildHermesPlannerArgs({
    prompt: "Return one JSON action.",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    imagePath: "/tmp/shot.png",
  });
  assert.equal(first.includes("--session"), false);
  assert.equal(first.includes("--resume"), false);
  assert.ok(first.includes("--no-restore-cwd"));
  assert.ok(first.includes("--safe-mode"));
  assert.ok(first.includes("--ignore-rules"));
  assert.deepEqual(first.slice(first.indexOf("--max-turns"), first.indexOf("--max-turns") + 2), ["--max-turns", "1"]);
  assert.deepEqual(first.slice(first.indexOf("--image"), first.indexOf("--image") + 2), ["--image", "/tmp/shot.png"]);
  assert.notEqual(first[first.indexOf("--toolsets") + 1], "safe");

  const resumed = buildHermesPlannerArgs({
    prompt: "Return one JSON action.",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    imagePath: "/tmp/shot.png",
    sessionId: "20260803_120000_a1b2c3",
  });
  assert.equal(resumed.includes("--session"), false);
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2),
    ["--resume", "20260803_120000_a1b2c3"]);
});

test("state.db verification pins visual QA source, exact model/provider/billing provider, and bounded iterations", async () => {
  const sessionId = "20260803_120000_a1b2c3";
  const base = { id: sessionId, source: "mission-control-visual-qa", started_at: 105,
    model: "gpt-5.6-sol", billing_provider: "openai-codex",
    model_config: JSON.stringify({ max_iterations: 1, provider: "openai-codex" }) };
  const invoke = (row) => verifyVisualQaHermesSession(
    "/fake/state.db", sessionId, 100, 110, "gpt-5.6-sol", "openai-codex",
    async (file, args) => {
      assert.equal(file, "/usr/bin/sqlite3");
      assert.deepEqual(args.slice(0, 2), ["-json", "/fake/state.db"]);
      return { stdout: JSON.stringify([row]), stderr: "" };
    });
  await invoke(base);
  await assert.rejects(invoke({ ...base, source: "cli" }), /visual_qa_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, model: "other" }), /visual_qa_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, billing_provider: "openrouter" }), /visual_qa_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, model_config: JSON.stringify({ max_iterations: 1, provider: "openrouter" }) }),
    /visual_qa_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, model_config: JSON.stringify({ max_iterations: 2, provider: "openai-codex" }) }),
    /visual_qa_state_db_session_mismatch/);
  await assert.rejects(invoke({ ...base, started_at: 500 }), /visual_qa_state_db_session_mismatch/);
});

test("resumed Hermes planner turns verify against the first turn lower bound and bind once", async () => {
  const sessionId = "20260803_120000_a1b2c3";
  const row = { id: sessionId, source: "mission-control-visual-qa", started_at: 105,
    model: "gpt-5.6-sol", billing_provider: "openai-codex",
    model_config: JSON.stringify({ max_iterations: 1, provider: "openai-codex" }) };
  const bindings = [];
  const audit = createHermesPlannerSessionAudit({
    stateDb: "/fake/state.db",
    expectedModel: "gpt-5.6-sol",
    expectedProvider: "openai-codex",
    run: async () => ({ stdout: JSON.stringify([row]), stderr: "" }),
    bindPlannerSession: async (verifiedSessionId) => { bindings.push(verifiedSessionId); },
  });
  await audit.verify({ sessionId, startedAfter: 100, finishedBefore: 110 });
  await audit.verify({ sessionId, startedAfter: 200, finishedBefore: 210 });
  assert.deepEqual(bindings, [sessionId], "the audited planner session must be bound exactly once");
  await assert.rejects(audit.verify({
    sessionId: "20260803_120001_d4e5f6",
    startedAfter: 211,
    finishedBefore: 220,
  }), /visual_qa_hermes_session_changed/);
});

test("target-controlled snapshot and console observations are allowlisted and redacted before planner or artifact use", () => {
  const databaseUrl = "postgresql://aipaths_mc_app:preview-password@127.0.0.1:55432/postgres";
  const standaloneDatabasePassword = "opaque-vqa-password-value";
  const apiKey = ["s", "k-test-", "abcdefghijklmnopqrstuv"].join("");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature0123456789";
  const privateKey = ["-----BEGIN", " PRIVATE KEY-----", "\nvery-secret-key-material", "\n-----END PRIVATE KEY-----"].join("");
  const observation = sanitizeVisualQaObservation({
    snapshot: `button @e1 ${standaloneDatabasePassword} ${encodeURIComponent(standaloneDatabasePassword)} MISSION_CONTROL_DATABASE_URL=${databaseUrl} OPENAI_API_KEY=${apiKey} jwt=${jwt} ${privateKey}`,
    diagnostics: [
      { step: 1, kind: "console", output: `fetch failed ${databaseUrl}; Authorization: Bearer attacker-secret`, injected: "must-drop" },
      { step: 2, kind: "console_capture_error", error: `SECRET ${apiKey}`, stack: databaseUrl },
      { step: 3, kind: "page_error", output: databaseUrl },
    ],
    secrets: [databaseUrl, standaloneDatabasePassword],
  });
  const finish = sanitizeVisualQaFinish({
    action: "finish",
    verdict: "changes",
    summary: `Found ${databaseUrl}`,
    findings: [{ title: `Leak ${apiKey}`, evidence: jwt, recommendation: privateKey }],
  }, [databaseUrl, standaloneDatabasePassword]);
  const serialized = JSON.stringify({ observation, finish });
  for (const secret of [databaseUrl, standaloneDatabasePassword, apiKey, jwt, "very-secret-key-material"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.deepEqual(Object.keys(observation.diagnostics[0]).sort(), ["kind", "output", "step"]);
  assert.deepEqual(observation.diagnostics[1], {
    step: 2,
    kind: "console_capture_error",
    error: "visual_qa_console_capture_failed",
  });
  assert.equal(observation.diagnostics.length, 2, "unknown target-controlled diagnostic shapes must be dropped");
});

test("operational failures collapse arbitrary child output and secrets to fixed codes", async () => {
  assert.equal(visualQaErrorCode(new Error("visual_qa_preview_eaddrinuse:attacker stderr SECRET=abc")),
    "visual_qa_preview_eaddrinuse");
  assert.equal(visualQaErrorCode(new Error("npm failed with postgres://user:password@127.0.0.1/db")),
    "visual_qa_unexpected_failure");
  assert.equal(visualQaErrorCode("raw child stderr"), "visual_qa_unexpected_failure");

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  const postgresRuntime = await readFile(resolve("scripts/lib/disposable-preview-postgres.mjs"), "utf8");
  assert.match(runner, /const redactionSecrets = disposablePreviewDatabase\.targetSecrets/);
  assert.match(runner, /runFlow\(\{[\s\S]*?redactionSecrets,[\s\S]*?\}\)/);
  assert.doesNotMatch(runner, /visual_qa\.preview_stderr|message:\s*text/);
  assert.doesNotMatch(postgresRuntime, /detail\s*\?|stderr\.trim\(\).*throw new Error/s);
});

test("public Visual QA APIs expose only allowlisted error codes", async () => {
  const routes = await Promise.all([
    "src/app/api/qa/claim/route.ts",
    "src/app/api/qa/executions/[id]/heartbeat/route.ts",
    "src/app/api/qa/executions/[id]/complete/route.ts",
  ].map((path) => readFile(resolve(path), "utf8")));
  for (const route of routes) {
    assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
    assert.doesNotMatch(route, /return response\(\{ error: message \}/);
    assert.match(route, /PUBLIC_[A-Z_]+_ERRORS/);
  }
});

test("one global heartbeat is immediate, periodic, serialized, and stops cleanly", async () => {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const heartbeat = createVisualQaHeartbeat({
    intervalMs: 10,
    beatTimeoutMs: 50,
    beat: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      concurrent -= 1;
    },
  });
  await heartbeat.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 45));
  await heartbeat.stop();
  assert.ok(calls >= 3, `expected periodic beats, got ${calls}`);
  assert.equal(maxConcurrent, 1);
  const stoppedAt = calls;
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(calls, stoppedAt);
});

test("global heartbeat fails closed when authority rejects a beat", async () => {
  let calls = 0;
  const heartbeat = createVisualQaHeartbeat({
    intervalMs: 5,
    beatTimeoutMs: 50,
    beat: async () => {
      calls += 1;
      if (calls === 2) throw new Error("SECRET authority response");
    },
  });
  await heartbeat.start();
  await assert.rejects(heartbeat.guard(new Promise((resolveWait) => setTimeout(resolveWait, 100))),
    /^Error: visual_qa_heartbeat_failed$/);
  await heartbeat.stop();
  assert.equal(calls, 2);

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  assert.match(runner, /createVisualQaHeartbeat/);
  assert.doesNotMatch(runner, /heartbeatIntervalMs|heartbeat:\s*async/,
    "planner calls must not own resettable heartbeat timers");
});

test("lifecycle guard aborts a hung operation when the global heartbeat loses authority", async () => {
  let calls = 0;
  const heartbeat = createVisualQaHeartbeat({
    intervalMs: 5,
    beatTimeoutMs: 50,
    beat: async () => {
      calls += 1;
      if (calls === 2) throw new Error("sensitive authority response");
    },
  });
  const lifecycle = createVisualQaLifecycleGuard({ heartbeat, drainTimeoutMs: 20 });
  await heartbeat.start();
  await assert.rejects(lifecycle.guard(new Promise(() => {})),
    /^Error: visual_qa_heartbeat_failed$/);
  assert.equal(lifecycle.signal.aborted, true);
  await heartbeat.stop();

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  assert.match(runner, /guardHeartbeat\(pool\.query\([\s\S]*bind_visual_qa_planner_session/);
  assert.match(runner, /prepareVisualQaTargetTrees\([\s\S]*signal/);
  assert.match(runner, /startDisposablePreviewDatabase\([\s\S]*signal/);
  assert.match(runner, /query_timeout:\s*15_000/);
});

test("visual QA verifies app-role database identity before execution queries", async () => {
  const calls = [];
  await assertMissionControlAppRole({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [{ current_user: "aipaths_mc_app" }] };
    },
  });
  assert.match(calls[0].sql, /select\s+current_user/i);
  assert.deepEqual(calls[0].params, []);
  await assert.rejects(assertMissionControlAppRole({
    query: async () => ({ rows: [{ current_user: "postgres" }] }),
  }), /visual_qa_database_role_mismatch/);

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  const roleCheck = runner.indexOf("await assertMissionControlAppRole");
  const executionQuery = runner.indexOf("select e.*");
  assert.ok(roleCheck >= 0 && executionQuery >= 0 && roleCheck < executionQuery);
});

test("preview preparation removes the exact detached source worktree before untrusted preview code runs", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-source-"));
  const repo = resolve(root, "repo");
  const temp = resolve(root, "run");
  let prepared = null;
  try {
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "qa@example.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Visual QA"]);
    await writeFile(resolve(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" } }));
    await writeFile(resolve(repo, "index.txt"), "target tree\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "target"], { stdio: "ignore" });
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await mkdir(temp, { recursive: true });
    prepared = await prepareVisualQaTargetTrees({ repositoryRoot: repo, targetSha: sha, tempDir: temp });
    assert.notEqual(prepared.sourceWorktree, prepared.previewDir);
    await assert.rejects(realpath(prepared.sourceWorktree), /ENOENT/,
      "detached source worktree must be removed before npm/build/server starts");
    assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).includes(prepared.sourceWorktree), false,
      "detached worktree registration must be pruned before preview code can execute");
    assert.equal(await readFile(resolve(prepared.previewDir, "index.txt"), "utf8"), "target tree\n");
    await writeFile(resolve(prepared.previewDir, "built.txt"), "ok");
  } finally {
    if (prepared?.sourceWorktree) await makeTreeWritable(prepared.sourceWorktree).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("preview preparation self-cleans detached worktree registration on every failure", async () => {
  const calls = [];
  const targetSha = "a".repeat(40);
  const temp = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-cleanup-"));
  try {
    await assert.rejects(prepareVisualQaTargetTrees({
      repositoryRoot: "/repo",
      targetSha,
      tempDir: temp,
      git: async (cwd, args) => {
        calls.push({ cwd, args });
        if (args[0] === "worktree" && args[1] === "add") return { stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { stdout: `${targetSha}\n`, stderr: "" };
        if (args[0] === "status") throw new Error("status failed");
        return { stdout: "", stderr: "" };
      },
    }), /status failed/);
    assert.ok(calls.some((call) => call.cwd === "/repo" && call.args.join(" ") === `worktree remove --force ${resolve(temp, "source-worktree")}`),
      "failed preparation must remove the detached worktree");
    assert.ok(calls.some((call) => call.cwd === "/repo" && call.args.join(" ") === "worktree prune"),
      "failed preparation must prune stale git worktree registration");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("detached process-group termination escalates TERM to KILL and ignores unsafe PIDs", async () => {
  const calls = [];
  let killed = false;
  await terminateDetachedProcessGroup(4242, {
    termWaitMs: 1,
    killWaitMs: 1,
    pollIntervalMs: 1,
    kill: (pid, signal) => {
      if (signal === 0 && killed) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      calls.push([pid, signal]);
      if (signal === "SIGKILL") killed = true;
      if (signal === 0) return true;
      return true;
    },
  });
  assert.ok(calls.some(([pid, signal]) => pid === -4242 && signal === "SIGTERM"));
  assert.ok(calls.some(([pid, signal]) => pid === -4242 && signal === "SIGKILL"));
  calls.length = 0;
  await terminateDetachedProcessGroup(0, { kill: (pid, signal) => calls.push([pid, signal]) });
  await terminateDetachedProcessGroup(-1, { kill: (pid, signal) => calls.push([pid, signal]) });
  assert.deepEqual(calls, []);

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  assert.match(runner, /startPreview[\s\S]*catch[\s\S]*terminateDetachedProcessGroup/);
  assert.match(runner, /finally[\s\S]*terminateDetachedProcessGroup/);
});

test("detached process-group termination throws if SIGKILL does not end the group", async () => {
  await assert.rejects(terminateDetachedProcessGroup(5151, {
    termWaitMs: 1,
    killWaitMs: 1,
    pollIntervalMs: 1,
    kill: () => true,
  }), /visual_qa_process_group_alive_after_sigkill/);
});

test("process-group probes fail closed on EPERM and tracked groups survive cleanup failure for idempotent retry", async () => {
  const denied = new Error("not permitted");
  denied.code = "EPERM";
  assert.throws(() => isDetachedProcessGroupAlive(4242, () => { throw denied; }),
    /^Error: visual_qa_process_group_probe_failed$/);

  let attempts = 0;
  const registry = createDetachedProcessGroupRegistry({
    terminate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("unknown group state");
    },
    probe: () => false,
  });
  registry.track(4242);
  await assert.rejects(registry.terminateAll(), /^Error: visual_qa_process_group_cleanup_failed$/);
  assert.equal(registry.size, 1, "an unverified group must remain tracked after cleanup failure");
  await registry.terminateAll();
  assert.equal(registry.size, 0, "a retry may untrack only after verified absence");

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  const normalBarrier = runner.indexOf("await cleanupProcessGroups()");
  const resourceCleanup = runner.indexOf("await cleanupResources()", normalBarrier);
  const completion = runner.indexOf("await complete(terminalResult)");
  assert.ok(normalBarrier >= 0 && resourceCleanup > normalBarrier && completion > resourceCleanup,
    "ordinary finalization must prove every tracked group absent before resource cleanup and completion");
});

test("cleanup timeout aborts and drains the active resource before advancing, then retries only failed resources", async () => {
  const order = [];
  let browserActive = false;
  let browserAttempts = 0;
  let proxyAttempts = 0;
  const cleanup = runVisualQaCleanup({
    browser: async ({ signal } = {}) => {
      browserAttempts += 1;
      browserActive = true;
      order.push("browser-start");
      await new Promise((resolveDrain) => {
        signal?.addEventListener("abort", () => {
          order.push("browser-abort");
          setTimeout(() => {
            browserActive = false;
            order.push("browser-drained");
            resolveDrain();
          }, 20);
        }, { once: true });
      });
    },
    preview: async () => {
      assert.equal(browserActive, false, "dependent cleanup started before timed-out browser cleanup drained");
      order.push("preview");
    },
    proxy: async () => {
      proxyAttempts += 1;
      order.push(`proxy-${proxyAttempts}`);
      if (proxyAttempts === 1) throw new Error("first proxy cleanup failed");
    },
  }, { stepTimeoutMs: 5, drainTimeoutMs: 100 });

  await assert.rejects(cleanup(), /^Error: visual_qa_cleanup_failed$/);
  assert.deepEqual(order.slice(0, 4), ["browser-start", "browser-abort", "browser-drained", "preview"]);
  await cleanup();
  assert.equal(browserAttempts, 1, "settled resources must not rerun on idempotent retry");
  assert.equal(proxyAttempts, 2, "only the failed resource should retry");
});

test("cleanup is serialized, ordered browser -> preview -> proxy -> postgres -> worktree -> temp -> socket, and fails closed", async () => {
  const order = [];
  const cleanup = runVisualQaCleanup({
    browser: async () => { order.push("browser"); },
    preview: async () => { order.push("preview"); },
    proxy: async () => { order.push("proxy"); throw new Error("SECRET proxy output"); },
    postgres: async () => { order.push("postgres"); },
    worktree: async () => { order.push("worktree"); },
    temp: async () => { order.push("temp"); },
    socket: async () => { order.push("socket"); },
  }, { stepTimeoutMs: 100 });
  const [left, right] = await Promise.allSettled([cleanup(), cleanup()]);
  assert.deepEqual(order, ["browser", "preview", "proxy", "postgres", "worktree", "temp", "socket"]);
  assert.equal(left.status, "rejected");
  assert.equal(right.status, "rejected");
  assert.match(left.reason.message, /^visual_qa_cleanup_failed$/);
  assert.doesNotMatch(left.reason.message, /SECRET/);
});

test("signal cleanup attempts every step and reports one fixed failure after an intermediate process-group error", async () => {
  const order = [];
  await assert.rejects(runVisualQaAllSettledSteps([
    async () => { order.push("heartbeat"); },
    async () => { order.push("process-groups"); throw new Error("SECRET terminateAll failure"); },
    async () => { order.push("resources"); },
    async () => { order.push("pool"); },
  ], "visual_qa_signal_cleanup_failed"), /^Error: visual_qa_signal_cleanup_failed$/);
  assert.deepEqual(order, ["heartbeat", "process-groups", "resources", "pool"]);
});

test("signal synchronously aborts main work, forbids completion, and shares one cleanup promise", async () => {
  const controller = new AbortController();
  let cleanupCalls = 0;
  let completionCalls = 0;
  const exits = [];
  const signals = installVisualQaSignalHandlers({
    controller,
    cleanup: async () => {
      cleanupCalls += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    },
    exit: (code) => { exits.push(code); },
  });
  try {
    process.emit("SIGTERM");
    assert.equal(controller.signal.aborted, true, "signal handler must abort the main lifecycle synchronously");
    if (signals.canComplete()) completionCalls += 1;
    await Promise.all([signals.cleanup(), signals.cleanup(), signals.settled()]);
    assert.equal(signals.signaled, true);
    assert.equal(completionCalls, 0, "signal and main-finally races must never publish completion");
    assert.equal(cleanupCalls, 1, "signal and ordinary finalization must converge on one cleanup promise");
    assert.deepEqual(exits, [143]);
  } finally {
    signals.remove();
  }
});

test("phase deadlines abort and drain hung filesystem/artifact work before control advances", async () => {
  const order = [];
  await assert.rejects(runVisualQaDeadlinePhase("artifact", async ({ signal }) => {
    order.push("artifact-start");
    await new Promise((resolveDrain) => {
      signal.addEventListener("abort", () => {
        order.push("artifact-abort");
        setTimeout(() => {
          order.push("artifact-drained");
          resolveDrain();
        }, 15);
      }, { once: true });
    });
  }, {
    deadlineMs: Date.now() + 5,
    drainTimeoutMs: 100,
  }), /^Error: visual_qa_artifact_deadline_exceeded$/);
  order.push("next-phase");
  assert.deepEqual(order, ["artifact-start", "artifact-abort", "artifact-drained", "next-phase"]);

  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  for (const phase of ["repository", "target", "postgres", "preview", "browser", "combination", "artifact"]) {
    assert.match(runner, new RegExp(`runPhase\\(\\"${phase}\\"`), `${phase} must have a real phase deadline`);
  }
  assert.match(runner, /writeImmutableArtifact\([\s\S]*signal/,
    "artifact persistence must consume the phase abort signal");
  assert.match(runner, /executionDeadlineTimer = setTimeout[\s\S]*lifecycleAbort\.abort/,
    "the authoritative execution deadline must asynchronously abort the lifecycle");
});

test("SIGTERM coordinates real detached child-group cleanup with no surviving descendant", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-vqa-signal-"));
  const harness = resolve(root, "harness.mjs");
  const runtimeUrl = new URL("../visual-qa-runtime.mjs", import.meta.url).href;
  const childProgram = "const {spawn}=require('node:child_process'); const child=spawn('/bin/sleep',['60']); console.log(child.pid); setInterval(()=>{},1000);";
  await writeFile(harness, `
    import { spawn } from "node:child_process";
    import { createDetachedProcessGroupRegistry, installVisualQaSignalHandlers } from ${JSON.stringify(runtimeUrl)};
    const registry = createDetachedProcessGroupRegistry();
    const group = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    registry.track(group.pid);
    group.stdout.once("data", (chunk) => {
      process.stdout.write("READY:" + group.pid + ":" + chunk.toString().trim() + "\\n");
    });
    installVisualQaSignalHandlers({ cleanup: () => registry.terminateAll(), exit: (code) => process.exit(code) });
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    const deadline = Date.now() + 5_000;
    while (!/READY:\d+:\d+/.test(stdout) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const match = stdout.match(/READY:(\d+):(\d+)/);
    assert.ok(match, `harness did not become ready: ${stdout}`);
    child.kill("SIGTERM");
    const [code] = await new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (...args) => resolveClose(args));
    });
    assert.equal(code, 143);
    for (const pid of match.slice(1).map(Number)) {
      let alive = true;
      const goneDeadline = Date.now() + 2_000;
      while (alive && Date.now() < goneDeadline) {
        try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") alive = false; }
        if (alive) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      assert.equal(alive, false, `descendant ${pid} survived coordinated SIGTERM cleanup`);
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("preview startup reserves a loopback port and enforces filesystem and network sandbox probes", async () => {
  const runner = await readFile(resolve("scripts/visual-qa-runner.mjs"), "utf8");
  assert.match(runner, /reserveLoopbackPort/);
  assert.match(runner, /server\.listen\(0,\s*"127\.0\.0\.1"/);
  assert.match(runner, /visual_qa_preview_process_exited|visual_qa_preview_early_exit/);
  assert.match(runner, /EADDRINUSE/);
  assert.match(runner, /assertSandboxWriteDenied/);
  assert.match(runner, /assertSandboxNetworkDenied/);
  assert.match(runner, /sandbox-exec/);
  assert.ok(runner.includes('"(deny file-write*)"'),
    "preview sandbox must default-deny filesystem writes");
  assert.ok(runner.includes('"(deny network-outbound)"'),
    "build and preview sandbox must deny outbound connections by default");
  assert.match(runner, /allow network-outbound[\s\S]*remote ip[\s\S]*disposableDatabasePort/,
    "only the isolated disposable PostgreSQL port may be reachable from target code");
  assert.ok(runner.includes('remote ip "localhost:${disposableDatabasePort}"'),
    "macOS SBPL requires localhost, not a numeric loopback host, for an exact remote port");
  assert.doesNotMatch(runner, /remote ip "127\.0\.0\.1:/);
  assert.match(runner, /startDisposablePreviewDatabase[\s\S]*ops[\s\S]*local-postgres[\s\S]*schema\.sql/,
    "preview must use a private schema-only PostgreSQL cluster, never the live database");
  assert.match(runner, /writable\.map[\s\S]*allow file-write\*/,
    "preview sandbox must allow writes only below private preview paths");
  assert.match(runner, /npmCi[\s\S]*--ignore-scripts[\s\S]*npmRebuild[\s\S]*runtimeSandboxPolicyPath/,
    "dependency lifecycle scripts must run only inside the network-denied runtime sandbox");
  assert.match(runner, /npmCi[\s\S]*detachedProcessGroup:\s*true/,
    "untrusted install/build commands must be cleaned as process groups");
  assert.match(runner, /runPhase\("target"[\s\S]*temp\s*=\s*await realpath\(await mkdtemp\(/,
    "sandbox policy paths must use the canonical /private/var form on macOS");
  const networkProbeIndex = runner.indexOf("await assertSandboxNetworkDenied(runtimeSandboxPolicyPath");
  const buildIndex = runner.indexOf("const npmBuild =");
  assert.ok(networkProbeIndex >= 0 && buildIndex >= 0 && networkProbeIndex < buildIndex,
    "network-denied probe must run before npm build and Next preview");
  for (const binding of ["artifactRoot", "repositoryRoot", "gitCommonDir", "detachedSourceWorktree"]) {
    assert.match(runner, new RegExp(binding), `${binding} must be included in preview sandbox write denials`);
  }
});

test("visual QA artifacts are content-addressed, immutable, traversal-safe, and checksum-bound", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-artifacts-"));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const descriptor = await writeImmutableArtifact(root, {
      executionId: randomUUID(),
      viewport: "desktop",
      flow: "Open Loop detail",
      kind: "screenshot",
      mediaType: "image/png",
      content: png,
    });
    assert.match(descriptor.storage_ref, /^qa\/[0-9a-f-]{36}\/[0-9a-f]{2}\/[0-9a-f]{64}\.desktop\.open-loop-detail\.png$/);
    assert.equal(descriptor.sha256, createHash("sha256").update(png).digest("hex"));
    assert.equal(descriptor.bytes, png.length);
    assert.equal(descriptor.media_type, "image/png");
    assert.deepEqual(await readFile(resolve(root, descriptor.storage_ref)), png);
    assert.equal(await realpath(resolve(root, descriptor.storage_ref)), await resolveArtifactRef(root, descriptor.storage_ref));
    assert.deepEqual(await writeImmutableArtifact(root, {
      executionId: descriptor.storage_ref.split("/")[1],
      viewport: "desktop",
      flow: "Open Loop detail",
      kind: "screenshot",
      mediaType: "image/png",
      content: png,
    }), descriptor);
    for (const badRef of ["../secret.png", "qa/./desktop.png", "qa//desktop.png", "/absolute.png"]) {
      await assert.rejects(resolveArtifactRef(root, badRef), /visual_qa_artifact_ref_invalid/);
    }
    await mkdir(resolve(root, "qa", "linked"), { recursive: true });
    await symlink(resolve(tmpdir()), resolve(root, "qa", "linked", "out.png"));
    await assert.rejects(resolveArtifactRef(root, "qa/linked/out.png"), /visual_qa_artifact_ref_escape/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual QA artifact writes reject symlinked paths before write and sniff declared image bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-artifact-hardening-"));
  const outside = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-artifact-outside-"));
  try {
    const executionId = randomUUID();
    const fakePng = Buffer.from("not a png");
    await assert.rejects(writeImmutableArtifact(root, {
      executionId,
      viewport: "desktop",
      flow: "Open Loop detail",
      kind: "screenshot",
      mediaType: "image/png",
      content: fakePng,
    }), /visual_qa_artifact_media_type/);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const sha = createHash("sha256").update(png).digest("hex");
    await mkdir(resolve(root, "qa", executionId), { recursive: true });
    await mkdir(resolve(outside, sha.slice(0, 2)), { recursive: true });
    await symlink(resolve(outside, sha.slice(0, 2)), resolve(root, "qa", executionId, sha.slice(0, 2)));
    await assert.rejects(writeImmutableArtifact(root, {
      executionId,
      viewport: "desktop",
      flow: "Open Loop detail",
      kind: "screenshot",
      mediaType: "image/png",
      content: png,
    }), /visual_qa_artifact_parent_symlink|visual_qa_artifact_ref_escape/);
    assert.deepEqual(await readdir(resolve(outside, sha.slice(0, 2))), []);

    await rm(resolve(root, "qa", executionId, sha.slice(0, 2)), { force: true });
    await mkdir(resolve(root, "qa", executionId, sha.slice(0, 2)), { recursive: true });
    const finalPath = resolve(root, "qa", executionId, sha.slice(0, 2), `${sha}.desktop.open-loop-detail.png`);
    const outsideTarget = resolve(outside, "same-content.png");
    await writeFile(outsideTarget, png);
    await symlink(outsideTarget, finalPath);
    await assert.rejects(writeImmutableArtifact(root, {
      executionId,
      viewport: "desktop",
      flow: "Open Loop detail",
      kind: "screenshot",
      mediaType: "image/png",
      content: png,
    }), /visual_qa_artifact_ref_escape|visual_qa_artifact_no_follow|visual_qa_artifact_parent_symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
