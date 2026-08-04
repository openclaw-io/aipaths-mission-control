#!/usr/bin/env node
import pg from "pg";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  aggregateVisualQaFindings,
  assertAgentBrowserPinned,
  assertBrowserUrlAtPreviewOrigin,
  assertMissionControlAppRole,
  buildAgentBrowserArgs,
  buildAgentBrowserSessionId,
  buildAgentBrowserUtilityArgs,
  buildHermesPlannerArgs,
  buildVisualQaInstallEnv,
  buildVisualQaPreviewEnv,
  cleanVisualQaChildEnv,
  createDetachedProcessGroupRegistry,
  createExactPreviewProxy,
  createHermesPlannerSessionAudit,
  createVisualQaHeartbeat,
  createVisualQaLifecycleGuard,
  DEFAULT_ARTIFACT_ROOT,
  defaultAgentBrowserBin,
  hashVisualQaResult,
  installVisualQaSignalHandlers,
  isDetachedProcessGroupAlive,
  makeTreeWritable,
  MAX_VISUAL_QA_ACTIONS,
  MAX_VISUAL_QA_BROWSER_MS,
  MAX_VISUAL_QA_COMBINATIONS,
  MAX_VISUAL_QA_HERMES_MS,
  parseVisualHermesOutput,
  prepareVisualQaTargetTrees,
  readQaCapabilityOnce,
  remapQaTargetUrl,
  resolveAgentBrowserExecutable,
  runVisualQaAllSettledSteps,
  runVisualQaDeadlinePhase,
  sanitizeVisualQaFinish,
  sanitizeVisualQaObservation,
  terminateDetachedProcessGroup,
  runVisualQaCleanup,
  validatePlannerActionForPreview,
  validatePlannerAction,
  VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS,
  VISUAL_QA_CLEANUP_RESERVE_MS,
  VISUAL_QA_FLOW_BUDGET_MS,
  VISUAL_QA_STARTUP_BUDGET_MS,
  VISUAL_QA_STARTUP_PHASE_BUDGETS_MS,
  visualQaErrorCode,
  visualQaRemainingWorkBudgetMs,
  writeImmutableArtifact,
} from "./lib/visual-qa-runtime.mjs";
import { git, runBounded as baseRunBounded } from "./lib/reviewer-runtime.mjs";
import { startDisposablePreviewDatabase } from "./lib/disposable-preview-postgres.mjs";

const DEFAULT_DB = "postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local";
const HERMES_VISUAL_QA_MODEL = "gpt-5.6-sol";
const HERMES_VISUAL_QA_PROVIDER = "openai-codex";
const executionId = process.argv[2] || "";
if (!/^[0-9a-f-]{36}$/i.test(executionId) || process.argv.length !== 3) {
  process.stderr.write(`${JSON.stringify({ level: "error", event: "visual_qa.invalid_execution_id" })}\n`);
  process.exit(2);
}

