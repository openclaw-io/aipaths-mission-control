import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SECRET_PATTERNS = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github_token", /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{16,})\b/i],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["common_token", /\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,})\b/i],
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@[^\s/]+/i],
  ["credential_assignment", /(?:^|[\s+,{"'])(?:\\?["']?)(?:api[_-]?key|apikey|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|database[_-]?url|db[_-]?password|secret|password|token)(?:\\?["']?)\s*[:=]\s*(?:\\?["']?)[^\s"',}\]]{12,}/im],
];

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function cleanChildEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/Users/joaco",
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "en_US.UTF-8",
  };
  for (const key of [
    "GIT_NO_REPLACE_OBJECTS", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
    "HERMES_HOME", "HERMES_PROFILE",
  ]) {
    if (typeof extra[key] === "string") env[key] = extra[key];
  }
  return env;
}

export function runBounded(file, args, {
  cwd, env = cleanChildEnv(), maxBytes = 256 * 1024, timeoutMs = 15 * 60_000,
  heartbeat, heartbeatIntervalMs = 60_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] }; const sizes = { stdout: 0, stderr: 0 }; let settled = false; let heartbeatRunning = false;
    let timer; let heartbeatTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      if (error) reject(error); else resolve(result);
    };
    for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
      const buffer = Buffer.from(chunk); sizes[name] += buffer.length;
      if (sizes[name] > maxBytes) { child.kill("SIGKILL"); finish(new Error(`reviewer_${name}_oversize`)); return; }
      chunks[name].push(buffer);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => code === 0
      ? finish(null, { stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") })
      : finish(new Error(`reviewer_child_failed:${file}:${code ?? signal ?? "unknown"}`)));
    timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`reviewer_child_timeout:${file}`)); }, timeoutMs);
    if (typeof heartbeat === "function") {
      heartbeatTimer = setInterval(() => {
        if (settled || heartbeatRunning) return;
        heartbeatRunning = true;
        Promise.resolve().then(heartbeat).catch((error) => {
          child.kill("SIGKILL");
          finish(new Error(`reviewer_heartbeat_failed:${error instanceof Error ? error.message : "unknown"}`));
        }).finally(() => { heartbeatRunning = false; });
      }, heartbeatIntervalMs);
    }
  });
}

function gitArgs(root, args) {
  return ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.required=false", "-C", root, ...args];
}
export async function git(root, args, options = {}) {
  return runBounded("git", gitArgs(root, args), { ...options, env: cleanChildEnv({
    GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  }) });
}

function parseManifest(raw) {
  const values = raw.split("\0").filter(Boolean); const manifest = [];
  for (let i = 0; i < values.length;) {
    const status = values[i++];
    if (/^[RC]/.test(status)) manifest.push({ status, old_path: values[i++], path: values[i++] });
    else manifest.push({ status, path: values[i++] });
  }
  return manifest;
}

export async function buildPackage(row) {
  const range = `${row.base_sha}..${row.target_sha}`;
  const [diffResult, namesResult] = await Promise.all([
    git(row.canonical_root, ["diff", "--no-ext-diff", "--binary", range, "--"], { maxBytes: row.max_diff_bytes + 1 }),
    git(row.canonical_root, ["diff", "--no-ext-diff", "--name-status", "-z", range, "--"], { maxBytes: row.max_diff_bytes + 1 }),
  ]);
  const diff = diffResult.stdout;
  if (Buffer.byteLength(diff) > row.max_diff_bytes) throw new Error("review_package_diff_oversize");
  const secret = SECRET_PATTERNS.find(([, pattern]) => pattern.test(diff));
  if (secret) throw new Error(`review_package_secret_detected:${secret[0]}`);
  const value = canonical({
    schema_version: 1,
    execution: { id: row.id, review_run_id: row.review_run_id, work_item_id: row.work_item_id,
      execution_attempt_id: row.execution_attempt_id },
    repository: { key: row.repository_key, object_format: row.object_format },
    artifact: { base_sha: row.base_sha, target_sha: row.target_sha, diff_sha256: sha256(diff),
      diff_bytes: Buffer.byteLength(diff), manifest: parseManifest(namesResult.stdout), diff },
    approved_plan: row.plan_snapshot, approval_scope: row.approval_scope,
    task: { key: row.task_key, title: row.task_title, description: row.task_description,
      acceptance_criteria: Array.isArray(row.plan_snapshot?.acceptance_criteria) ? row.plan_snapshot.acceptance_criteria : [] },
    agent_reported_tests_untrusted: row.task_metadata?.agent_reported_tests ?? null,
  });
  const json = JSON.stringify(value);
  const packageSecret = SECRET_PATTERNS.find(([, pattern]) => pattern.test(json));
  if (packageSecret) throw new Error(`review_package_secret_detected:${packageSecret[0]}`);
  if (Buffer.byteLength(json) > row.max_package_bytes) throw new Error("review_package_oversize_manual_review_required");
  return { value, json, sha256: sha256(json) };
}