const log = (level, event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ level, event, execution_id: executionId, ...fields })}\n`);
};

const pool = new pg.Pool({
  connectionString: process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_DB,
  max: 1,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
});
let temp = null;
let sourceWorktree = null;
let previewDir = null;
let repositoryRoot = null;
let preview = null;
let disposablePreviewDatabase = null;
let browserSession = null;
let browserExecutable = null;
let browserNetwork = null;
let exactPreviewProxy = null;
let capability = null;
let row = null;
let hermesSessionId = null;
let previewHome = null;
let previewTmp = null;
let browserHome = null;
let browserTmp = null;
let browserSocketDir = null;
let hermesChildHome = null;
let hermesChildTmp = null;
let plannerAudit = null;
let heartbeat = null;
let lifecycleGuard = null;
let heartbeatGuardEnabled = true;
let executionDeadlineMs = null;
let executionDeadlineTimer = null;
const lifecycleAbort = new AbortController();
const processGroups = createDetachedProcessGroupRegistry();

function guardHeartbeat(promise) {
  if (!lifecycleGuard || !heartbeatGuardEnabled) return Promise.resolve(promise);
  return lifecycleGuard.guard(promise);
}

function runBounded(file, args, options = {}) {
  let boundedOptions = options;
  if (heartbeatGuardEnabled && Number.isFinite(executionDeadlineMs)) {
    const remainingMs = Math.floor(executionDeadlineMs - Date.now());
    if (remainingMs < 1_000) return Promise.reject(new Error("visual_qa_execution_deadline_exhausted"));
    boundedOptions = {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? 15 * 60_000, remainingMs),
    };
  }
  boundedOptions = {
    ...boundedOptions,
    signal: boundedOptions.signal || (heartbeatGuardEnabled ? lifecycleAbort.signal : undefined),
  };
  const command = !boundedOptions.detachedProcessGroup
    ? baseRunBounded(file, args, boundedOptions)
    : baseRunBounded(file, args, {
      ...boundedOptions,
      onSpawn: (pid) => {
        processGroups.track(pid);
        boundedOptions.onSpawn?.(pid);
      },
      onSettled: (pid) => {
        processGroups.untrack(pid);
        boundedOptions.onSettled?.(pid);
      },
    });
  return guardHeartbeat(command);
}

function guardedGit(root, args, options = {}) {
  return guardHeartbeat(git(root, args, {
    ...options,
    signal: options.signal || lifecycleAbort.signal,
  }));
}

function runPhase(name, budgetMs, operation) {
  if (!Number.isFinite(executionDeadlineMs) || !Number.isInteger(budgetMs) || budgetMs < 1) {
    return Promise.reject(new Error("visual_qa_phase_deadline_invalid"));
  }
  const deadlineMs = Math.min(executionDeadlineMs, Date.now() + budgetMs);
  return guardHeartbeat(runVisualQaDeadlinePhase(name, operation, {
    deadlineMs,
    signal: lifecycleAbort.signal,
    onDeadline: () => lifecycleAbort.abort(new Error(`visual_qa_${name}_deadline_exceeded`)),
  }));
}

function assertExecutionBudget(neededMs = 0) {
  if (!Number.isFinite(executionDeadlineMs) || executionDeadlineMs - Date.now() < neededMs) {
    throw new Error("visual_qa_execution_deadline_exhausted");
  }
}

function throwIfLifecycleAborted(signal = lifecycleAbort.signal) {
  if (signal?.aborted) throw new Error("visual_qa_lifecycle_aborted");
}

function abortable(promise, signal = lifecycleAbort.signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new Error("visual_qa_lifecycle_aborted"));
  return new Promise((resolveValue, rejectValue) => {
    const onAbort = () => rejectValue(new Error("visual_qa_lifecycle_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolveValue, rejectValue).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function sleep(ms, signal = lifecycleAbort.signal) {
  return abortable(new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), signal);
}

async function reserveLoopbackPort(signal = lifecycleAbort.signal) {
  throwIfLifecycleAborted(signal);
  const server = createServer();
  server.unref();
  await abortable(new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  }), signal).catch(async (error) => {
    await new Promise((resolveClose) => server.close(resolveClose)).catch(() => {});
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("visual_qa_preview_port_reservation_failed");
  }
  return {
    port: address.port,
    release: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function sandboxLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueAbsolutePaths(paths) {
  return [...new Set(paths.filter((value) => typeof value === "string" && value.startsWith("/")))];
}

function buildPreviewSandboxPolicy({
  writablePaths,
  deniedWritePaths,
  denyNetworkOutbound = false,
  disposableDatabasePort,
}) {
  const writable = uniqueAbsolutePaths(writablePaths);
  const denied = uniqueAbsolutePaths(deniedWritePaths);
  if (writable.length === 0 || denied.length === 0) throw new Error("visual_qa_sandbox_policy_invalid");
  if (denyNetworkOutbound
    && (!Number.isInteger(disposableDatabasePort) || disposableDatabasePort < 1024 || disposableDatabasePort > 65_535
      || disposableDatabasePort === 5432)) {
    throw new Error("visual_qa_sandbox_database_port_invalid");
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...(denyNetworkOutbound ? [
      "(deny network-outbound)",
      `(allow network-outbound (remote ip "localhost:${disposableDatabasePort}"))`,
    ] : []),
    ...writable.map((path) => `(allow file-write* (subpath "${sandboxLiteral(path)}"))`),
    ...denied.map((path) => `(deny file-write* (subpath "${sandboxLiteral(path)}"))`),
    "",
  ].join("\n");
}

async function writePreviewSandboxPolicy(policyPath, config) {
  if (process.platform !== "darwin") throw new Error("visual_qa_sandbox_unsupported");
  const policy = buildPreviewSandboxPolicy(config);
  await writeFile(policyPath, policy, { encoding: "utf8", mode: 0o600 });
  return policyPath;
}

function sandboxedCommand(policyPath, file, args) {
  if (process.platform !== "darwin") throw new Error("visual_qa_sandbox_unsupported");
  if (typeof policyPath !== "string" || !policyPath.startsWith("/")) throw new Error("visual_qa_sandbox_policy_invalid");
  return { file: "/usr/bin/sandbox-exec", args: ["-f", policyPath, file, ...args] };
}

async function assertSandboxWriteDenied(policyPath, deniedWritePaths, { cwd, env }) {
  if (process.platform !== "darwin") throw new Error("visual_qa_sandbox_unsupported");
  await runBounded("/usr/bin/sandbox-exec", ["-f", policyPath, "/usr/bin/true"], {
    cwd,
    env,
    timeoutMs: 10_000,
    maxBytes: 16_384,
  }).catch((error) => {
    throw new Error(`visual_qa_sandbox_unavailable:${error instanceof Error ? error.message : "unknown"}`);
  });
  for (const deniedPath of uniqueAbsolutePaths(deniedWritePaths)) {
    let createdProbeRoot = false;
    try {
      await realpath(deniedPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(deniedPath, { recursive: true, mode: 0o700 });
      createdProbeRoot = true;
    }
    const marker = join(deniedPath, `.mc-visual-qa-sandbox-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      const probe = await runBounded("/usr/bin/sandbox-exec", ["-f", policyPath, "/bin/sh", "-c",
        'if /usr/bin/touch "$1" 2>/dev/null; then /bin/rm -f "$1" 2>/dev/null; /bin/echo WRITE_ALLOWED; else /bin/echo WRITE_DENIED; fi',
        "visual-qa-sandbox-probe", marker], {
        cwd,
        env,
        timeoutMs: 10_000,
        maxBytes: 16_384,
      });
      const outcome = probe.stdout.trim();
      if (outcome === "WRITE_DENIED") continue;
      if (outcome === "WRITE_ALLOWED") throw new Error(`visual_qa_sandbox_write_probe_allowed:${deniedPath}`);
      throw new Error(`visual_qa_sandbox_write_probe_inconclusive:${deniedPath}`);
    } finally {
      if (createdProbeRoot) await rm(deniedPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function assertSandboxNetworkDenied(policyPath, { cwd, env, disposableDatabasePort }) {
  if (!Number.isInteger(disposableDatabasePort)) throw new Error("visual_qa_sandbox_database_port_invalid");
  await runBounded("/usr/bin/sandbox-exec", [
    "-f", policyPath, "/usr/bin/nc", "-z", "127.0.0.1", String(disposableDatabasePort),
  ], {
    cwd, env, timeoutMs: 5_000, maxBytes: 16_384,
  }).catch((error) => {
    throw new Error(`visual_qa_database_network_probe_denied:${error instanceof Error ? error.message : "unknown"}`);
  });

  const listener = await reserveLoopbackPort();
  try {
    await runBounded("/usr/bin/nc", ["-z", "127.0.0.1", String(listener.port)], {
      cwd, env, timeoutMs: 5_000, maxBytes: 16_384,
    }).catch((error) => {
      throw new Error(`visual_qa_network_probe_unavailable:${error instanceof Error ? error.message : "unknown"}`);
    });
    let denied = false;
    try {
      await runBounded("/usr/bin/sandbox-exec", ["-f", policyPath, "/usr/bin/nc", "-z", "127.0.0.1", String(listener.port)], {
        cwd, env, timeoutMs: 5_000, maxBytes: 16_384,
      });
    } catch {
      denied = true;
    }
    if (!denied) throw new Error("visual_qa_sandbox_network_probe_allowed");
  } finally {
    await listener.release().catch(() => {});
  }
}

function previewExitError(exit) {
  return new Error(`visual_qa_preview_process_exited:${exit.code ?? exit.signal ?? "unknown"}`);
}

async function waitForPreview(origin, { childPid, getExit, stderrText }, timeoutMs = 60_000, signal = lifecycleAbort.signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfLifecycleAborted(signal);
    const exit = getExit();
    if (exit) throw previewExitError(exit);
    if (/EADDRINUSE/i.test(stderrText())) throw new Error("visual_qa_preview_eaddrinuse");
    if (!isDetachedProcessGroupAlive(childPid)) throw new Error("visual_qa_preview_early_exit");
    try {
      const response = await fetch(origin, { signal: AbortSignal.any([AbortSignal.timeout(2_000), signal]) });
      if (response.status < 500) return;
    } catch {
      throwIfLifecycleAborted(signal);
      await sleep(500, signal);
    }
  }
  throw new Error("visual_qa_preview_start_timeout");
}

async function assertPreviewStillAlive(childPid, getExit, stderrText, signal = lifecycleAbort.signal) {
  await sleep(750, signal);
  const exit = getExit();
  if (exit) throw previewExitError(exit);
  if (/EADDRINUSE/i.test(stderrText())) throw new Error("visual_qa_preview_eaddrinuse");
  if (!isDetachedProcessGroupAlive(childPid)) throw new Error("visual_qa_preview_early_exit");
}

async function startPreview(repositoryKey, cwd, {
  home,
  tmpdir,
  databaseUrl,
  disposableDatabasePort,
  installSandboxPolicyPath,
  runtimeSandboxPolicyPath,
  deniedWritePaths,
  signal = lifecycleAbort.signal,
}) {
  throwIfLifecycleAborted(signal);
  if (repositoryKey !== "aipaths-mission-control") throw new Error("visual_qa_repository_key_unsupported");
  const installEnv = buildVisualQaInstallEnv({ home, tmpdir });
  const previewEnv = buildVisualQaPreviewEnv({ home, tmpdir, databaseUrl });
  const npmCache = join(home, "npm-cache");
  await assertSandboxWriteDenied(installSandboxPolicyPath, deniedWritePaths, { cwd, env: installEnv });
  await assertSandboxWriteDenied(runtimeSandboxPolicyPath, deniedWritePaths, { cwd, env: previewEnv });
  await assertSandboxNetworkDenied(runtimeSandboxPolicyPath, { cwd, env: previewEnv, disposableDatabasePort });
  const npmCi = sandboxedCommand(installSandboxPolicyPath, "/usr/bin/env", [
    "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache,
  ]);
  await runBounded(npmCi.file, npmCi.args, {
    cwd,
    env: installEnv,
    timeoutMs: 5 * 60_000,
    maxBytes: 512 * 1024,
    detachedProcessGroup: true,
  });
  const npmRebuild = sandboxedCommand(runtimeSandboxPolicyPath, "/usr/bin/env", [
    "npm", "rebuild", "--offline", "--no-audit", "--no-fund", "--cache", npmCache,
  ]);
  await runBounded(npmRebuild.file, npmRebuild.args, {
    cwd,
    env: previewEnv,
    timeoutMs: 5 * 60_000,
    maxBytes: 512 * 1024,
    detachedProcessGroup: true,
  });
  const npmBuild = sandboxedCommand(runtimeSandboxPolicyPath, "/usr/bin/env", [
    "npm", "--offline", "--cache", npmCache, "run", "build",
  ]);
  await runBounded(npmBuild.file, npmBuild.args, {
    cwd,
    env: previewEnv,
    timeoutMs: 10 * 60_000,
    maxBytes: 1024 * 1024,
    detachedProcessGroup: true,
  });
  let reservation = await reserveLoopbackPort(signal);
  const port = reservation.port;
  const nextBin = join(cwd, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  let child = null;
  let exit = null;
  let stderr = "";
  try {
    await abortable(reservation.release(), signal);
    reservation = null;
    const nextStart = sandboxedCommand(runtimeSandboxPolicyPath, nextBin, ["start", "-H", "127.0.0.1", "-p", String(port)]);
    child = spawn(nextStart.file, nextStart.args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...previewEnv, NODE_ENV: "production" },
    });
    child.once("exit", (code, signal) => { exit = { code, signal }; });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).slice(0, 500);
      stderr += text;
      if (stderr.length > 8_192) stderr = stderr.slice(-8_192);

    });
    await abortable(once(child, "spawn"), signal);
    child.unref();
    if (!child.pid) throw new Error("visual_qa_preview_pid_missing");
    processGroups.track(child.pid);
    const origin = `http://127.0.0.1:${port}`;
    await waitForPreview(origin, { childPid: child.pid, getExit: () => exit, stderrText: () => stderr }, 60_000, signal);
    await assertPreviewStillAlive(child.pid, () => exit, () => stderr, signal);
    return { child, origin };
  } catch (error) {
    if (reservation) await reservation.release().catch(() => {});
    if (child?.pid) {
      await terminateDetachedProcessGroup(child.pid).catch(() => {});
      if (!isDetachedProcessGroupAlive(child.pid)) processGroups.untrack(child.pid);
    }
    throw error;
  }
}

function policyFromRow(data) {
  const payloadPolicy = data.work_payload?.qa_policy;
  const frozenPolicy = data.task_metadata?.qa_policy;
  if (!payloadPolicy?.required || !frozenPolicy?.required
    || JSON.stringify(payloadPolicy) !== JSON.stringify(frozenPolicy)
    || data.work_payload?.policy_hash !== data.policy_hash) {
    throw new Error("visual_qa_policy_identity_mismatch");
  }
  const combinations = frozenPolicy.viewports.length * Math.max(1, frozenPolicy.flows.length);
  if (combinations < 1 || combinations > MAX_VISUAL_QA_COMBINATIONS) {
    throw new Error("visual_qa_policy_runtime_budget_exceeded");
  }
  return frozenPolicy;
}

function assertExecutionState(data, token) {
  const suppliedHash = createHash("sha256").update(token).digest();
  const storedHash = Buffer.from(data.capability_hash);
  if (data.status !== "running" || data.qa_run_status !== "running" || data.run_role !== "qa"
    || data.work_status !== "in_progress" || data.task_status !== "qa_pending" || data.loop_status !== "in_progress"
    || data.implementation_status !== "succeeded" || data.implementation_sha !== data.target_sha
    || data.review_status !== "approved" || data.reviewed_sha !== data.target_sha
    || data.implementer_session_id === data.reviewer_session_id
    || data.capability_consumed_at || data.capability_revoked_at
    || storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)
    || new Date(data.capability_expires_at).getTime() <= Date.now()) {
    throw new Error("visual_qa_execution_state_conflict");
  }
}