function sandboxLiteral(value) { return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'); }
export function generateSandboxPolicy(repositoryRoot, worktreePath, gitCommonDir) {
  const denied = [...new Set([repositoryRoot, worktreePath, gitCommonDir].filter((value) => typeof value === "string" && value))];
  return `(version 1)\n(allow default)\n${denied.map((value) => `(deny file-write* (subpath "${sandboxLiteral(value)}"))`).join("\n")}\n`;
}

export async function assertWriteDenied(policy, repositoryRoot, run = runBounded) {
  const marker = `${repositoryRoot}/.reviewer-write-probe-${process.pid}`;
  const probe = await run("/usr/bin/sandbox-exec", ["-p", policy, "/bin/sh", "-c",
    'if /usr/bin/touch "$1" 2>/dev/null; then /bin/echo WRITE_ALLOWED; else /bin/echo WRITE_DENIED; fi',
    "reviewer-write-probe", marker], { timeoutMs: 10_000, maxBytes: 16_384 });
  if (probe.stdout.trim() === "WRITE_DENIED") return;
  if (probe.stdout.trim() === "WRITE_ALLOWED") throw new Error("reviewer_sandbox_write_probe_unexpectedly_succeeded");
  throw new Error("reviewer_sandbox_write_probe_inconclusive");
}

function useful(value, max) { return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null; }
export function parseReviewerResult(text) {
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("reviewer_stdout_oversize");
  let value; try { value = JSON.parse(text); } catch { throw new Error("reviewer_stdout_invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "feedback,findings,verdict") throw new Error("reviewer_result_invalid");
  if (!["approved", "changes_requested"].includes(value.verdict)) throw new Error("reviewer_verdict_invalid");
  if (value.feedback !== null && typeof value.feedback !== "string") throw new Error("reviewer_feedback_invalid");
  const feedback = typeof value.feedback === "string" ? value.feedback.trim() || null : null;
  if (feedback !== null && feedback.length > 20_000) throw new Error("reviewer_feedback_invalid");
  if (!Array.isArray(value.findings) || value.findings.length > 100) throw new Error("reviewer_findings_invalid");
  const findings = value.findings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)
      || Object.keys(finding).sort().join(",") !== "evidence,recommendation,severity,title") throw new Error("reviewer_finding_invalid");
    if (!["blocker", "major", "minor", "suggestion"].includes(finding.severity)) throw new Error("reviewer_finding_severity_invalid");
    const title = useful(finding.title, 500), evidence = useful(finding.evidence, 5_000), recommendation = useful(finding.recommendation, 5_000);
    if (!title || !evidence || !recommendation) throw new Error("reviewer_finding_not_semantically_useful");
    return { severity: finding.severity, title, evidence, recommendation };
  });
  if (value.verdict === "approved" && findings.some((f) => ["blocker", "major"].includes(f.severity))) throw new Error("reviewer_approval_has_blocking_findings");
  if (value.verdict === "changes_requested" && (!feedback || findings.length === 0)) throw new Error("reviewer_changes_require_feedback_and_finding");
  return { verdict: value.verdict, feedback, findings };
}

export function parseHermesOutput(stdout, stderr = "") {
  const sessionLines = stderr.split(/\r?\n/).filter((line) => /^session_id:\s*\d{8}_\d{6}_[0-9a-f]{6}\s*$/.test(line.trim()));
  if (sessionLines.length !== 1) throw new Error("reviewer_session_id_cardinality");
  const match = sessionLines[0].trim().match(/^session_id:\s*(\d{8}_\d{6}_[0-9a-f]{6})$/);
  if (!match) throw new Error("reviewer_session_id_format");
  return { sessionId: match[1], result: parseReviewerResult(stdout.trim()) };
}

export async function verifyHermesSession(stateDb, sessionId, startedAfter, finishedBefore, expectedModel, run = runBounded) {
  if (!/^\d{8}_\d{6}_[0-9a-f]{6}$/.test(sessionId)) throw new Error("reviewer_session_id_format");
  const sql = `select id,source,started_at,model,model_config from sessions where id='${sessionId}'`;
  const checked = await run("/usr/bin/sqlite3", ["-json", stateDb, sql], { maxBytes: 16_384, timeoutMs: 10_000 });
  let rows; try { rows = JSON.parse(checked.stdout || "[]"); } catch { throw new Error("reviewer_state_db_invalid"); }
  let modelConfig; try { modelConfig = JSON.parse(rows[0]?.model_config || "null"); } catch { throw new Error("reviewer_state_db_session_mismatch"); }
  const recordedStart = Number(rows[0]?.started_at);
  const validSource = rows[0]?.source === "mission-control-reviewer" || rows[0]?.source === "cli";
  if (rows.length !== 1 || rows[0].id !== sessionId || !validSource
    || rows[0].model !== expectedModel || modelConfig?.max_iterations !== 1
    || !Number.isFinite(recordedStart) || recordedStart < startedAfter - 5 || recordedStart > finishedBefore + 5) {
    throw new Error("reviewer_state_db_session_mismatch");
  }
}

export async function readCapabilityOnce(path = "/dev/fd/3") {
  const capability = await readFile(path, { encoding: "utf8" });
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("reviewer_capability_invalid");
  return capability;
}