async function complete(result) {
  if (!capability || !row) return;
  if (result.verdict !== "infrastructure_failure" && (!plannerAudit?.bound || !hermesSessionId)) {
    throw new Error("visual_qa_planner_session_unbound");
  }
  const resultHash = hashVisualQaResult(result);
  const completion = await fetch(`http://127.0.0.1:3001/api/qa/executions/${executionId}/complete`, {
    method: "POST",
    headers: { authorization: `QaCapability ${capability}`, "content-type": "application/json" },
    body: JSON.stringify({
      session_id: row.qa_session_id,
      execution_attempt_id: row.execution_attempt_id,
      target_sha: row.target_sha,
      policy_hash: row.policy_hash,
      result_hash: resultHash,
      result,
    }),
    signal: AbortSignal.timeout(VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS),
  });
  if (!completion.ok) throw new Error(`visual_qa_completion_http_${completion.status}`);
}

async function runBrowser(agentBrowser, action, options = {}) {
  const args = Array.isArray(action) ? action : buildAgentBrowserArgs(browserSession, action, browserNetwork);
  return runBounded(agentBrowser, args, {
    cwd: options.cwd,
    env: cleanVisualQaChildEnv({
      HOME: browserHome,
      TMPDIR: browserTmp,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "30000",
      AGENT_BROWSER_SOCKET_DIR: browserSocketDir,
      AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable,
    }, { allowHermes: false }),
    timeoutMs: options.timeoutMs || MAX_VISUAL_QA_BROWSER_MS,
    maxBytes: options.maxBytes || 256 * 1024,
    signal: options.signal,
  });
}

async function assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, cwd) {
  const current = await runBrowser(agentBrowser,
    buildAgentBrowserUtilityArgs(browserSession, "current-url", [], browserNetwork), { cwd, maxBytes: 16 * 1024 });
  return assertBrowserUrlAtPreviewOrigin(current.stdout.trim(), previewOrigin);
}

async function planAction({ hermes, hermesHome, profile, model, provider, prompt, imagePath, launcherDir }) {
  const args = buildHermesPlannerArgs({ prompt, model, provider, imagePath, sessionId: hermesSessionId });
  const startedAfter = Date.now() / 1000;
  const result = await runBounded(hermes, args, {
    cwd: launcherDir,
    env: cleanVisualQaChildEnv({
      HOME: hermesChildHome,
      TMPDIR: hermesChildTmp,
      HERMES_HOME: hermesHome,
      HERMES_PROFILE: profile,
    }),
    maxBytes: 256 * 1024,
    timeoutMs: MAX_VISUAL_QA_HERMES_MS,
    detachedProcessGroup: true,
  });
  const finishedBefore = Date.now() / 1000;
  const parsed = parseVisualHermesOutput(result.stdout, result.stderr);
  if (hermesSessionId && hermesSessionId !== parsed.sessionId) throw new Error("visual_qa_hermes_session_changed");
  await plannerAudit.verify({ sessionId: parsed.sessionId, startedAfter, finishedBefore });
  hermesSessionId = parsed.sessionId;
  return parsed.action;
}

function plannerPrompt({ targetUrl, policy, viewport, flow, snapshot, step, diagnostics, redactionSecrets }) {
  const observation = sanitizeVisualQaObservation({ snapshot, diagnostics, secrets: redactionSecrets });
  return [
    "You are a visual action planner for Mission Control QA.",
    "You do not have tools. You only return one strict JSON object matching one of these action schemas:",
    '{"action":"open","url":"http://127.0.0.1:<port>/path?query"}',
    '{"action":"snapshot"}',
    '{"action":"click","ref":"@e1"}',
    '{"action":"fill","ref":"@e1","text":"value"}',
    '{"action":"type","text":"value"}',
    '{"action":"press","key":"Enter"}',
    '{"action":"scroll","direction":"down","amount":400}',
    '{"action":"wait","ms":250}',
    '{"action":"finish","verdict":"pass","summary":"concise evidence summary","findings":[]}',
    '{"action":"finish","verdict":"changes","summary":"concise evidence summary","findings":[{"title":"Issue","evidence":"Visual evidence","recommendation":"Fix"}]}',
    "Never include extra keys. Never request network or credentials. Target is loopback only.",
    `Target URL: ${targetUrl}`,
    `Viewport: ${viewport.name} ${viewport.width}x${viewport.height}`,
    `Flow: ${flow || "(viewport-only)"}`,
    `Step: ${step}/${MAX_VISUAL_QA_ACTIONS}`,
    `Frozen policy: ${JSON.stringify(policy)}`,
    `Snapshot summary: ${observation.snapshot}`,
    `Diagnostics: ${JSON.stringify(observation.diagnostics)}`,
  ].join("\n");
}

async function runFlow({
  agentBrowser,
  artifactRoot,
  policy,
  targetUrl,
  viewport,
  flow,
  launcherDir,
  hermesConfig,
  redactionSecrets,
}) {
  const previewOrigin = new URL(targetUrl).origin;
  await runBrowser(agentBrowser, buildAgentBrowserUtilityArgs(browserSession, "set-viewport", [viewport.width, viewport.height], browserNetwork), { cwd: launcherDir });
  await runBrowser(agentBrowser, { action: "open", url: targetUrl }, { cwd: launcherDir });
  await runBrowser(agentBrowser, { action: "wait", ms: 500 }, { cwd: launcherDir });
  await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
  let finalAction = null;
  let latestSnapshot = "";
  const diagnostics = [];
  for (let step = 1; step <= MAX_VISUAL_QA_ACTIONS; step += 1) {
    const stepShot = join(launcherDir, `step-${viewport.name}-${step}.png`);
    await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
    await runBrowser(agentBrowser, buildAgentBrowserUtilityArgs(browserSession, "screenshot", [stepShot], browserNetwork), { cwd: launcherDir });
    await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
    const snapshot = await runBrowser(agentBrowser, { action: "snapshot" }, { cwd: launcherDir, maxBytes: 512 * 1024 });
    await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
    latestSnapshot = sanitizeVisualQaObservation({
      snapshot: snapshot.stdout,
      diagnostics: [],
      secrets: redactionSecrets,
    }).snapshot;
    try {
      const consoleOutput = await runBrowser(agentBrowser, buildAgentBrowserUtilityArgs(browserSession, "console", [], browserNetwork), {
        cwd: launcherDir,
        maxBytes: 128 * 1024,
      });
      diagnostics.push(...sanitizeVisualQaObservation({
        snapshot: "",
        diagnostics: [{ step, kind: "console", output: consoleOutput.stdout }],
        secrets: redactionSecrets,
      }).diagnostics);
    } catch {
      diagnostics.push({ step, kind: "console_capture_error", error: "visual_qa_console_capture_failed" });
    }
    const action = await planAction({
      ...hermesConfig,
      prompt: plannerPrompt({
        targetUrl, policy, viewport, flow, snapshot: latestSnapshot, step, diagnostics, redactionSecrets,
      }),
      imagePath: stepShot,
      launcherDir,
    });
    validatePlannerActionForPreview(action, previewOrigin);
    if (action.action === "finish") {
      finalAction = sanitizeVisualQaFinish(action, redactionSecrets);
      break;
    }
    validatePlannerAction(action);
    await runBrowser(agentBrowser, action, { cwd: launcherDir });
    await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
  }
  if (!finalAction) throw new Error("visual_qa_action_budget_exhausted");
  const finalPng = join(launcherDir, `final-${viewport.name}-${flow ? "flow" : "viewport"}.png`);
  await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
  await runBrowser(agentBrowser, buildAgentBrowserUtilityArgs(browserSession, "screenshot", [finalPng], browserNetwork), { cwd: launcherDir });
  await assertBrowserAtPreviewOrigin(agentBrowser, previewOrigin, launcherDir);
  const artifactObservation = sanitizeVisualQaObservation({
    snapshot: latestSnapshot,
    diagnostics,
    secrets: redactionSecrets,
  });
  const [descriptor, summaryDescriptor] = await runPhase("artifact", MAX_VISUAL_QA_BROWSER_MS, async ({ signal }) => {
    const screenshot = await writeImmutableArtifact(artifactRoot, {
      executionId, viewport: viewport.name, flow, kind: "screenshot", mediaType: "image/png",
      content: await readFile(finalPng, { signal }), signal,
    });
    const summary = await writeImmutableArtifact(artifactRoot, {
      executionId, viewport: viewport.name, flow, kind: "log", mediaType: "application/json",
      content: Buffer.from(JSON.stringify({
        ...artifactObservation,
        finish: sanitizeVisualQaFinish(finalAction, redactionSecrets),
      }), "utf8"),
      signal,
    });
    return [screenshot, summary];
  });
  return { finish: finalAction, evidence: [descriptor, summaryDescriptor] };
}

async function assertPathRemoved(path, code) {
  if (!path) return;
  try {
    await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(code);
  }
  throw new Error(code);
}

const cleanupResources = runVisualQaCleanup({
  browser: async () => {
    if (!browserSession) return;
    const agentBrowser = process.env.AGENT_BROWSER_BIN || defaultAgentBrowserBin(process.cwd());
    await runBounded(agentBrowser, buildAgentBrowserUtilityArgs(browserSession, "close", [], browserNetwork), {
      env: cleanVisualQaChildEnv({
        HOME: browserHome,
        TMPDIR: browserTmp,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "1000",
        AGENT_BROWSER_SOCKET_DIR: browserSocketDir,
        AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable,
      }, { allowHermes: false }),
      timeoutMs: 10_000,
      maxBytes: 16_384,
    });
    browserSession = null;
  },
  preview: async () => {
    if (!preview?.child?.pid) return;
    const pid = preview.child.pid;
    await terminateDetachedProcessGroup(pid);
    if (isDetachedProcessGroupAlive(pid)) throw new Error("visual_qa_preview_cleanup_failed");
    processGroups.untrack(pid);
    preview = null;
  },
  proxy: async () => {
    if (!exactPreviewProxy?.close) return;
    await exactPreviewProxy.close({ timeoutMs: 5_000 });
    exactPreviewProxy = null;
    browserNetwork = null;
  },
  postgres: async () => {
    if (!disposablePreviewDatabase?.stop) return;
    await disposablePreviewDatabase.stop();
    disposablePreviewDatabase = null;
  },
  worktree: async () => {
    if (!sourceWorktree || !repositoryRoot) return;
    const registered = () => git(repositoryRoot, ["worktree", "list", "--porcelain"], { timeoutMs: 60_000 });
    let listing = (await registered()).stdout;
    if (listing.split(/\r?\n/).includes(`worktree ${sourceWorktree}`)) {
      await makeTreeWritable(sourceWorktree).catch(() => {});
      await git(repositoryRoot, ["worktree", "remove", "--force", sourceWorktree], { timeoutMs: 60_000 });
      await git(repositoryRoot, ["worktree", "prune"], { timeoutMs: 60_000 });
      listing = (await registered()).stdout;
    }
    if (listing.split(/\r?\n/).includes(`worktree ${sourceWorktree}`)) {
      throw new Error("visual_qa_worktree_cleanup_failed");
    }
    sourceWorktree = null;
  },
  temp: async () => {
    if (!temp) return;
    const path = temp;
    await rm(path, { recursive: true, force: true });
    await assertPathRemoved(path, "visual_qa_temp_cleanup_failed");
    temp = null;
  },
  socket: async () => {
    if (!browserSocketDir) return;
    const path = browserSocketDir;
    await rm(path, { recursive: true, force: true });
    await assertPathRemoved(path, "visual_qa_socket_cleanup_failed");
    browserSocketDir = null;
  },
});

let fullCleanupPromise = null;
let processGroupCleanupPromise = null;
const cleanupProcessGroups = () => {
  processGroupCleanupPromise ||= processGroups.terminateAll()
    .finally(() => { processGroupCleanupPromise = null; });
  return processGroupCleanupPromise;
};
const cleanupAll = (failureCode = "visual_qa_signal_cleanup_failed") => {
  fullCleanupPromise ||= runVisualQaAllSettledSteps([
    async () => {
      heartbeatGuardEnabled = false;
      await heartbeat?.stop();
    },
    () => cleanupProcessGroups(),
    () => cleanupResources(),
    () => pool.end(),
  ], failureCode).finally(() => { fullCleanupPromise = null; });
  return fullCleanupPromise;
};
const signalCoordinator = installVisualQaSignalHandlers({
  controller: lifecycleAbort,
  cleanup: () => cleanupAll("visual_qa_signal_cleanup_failed"),
});

let terminalResult = null;

try {
  capability = await readQaCapabilityOnce();
  await assertMissionControlAppRole(pool);
  const result = await pool.query(
    `select e.*,qr.status qa_run_status,qr.run_role,qr.repository_id,qr.base_sha,
        wi.status work_status,wi.payload work_payload,t.status task_status,t.metadata task_metadata,
        s.plan_revision_id,p.content_hash plan_hash,p.status revision_status,l.current_plan_revision_id,l.status loop_status,
        impl.status implementation_status,impl.artifact_sha implementation_sha,impl.server_session_id implementer_session_id,
        d.status review_status,d.reviewer_session_id,d.reviewed_sha,
        repo.key repository_key,repo.canonical_root,repo.git_common_dir,repo.object_format,repo.enabled repository_enabled
      from qa_executions e join loop_task_runs qr on qr.id=e.qa_run_id and qr.task_id=e.task_id
      join work_items wi on wi.id=e.work_item_id join loop_tasks t on t.id=e.task_id
      join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
      join loops l on l.id=p.loop_id join loop_task_runs impl on impl.id=e.target_run_id and impl.task_id=e.task_id
      join loop_task_reviews d on d.task_id=e.task_id and d.task_run_id=e.target_run_id and d.quality_cycle=qr.quality_cycle
      join review_repositories repo on repo.id=qr.repository_id
      where e.id=$1`, [executionId],
  );
  if (result.rows.length !== 1) throw new Error("visual_qa_execution_not_found");
  row = result.rows[0];
  assertExecutionState(row, capability);
  executionDeadlineMs = new Date(row.capability_expires_at).getTime()
    - VISUAL_QA_CLEANUP_RESERVE_MS
    - VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS;
  const executionDeadlineDelayMs = Math.max(1, executionDeadlineMs - Date.now());
  executionDeadlineTimer = setTimeout(() => {
    lifecycleAbort.abort(new Error("visual_qa_execution_deadline_exhausted"));
  }, executionDeadlineDelayMs);
  heartbeat = createVisualQaHeartbeat({
    beat: async () => {
      const beat = await pool.query(
        "select heartbeat_visual_qa_execution($1,$2) heartbeat_at",
        [executionId, capability],
      );
      if (beat.rowCount !== 1 || !beat.rows[0]?.heartbeat_at) {
        throw new Error("visual_qa_execution_no_longer_running");
      }
    },
  });
  lifecycleGuard = createVisualQaLifecycleGuard({ heartbeat, controller: lifecycleAbort });
  await heartbeat.start();
  const policy = policyFromRow(row);
  const flows = policy.flows.length ? policy.flows : [null];
  const combinations = policy.viewports.length * flows.length;
  assertExecutionBudget(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_BUDGET_MS,
    remainingCombinations: combinations,
  }));
  let gitCommonDir;
  await runPhase("repository", VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.repository, async ({ signal }) => {
    throwIfLifecycleAborted(signal);
    if (!row.repository_enabled) throw new Error("visual_qa_repository_disabled");
    repositoryRoot = await realpath(row.canonical_root);
    const [actualRoot, actualCommon, objectFormat] = await Promise.all([
      guardedGit(repositoryRoot, ["rev-parse", "--show-toplevel"], { signal }),
      guardedGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
      guardedGit(repositoryRoot, ["rev-parse", "--show-object-format"], { signal }),
    ]);
    gitCommonDir = await realpath(row.git_common_dir);
    if (await realpath(actualRoot.stdout.trim()) !== repositoryRoot
      || await realpath(actualCommon.stdout.trim()) !== gitCommonDir
      || objectFormat.stdout.trim() !== row.object_format) throw new Error("visual_qa_repository_identity_mismatch");
    if ((await guardedGit(repositoryRoot, ["cat-file", "-t", row.target_sha], { signal })).stdout.trim() !== "commit") {
      throw new Error("visual_qa_target_not_commit");
    }
  });
  assertExecutionBudget(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_BUDGET_MS - VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.repository,
    remainingCombinations: combinations,
  }));

  let launcherDir;
  let detachedSourceWorktree;
  await runPhase("target", VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.target, async ({ signal }) => {
    temp = await realpath(await mkdtemp(join(tmpdir(), "mc-visual-qa-")));
    browserSocketDir = await realpath(await mkdtemp(join(await realpath("/tmp"), "mc-vqa-ab-")));
    launcherDir = join(temp, "launcher");
    previewHome = join(temp, "preview-home");
    previewTmp = join(temp, "preview-tmp");
    browserHome = join(temp, "browser-home");
    browserTmp = join(temp, "browser-tmp");
    hermesChildHome = join(temp, "hermes-child-home");
    hermesChildTmp = join(temp, "hermes-child-tmp");
    for (const path of [launcherDir, previewHome, previewTmp, browserHome, browserTmp, hermesChildHome, hermesChildTmp]) {
      throwIfLifecycleAborted(signal);
      await mkdir(path, { mode: 0o700 });
    }
    const prepared = await prepareVisualQaTargetTrees({
      repositoryRoot, targetSha: row.target_sha, tempDir: temp, git: guardedGit, signal,
    });
    sourceWorktree = prepared.sourceWorktree;
    previewDir = prepared.previewDir;
    detachedSourceWorktree = prepared.detachedSourceWorktree || prepared.sourceWorktree;
  });
  assertExecutionBudget(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.postgres
      + VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.preview
      + VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.browser,
    remainingCombinations: combinations,
  }));
  await runPhase("postgres", VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.postgres, async ({ signal }) => {
    const trustedSchemaPath = await realpath(fileURLToPath(new URL("../ops/local-postgres/schema.sql", import.meta.url)));
    disposablePreviewDatabase = await startDisposablePreviewDatabase({
      rootDir: temp, schemaPath: trustedSchemaPath, processGroups, signal,
    });
  });
  const redactionSecrets = disposablePreviewDatabase.targetSecrets;
  assertExecutionBudget(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.preview
      + VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.browser,
    remainingCombinations: combinations,
  }));
  const disposableDatabasePort = disposablePreviewDatabase.port;
  let artifactRoot;
  let targetUrl;
  await runPhase("preview", VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.preview, async ({ signal }) => {
    artifactRoot = process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT;
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    artifactRoot = await realpath(artifactRoot);
    const deniedWritePaths = [artifactRoot, repositoryRoot, gitCommonDir, detachedSourceWorktree];
    const sandboxPolicyConfig = {
      writablePaths: [previewDir, previewHome, previewTmp], deniedWritePaths,
    };
    const installSandboxPolicyPath = await writePreviewSandboxPolicy(
      join(temp, "preview-install.sbpl"), sandboxPolicyConfig,
    );
    const runtimeSandboxPolicyPath = await writePreviewSandboxPolicy(join(temp, "preview-runtime.sbpl"), {
      ...sandboxPolicyConfig, denyNetworkOutbound: true, disposableDatabasePort,
    });
    preview = await startPreview(row.repository_key, previewDir, {
      home: previewHome, tmpdir: previewTmp,
      databaseUrl: disposablePreviewDatabase.databaseUrl,
      disposableDatabasePort, installSandboxPolicyPath, runtimeSandboxPolicyPath,
      deniedWritePaths, signal,
    });
    exactPreviewProxy = await createExactPreviewProxy({
      upstreamOrigin: preview.origin, randomHex: randomBytes(8).toString("hex"),
    });
    browserNetwork = exactPreviewProxy;
    targetUrl = remapQaTargetUrl(policy.target_url, browserNetwork.browserOrigin);
  });
  assertExecutionBudget(visualQaRemainingWorkBudgetMs({
    startupRemainingMs: VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.browser,
    remainingCombinations: combinations,
  }));
  let agentBrowser;
  let hermesConfig;
  await runPhase("browser", VISUAL_QA_STARTUP_PHASE_BUDGETS_MS.browser, async ({ signal }) => {
    agentBrowser = process.env.AGENT_BROWSER_BIN || defaultAgentBrowserBin(process.cwd());
    await assertAgentBrowserPinned(agentBrowser, runBounded);
    browserExecutable = await resolveAgentBrowserExecutable({
      home: process.env.HOME || "/Users/joaco", explicitPath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    });
    browserSession = buildAgentBrowserSessionId(randomBytes(5).toString("hex"));
    if ((process.env.HERMES_VISUAL_QA_MODEL && process.env.HERMES_VISUAL_QA_MODEL !== HERMES_VISUAL_QA_MODEL)
      || (process.env.HERMES_VISUAL_QA_PROVIDER && process.env.HERMES_VISUAL_QA_PROVIDER !== HERMES_VISUAL_QA_PROVIDER)) {
      throw new Error("visual_qa_hermes_contract_override");
    }
    hermesConfig = {
      hermes: process.env.HERMES_VISUAL_QA_BIN || "/Users/joaco/.hermes/hermes-agent/venv/bin/hermes",
      hermesHome: join(process.env.HOME || "/Users/joaco", ".hermes", "profiles", process.env.HERMES_VISUAL_QA_PROFILE || "reviewer"),
      profile: process.env.HERMES_VISUAL_QA_PROFILE || "reviewer",
      model: HERMES_VISUAL_QA_MODEL,
      provider: HERMES_VISUAL_QA_PROVIDER,
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hermesConfig.profile)) throw new Error("visual_qa_profile_invalid");
    plannerAudit = createHermesPlannerSessionAudit({
      stateDb: join(hermesConfig.hermesHome, "state.db"),
      expectedModel: HERMES_VISUAL_QA_MODEL,
      expectedProvider: HERMES_VISUAL_QA_PROVIDER,
      run: runBounded,
      bindPlannerSession: async (plannerSessionId) => {
        throwIfLifecycleAborted(signal);
        const bound = await guardHeartbeat(pool.query(
          "select bind_visual_qa_planner_session($1,$2,$3) bound",
          [executionId, plannerSessionId, capability],
        ));
        if (bound.rowCount !== 1 || bound.rows[0]?.bound !== true) throw new Error("visual_qa_planner_session_bind_failed");
      },
    });
  });
  const evidence = [];
  const viewportResults = new Map(policy.viewports.map((viewport) => [viewport.name, "pass"]));
  const flowResults = new Map(policy.flows.map((flow) => [flow, "pass"]));
  const combinationFindingGroups = [];
  let completedCombinations = 0;
  for (const viewport of policy.viewports) {
    for (const flow of flows) {
      const remainingCombinations = combinations - completedCombinations;
      assertExecutionBudget(visualQaRemainingWorkBudgetMs({
        remainingCombinations,
      }));
      const flowResult = await runPhase("combination", VISUAL_QA_FLOW_BUDGET_MS, () => runFlow({
        agentBrowser, artifactRoot, policy, targetUrl, viewport, flow, launcherDir, hermesConfig, redactionSecrets,
      }));
      completedCombinations += 1;
      evidence.push(...flowResult.evidence);
      combinationFindingGroups.push(flowResult.finish.findings);
      if (flowResult.finish.verdict === "changes") {
        viewportResults.set(viewport.name, "fail");
        if (flow) flowResults.set(flow, "fail");
      }
    }
  }
  const findings = aggregateVisualQaFindings(combinationFindingGroups);
  const verdict = findings.length ? "changes" : "pass";
  if (verdict === "pass" && evidence.filter((item) => item.kind === "screenshot").length < policy.viewports.length * flows.length) {
    throw new Error("visual_qa_pass_evidence_missing");
  }
  terminalResult = {
    verdict,
    tested_sha: row.target_sha,
    viewport_checks: policy.viewports.map((viewport) => ({
      viewport: viewport.name,
      status: viewportResults.get(viewport.name),
      details: viewportResults.get(viewport.name) === "pass" ? null : "Visual QA flow reported changes.",
    })),
    flow_checks: policy.flows.map((flow) => ({
      flow,
      status: flowResults.get(flow),
      details: flowResults.get(flow) === "pass" ? null : "Visual QA flow reported changes.",
    })),
    evidence,
    findings,
    error: null,
  };
} catch (error) {
  const message = visualQaErrorCode(error);
  log("error", "visual_qa.failed", { error: message });
  if (capability && row?.target_sha && row?.qa_session_id) {
    terminalResult = {
      verdict: "infrastructure_failure",
      tested_sha: row.target_sha,
      viewport_checks: [],
      flow_checks: [],
      evidence: [],
      findings: [],
      error: message,
    };
  }
  process.exitCode = 1;
} finally {
  heartbeatGuardEnabled = false;
  clearTimeout(executionDeadlineTimer);
  try {
    await cleanupProcessGroups();
    await cleanupResources();
  } catch (cleanupError) {
    const message = visualQaErrorCode(cleanupError);
    log("error", "visual_qa.cleanup_failed", { error: message });
    if (capability && row?.target_sha && row?.qa_session_id) {
      terminalResult = {
        verdict: "infrastructure_failure",
        tested_sha: row.target_sha,
        viewport_checks: [],
        flow_checks: [],
        evidence: [],
        findings: [],
        error: "visual_qa_cleanup_failed",
      };
    }
    process.exitCode = 1;
  }

  if (heartbeat) {
    try {
      await heartbeat.guard(Promise.resolve());
    } catch {
      if (capability && row?.target_sha && row?.qa_session_id) {
        terminalResult = {
          verdict: "infrastructure_failure",
          tested_sha: row.target_sha,
          viewport_checks: [],
          flow_checks: [],
          evidence: [],
          findings: [],
          error: "visual_qa_heartbeat_failed",
        };
      }
      process.exitCode = 1;
    }
    await heartbeat.stop();
    heartbeat = null;
  }

  if (terminalResult && signalCoordinator.canComplete()) {
    try {
      await complete(terminalResult);
      log("info", "visual_qa.completed", {
        session_id: hermesSessionId,
        verdict: terminalResult.verdict,
      });
    } catch (completeError) {
      log("error", "visual_qa.terminal_completion_failed", {
        error: visualQaErrorCode(completeError),
      });
      process.exitCode = 1;
    }
  }
  signalCoordinator.remove();
  await pool.end().catch(() => { process.exitCode = 1; });
}
