import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { git as defaultGit } from "./reviewer-runtime.mjs";

export const AGENT_BROWSER_VERSION = "0.33.2";
export const VISUAL_QA_SOURCE = "mission-control-visual-qa";
export const VISUAL_QA_NO_TOOLS_SELECTOR = "__mission_control_visual_qa_no_tools__";
export const DEFAULT_ARTIFACT_ROOT = "/Users/joaco/openclaw/artifacts/visual-qa";
export const MAX_VISUAL_QA_ACTIONS = 6;
export const MAX_VISUAL_QA_HERMES_MS = 60_000;
export const MAX_VISUAL_QA_BROWSER_MS = 15_000;
export const MAX_VISUAL_QA_COMBINATIONS = 2;
export const MAX_VISUAL_QA_FINDINGS = 50;
export const MAX_VISUAL_QA_FINDINGS_PER_COMBINATION = Math.floor(
  MAX_VISUAL_QA_FINDINGS / MAX_VISUAL_QA_COMBINATIONS,
);
export const VISUAL_QA_CAPABILITY_TTL_MS = 90 * 60_000;
export const VISUAL_QA_CLEANUP_RESERVE_MS = 10 * 60_000;
export const VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS = 30_000;
export const VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION = 4
  + (MAX_VISUAL_QA_ACTIONS - 1) * 8
  + 6
  + 3;
export const VISUAL_QA_FLOW_BUDGET_MS = MAX_VISUAL_QA_ACTIONS * MAX_VISUAL_QA_HERMES_MS
  + VISUAL_QA_BROWSER_COMMANDS_PER_COMBINATION * MAX_VISUAL_QA_BROWSER_MS
  + MAX_VISUAL_QA_BROWSER_MS;
export const VISUAL_QA_STARTUP_PHASE_BUDGETS_MS = Object.freeze({
  repository: 2 * 60_000,
  target: 5 * 60_000,
  postgres: 3 * 60_000,
  preview: 25 * 60_000,
  browser: 5 * 60_000,
});
export const VISUAL_QA_STARTUP_BUDGET_MS = Object.values(VISUAL_QA_STARTUP_PHASE_BUDGETS_MS)
  .reduce((total, value) => total + value, 0);
export const VISUAL_QA_TOTAL_WORST_CASE_BUDGET_MS = VISUAL_QA_STARTUP_BUDGET_MS
  + MAX_VISUAL_QA_COMBINATIONS * VISUAL_QA_FLOW_BUDGET_MS
  + VISUAL_QA_CLEANUP_RESERVE_MS
  + VISUAL_QA_COMPLETION_HTTP_TIMEOUT_MS;

export function visualQaRemainingWorkBudgetMs({ startupRemainingMs = 0, remainingCombinations }) {
  if (!Number.isInteger(startupRemainingMs) || startupRemainingMs < 0
    || !Number.isInteger(remainingCombinations) || remainingCombinations < 0
    || remainingCombinations > MAX_VISUAL_QA_COMBINATIONS) {
    throw new Error("visual_qa_budget_invalid");
  }
  return startupRemainingMs + remainingCombinations * VISUAL_QA_FLOW_BUDGET_MS;
}

export function visualQaErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/^(visual_qa_[a-z0-9_]+)(?::|$)/);
  return match?.[1] || "visual_qa_unexpected_failure";
}

const VISUAL_QA_REDACTION = "[REDACTED]";
const VISUAL_QA_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'`<>]+/gi,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;"'`<>]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,})\b/gi,
  /\b(?:MISSION_CONTROL_DATABASE_URL|DATABASE_URL|API[_-]?KEY|APIKEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|DB[_-]?PASSWORD|PASSWORD|SECRET|TOKEN)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]*)/gi,
];

export function redactVisualQaText(value, maxBytes = 50_000, secrets = []) {
  if (typeof value !== "string" || !Number.isInteger(maxBytes) || maxBytes < 0
    || !Array.isArray(secrets)) return "";
  let redacted = value;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    redacted = redacted.replaceAll(secret, VISUAL_QA_REDACTION);
    redacted = redacted.replaceAll(encodeURIComponent(secret), VISUAL_QA_REDACTION);
  }
  for (const pattern of VISUAL_QA_SECRET_PATTERNS) redacted = redacted.replace(pattern, VISUAL_QA_REDACTION);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  return Buffer.from(redacted, "utf8").subarray(0, maxBytes).toString("utf8");
}

export function sanitizeVisualQaObservation({ snapshot, diagnostics, secrets = [] } = {}) {
  const safeDiagnostics = [];
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    if (!diagnostic || typeof diagnostic !== "object" || !Number.isInteger(diagnostic.step)
      || diagnostic.step < 1 || diagnostic.step > MAX_VISUAL_QA_ACTIONS) continue;
    if (diagnostic.kind === "console" && typeof diagnostic.output === "string") {
      safeDiagnostics.push({
        step: diagnostic.step,
        kind: "console",
        output: redactVisualQaText(diagnostic.output, 20_000, secrets),
      });
    } else if (diagnostic.kind === "console_capture_error") {
      safeDiagnostics.push({
        step: diagnostic.step,
        kind: "console_capture_error",
        error: "visual_qa_console_capture_failed",
      });
    }
  }
  return {
    snapshot: redactVisualQaText(snapshot, 50_000, secrets),
    diagnostics: safeDiagnostics.slice(0, MAX_VISUAL_QA_ACTIONS),
  };
}

export function sanitizeVisualQaFinish(action, secrets = []) {
  if (!action || action.action !== "finish" || !Array.isArray(action.findings)) {
    throw new Error("visual_qa_action_finish_invalid");
  }
  return {
    ...action,
    summary: redactVisualQaText(action.summary, 2_048, secrets),
    findings: action.findings.map((finding) => ({
      title: redactVisualQaText(finding.title, 500, secrets),
      evidence: redactVisualQaText(finding.evidence, 2_048, secrets),
      recommendation: redactVisualQaText(finding.recommendation, 2_048, secrets),
    })),
  };
}

const SESSION = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF = /^@e[1-9][0-9]{0,4}$/;
const STORAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ISOLATED_BROWSER_HOST = /^vqa-[0-9a-f]{16}\.invalid$/;
const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const ARTIFACT_TYPES = new Map([
  ...IMAGE_TYPES,
  ["application/json", "json"],
  ["text/plain", "txt"],
]);
const PRESS_KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function usefulText(value, max = 2_048) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && Buffer.byteLength(value) <= max
    ? value
    : null;
}

function assertLoopbackUrl(value, error = "visual_qa_url_not_loopback") {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(error); }
  if (parsed.username || parsed.password || parsed.hash || !["http:", "https:"].includes(parsed.protocol)
    || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(error);
  }
  return parsed;
}

function assertIsolatedBrowserUrl(value, error = "visual_qa_preview_origin_invalid", originOnly = false) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(error); }
  if (parsed.username || parsed.password || parsed.hash || parsed.protocol !== "http:"
    || !ISOLATED_BROWSER_HOST.test(parsed.hostname) || !parsed.port
    || (originOnly && (parsed.pathname !== "/" || parsed.search))) {
    throw new Error(error);
  }
  return parsed;
}

function safeStorageRef(value) {
  return typeof value === "string" && STORAGE_REF.test(value) && !value.includes("//")
    && !value.startsWith("/") && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function inside(root, child) {
  const path = relative(root, child);
  return path === "" || (!!path && !path.startsWith("..") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path));
}

function slug(value, fallback) {
  const clean = typeof value === "string" && value.trim()
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    : "";
  return clean || fallback;
}

export function cleanVisualQaChildEnv(extra = {}, options = {}) {
  const env = {
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: typeof extra.HOME === "string" ? extra.HOME : process.env.HOME || "/Users/joaco",
    TMPDIR: typeof extra.TMPDIR === "string" ? extra.TMPDIR : process.env.TMPDIR || "/tmp",
    LANG: process.env.LANG || "en_US.UTF-8",
  };
  const allowHermes = options.allowHermes !== false;
  for (const key of ["AGENT_BROWSER_IDLE_TIMEOUT_MS", "AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_EXECUTABLE_PATH"]) {
    if (typeof extra[key] === "string") env[key] = extra[key];
  }
  if (allowHermes) {
    for (const key of ["HERMES_HOME", "HERMES_PROFILE"]) {
      if (typeof extra[key] === "string") env[key] = extra[key];
    }
  }
  return env;
}

export function buildVisualQaPreviewEnv({ home, tmpdir, databaseUrl }) {
  if (typeof home !== "string" || !home.startsWith("/") || typeof tmpdir !== "string" || !tmpdir.startsWith("/")) {
    throw new Error("visual_qa_private_env_invalid");
  }
  let database;
  try { database = new URL(databaseUrl); } catch { throw new Error("visual_qa_preview_database_invalid"); }
  const port = Number(database.port);
  if (!["postgres:", "postgresql:"].includes(database.protocol)
    || database.hostname !== "127.0.0.1"
    || database.username !== "aipaths_mc_app"
    || database.password
    || database.pathname !== "/postgres"
    || database.search || database.hash
    || !Number.isInteger(port) || port < 1024 || port > 65_535 || port === 5432) {
    throw new Error("visual_qa_preview_database_invalid");
  }
  return {
    ...cleanVisualQaChildEnv({ HOME: home, TMPDIR: tmpdir }, { allowHermes: false }),
    MISSION_CONTROL_LOCAL_AUTH_DISABLED: "true",
    MISSION_CONTROL_DATABASE_URL: database.toString(),
  };
}

export function buildVisualQaInstallEnv({ home, tmpdir }) {
  if (typeof home !== "string" || !home.startsWith("/") || typeof tmpdir !== "string" || !tmpdir.startsWith("/")) {
    throw new Error("visual_qa_private_env_invalid");
  }
  return cleanVisualQaChildEnv({ HOME: home, TMPDIR: tmpdir }, { allowHermes: false });
}

export function defaultAgentBrowserBin(repoRoot = process.cwd()) {
  return resolve(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "agent-browser.cmd" : "agent-browser");
}

export function buildAgentBrowserSessionId(randomHex) {
  if (typeof randomHex !== "string" || !/^[0-9a-f]{10}$/.test(randomHex)) {
    throw new Error("visual_qa_browser_session_invalid");
  }
  return `q${randomHex}`;
}

export function buildVisualQaBrowserNetwork({ browserOrigin, proxyUrl }) {
  const browser = assertIsolatedBrowserUrl(browserOrigin, "visual_qa_browser_network_invalid", true);
  const proxy = assertLoopbackUrl(proxyUrl, "visual_qa_browser_network_invalid");
  if (proxy.protocol !== "http:" || !proxy.port || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("visual_qa_browser_network_invalid");
  }
  return Object.freeze({
    browserOrigin: browser.origin,
    allowedDomain: browser.hostname,
    proxyUrl: proxy.origin,
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

export async function createExactPreviewProxy({ upstreamOrigin, randomHex }) {
  const upstream = assertLoopbackUrl(upstreamOrigin, "visual_qa_preview_proxy_invalid");
  if (upstream.protocol !== "http:" || !upstream.port || upstream.pathname !== "/" || upstream.search || upstream.hash
    || typeof randomHex !== "string" || !/^[0-9a-f]{16}$/.test(randomHex)) {
    throw new Error("visual_qa_preview_proxy_invalid");
  }
  const browserOrigin = `http://vqa-${randomHex}.invalid:${upstream.port}`;
  const browser = assertIsolatedBrowserUrl(browserOrigin, "visual_qa_preview_proxy_invalid", true);
  const sockets = new Set();
  const upstreamRequests = new Set();
  const server = createHttpServer((incoming, outgoing) => {
    let destination;
    try { destination = new URL(incoming.url || ""); } catch {
      outgoing.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Forbidden");
      return;
    }
    if (destination.origin !== browser.origin) {
      outgoing.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Forbidden");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
    }
    headers.host = browser.host;
    const upstreamRequest = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: `${destination.pathname}${destination.search}`,
      headers,
    }, (upstreamResponse) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value;
      }
      outgoing.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(outgoing);
    });
    upstreamRequests.add(upstreamRequest);
    upstreamRequest.once("close", () => upstreamRequests.delete(upstreamRequest));
    upstreamRequest.setTimeout(30_000, () => upstreamRequest.destroy(new Error("visual_qa_preview_proxy_timeout")));
    upstreamRequest.once("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Bad Gateway");
    });
    incoming.pipe(upstreamRequest);
  });
  server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.unref();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("visual_qa_preview_proxy_bind_failed");
  }
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  let closePromise = null;
  return {
    ...buildVisualQaBrowserNetwork({ browserOrigin, proxyUrl }),
    close: ({ timeoutMs = 5_000 } = {}) => {
      if (closePromise) return closePromise;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return Promise.reject(new Error("visual_qa_preview_proxy_cleanup_timeout_invalid"));
      }
      closePromise = new Promise((resolveClose, rejectClose) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) rejectClose(error); else resolveClose();
        };
        const timer = setTimeout(() => {
          for (const request of upstreamRequests) request.destroy();
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections?.();
          finish(new Error("visual_qa_preview_proxy_cleanup_timeout"));
        }, timeoutMs);
        server.close((error) => finish(error ? new Error("visual_qa_preview_proxy_cleanup_failed") : null));
        for (const request of upstreamRequests) request.destroy();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections?.();
      });
      return closePromise;
    },
  };
}

function compareBrowserVersionsDescending(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

async function assertBrowserExecutable(path) {
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("visual_qa_browser_executable_invalid");
  await access(resolved, fsConstants.X_OK);
  return resolved;
}

export async function resolveAgentBrowserExecutable({ home, explicitPath } = {}) {
  if (typeof explicitPath === "string" && explicitPath.startsWith("/")) {
    return assertBrowserExecutable(explicitPath);
  }
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw new Error("visual_qa_browser_executable_missing");
  }
  const browserRoot = await realpath(join(home, ".agent-browser", "browsers")).catch(() => null);
  if (!browserRoot) throw new Error("visual_qa_browser_executable_missing");
  const candidates = (await readdir(browserRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^chrome-\d+\.\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, version: entry.name.slice("chrome-".length) }))
    .sort((left, right) => compareBrowserVersionsDescending(left.version, right.version));
  for (const candidate of candidates) {
    const path = join(browserRoot, candidate.name, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    try {
      const resolved = await assertBrowserExecutable(path);
      const rel = relative(browserRoot, resolved);
      if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return resolved;
    } catch {
      // Try the next complete installed browser.
    }
  }
  throw new Error("visual_qa_browser_executable_missing");
}

export function remapQaTargetUrl(targetUrl, previewOrigin) {
  const target = assertLoopbackUrl(targetUrl);
  const preview = assertIsolatedBrowserUrl(previewOrigin, "visual_qa_preview_origin_invalid", true);
  return `${preview.origin}${target.pathname}${target.search}`;
}

export function aggregateVisualQaFindings(groups) {
  if (!Array.isArray(groups) || groups.length > MAX_VISUAL_QA_COMBINATIONS
    || groups.some((group) => !Array.isArray(group) || group.length > MAX_VISUAL_QA_FINDINGS_PER_COMBINATION)) {
    throw new Error("visual_qa_findings_contract_exceeded");
  }
  const findings = groups.flat();
  if (findings.length > MAX_VISUAL_QA_FINDINGS) throw new Error("visual_qa_findings_contract_exceeded");
  return findings;
}

export function validatePlannerAction(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!value || typeof value.action !== "string") throw new Error("visual_qa_action_invalid");
  switch (value.action) {
    case "open": {
      if (!exact(value, ["action", "url"])) throw new Error("visual_qa_action_open_invalid");
      const url = usefulText(value.url, 2_048);
      if (!url) throw new Error("visual_qa_action_open_invalid");
      try { assertLoopbackUrl(url, "visual_qa_action_open_invalid"); }
      catch { assertIsolatedBrowserUrl(url, "visual_qa_action_open_invalid"); }
      return { action: "open", url };
    }
    case "snapshot": {
      if (!exact(value, ["action"])) throw new Error("visual_qa_action_snapshot_invalid");
      return { action: "snapshot" };
    }
    case "click": {
      if (!exact(value, ["action", "ref"]) || typeof value.ref !== "string" || !REF.test(value.ref)) {
        throw new Error("visual_qa_action_click_invalid");
      }
      return { action: "click", ref: value.ref };
    }
    case "fill": {
      const text = usefulText(value.text, 1_000);
      if (!exact(value, ["action", "ref", "text"]) || typeof value.ref !== "string" || !REF.test(value.ref) || !text) {
        throw new Error("visual_qa_action_fill_invalid");
      }
      return { action: "fill", ref: value.ref, text };
    }
    case "type": {
      const text = usefulText(value.text, 1_000);
      if (!exact(value, ["action", "text"]) || !text) throw new Error("visual_qa_action_type_invalid");
      return { action: "type", text };
    }
    case "press": {
      if (!exact(value, ["action", "key"]) || typeof value.key !== "string"
        || (!PRESS_KEYS.has(value.key) && !/^[A-Za-z0-9]$/.test(value.key))) {
        throw new Error("visual_qa_action_press_invalid");
      }
      return { action: "press", key: value.key };
    }
    case "scroll": {
      if (!exact(value, ["action", "direction", "amount"])) throw new Error("visual_qa_action_scroll_invalid");
      const amount = Number(value.amount);
      if (!["up", "down", "left", "right"].includes(String(value.direction))
        || !Number.isInteger(amount) || amount < 1 || amount > 5_000) throw new Error("visual_qa_action_scroll_invalid");
      return { action: "scroll", direction: value.direction, amount };
    }
    case "wait": {
      const ms = Number(value.ms);
      if (!exact(value, ["action", "ms"]) || !Number.isInteger(ms) || ms < 1 || ms > 60_000) {
        throw new Error("visual_qa_action_wait_invalid");
      }
      return { action: "wait", ms };
    }
    case "finish": {
      if (!exact(value, ["action", "verdict", "summary", "findings"])) throw new Error("visual_qa_action_finish_invalid");
      const summary = usefulText(value.summary, 2_048);
      if (!["pass", "changes"].includes(value.verdict) || !summary || !Array.isArray(value.findings)
        || value.findings.length > MAX_VISUAL_QA_FINDINGS_PER_COMBINATION) throw new Error("visual_qa_action_finish_invalid");
      const findings = value.findings.map((finding) => {
        if (!exact(finding, ["title", "evidence", "recommendation"])) throw new Error("visual_qa_action_finish_invalid");
        const title = usefulText(finding.title, 500);
        const evidence = usefulText(finding.evidence, 2_048);
        const recommendation = usefulText(finding.recommendation, 2_048);
        if (!title || !evidence || !recommendation) throw new Error("visual_qa_action_finish_invalid");
        return { title, evidence, recommendation };
      });
      if (value.verdict === "changes" && findings.length === 0) throw new Error("visual_qa_action_finish_invalid");
      if (value.verdict === "pass" && findings.length !== 0) throw new Error("visual_qa_action_finish_invalid");
      return { action: "finish", verdict: value.verdict, summary, findings };
    }
    default:
      throw new Error("visual_qa_action_unknown");
  }
}

export function validatePlannerActionForPreview(input, previewOrigin) {
  const action = validatePlannerAction(input);
  if (action.action !== "open") return action;
  const preview = assertIsolatedBrowserUrl(previewOrigin, "visual_qa_preview_origin_invalid", true);
  const opened = assertIsolatedBrowserUrl(action.url, "visual_qa_action_open_origin_mismatch");
  if (opened.origin !== preview.origin) throw new Error("visual_qa_action_open_origin_mismatch");
  return action;
}

export function assertBrowserUrlAtPreviewOrigin(rawUrl, previewOrigin) {
  if (typeof rawUrl !== "string" || rawUrl !== rawUrl.trim() || /[\r\n\0]/.test(rawUrl)) {
    throw new Error("visual_qa_browser_origin_mismatch");
  }
  const preview = assertIsolatedBrowserUrl(previewOrigin, "visual_qa_browser_origin_mismatch", true);
  const current = assertIsolatedBrowserUrl(rawUrl, "visual_qa_browser_origin_mismatch");
  if (current.origin !== preview.origin) {
    throw new Error("visual_qa_browser_origin_mismatch");
  }
  return current.toString();
}

function baseAgentBrowserArgs(session, network) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(session)) throw new Error("visual_qa_browser_session_invalid");
  const safeNetwork = buildVisualQaBrowserNetwork(network || {});
  return ["--session", session, "--allowed-domains", safeNetwork.allowedDomain,
    "--proxy", safeNetwork.proxyUrl, "--engine", "chrome"];
}

export function buildAgentBrowserArgs(session, action, network) {
  const safeNetwork = buildVisualQaBrowserNetwork(network || {});
  const parsed = validatePlannerActionForPreview(action, safeNetwork.browserOrigin);
  const args = baseAgentBrowserArgs(session, safeNetwork);
  switch (parsed.action) {
    case "open": return [...args, "open", parsed.url];
    case "snapshot": return [...args, "snapshot", "-i", "--json"];
    case "click": return [...args, "click", parsed.ref];
    case "fill": return [...args, "fill", parsed.ref, parsed.text];
    case "type": return [...args, "keyboard", "type", parsed.text];
    case "press": return [...args, "press", parsed.key];
    case "scroll": return [...args, "scroll", parsed.direction, String(parsed.amount)];
    case "wait": return [...args, "wait", String(parsed.ms)];
    default: throw new Error("visual_qa_action_not_executable");
  }
}

export function buildAgentBrowserUtilityArgs(session, command, extra = [], network) {
  const args = baseAgentBrowserArgs(session, network);
  if (command === "set-viewport") return [...args, "set", "viewport", String(extra[0]), String(extra[1])];
  if (command === "screenshot") return [...args, "screenshot", String(extra[0])];
  if (command === "close") return [...args, "close"];
  if (command === "console") return [...args, "console", "--json"];
  if (command === "current-url") return [...args, "get", "url"];
  throw new Error("visual_qa_browser_utility_unknown");
}

export function parseVisualHermesOutput(stdout, stderr = "") {
  if (Buffer.byteLength(stdout || "", "utf8") > 256 * 1024) throw new Error("visual_qa_stdout_oversize");
  const sessionLines = stderr.split(/\r?\n/).filter((line) => /^session_id:\s*\d{8}_\d{6}_[0-9a-f]{6}\s*$/.test(line.trim()));
  if (sessionLines.length !== 1) throw new Error("visual_qa_session_id_cardinality");
  const match = sessionLines[0].trim().match(/^session_id:\s*(\d{8}_\d{6}_[0-9a-f]{6})$/);
  if (!match) throw new Error("visual_qa_session_id_format");
  let decoded;
  try { decoded = JSON.parse(stdout.trim()); } catch { throw new Error("visual_qa_stdout_invalid_json"); }
  return { sessionId: match[1], action: validatePlannerAction(decoded) };
}

export function buildHermesPlannerArgs({ prompt, model, provider, imagePath, sessionId = null }) {
  if (!usefulText(prompt, 64 * 1024) || !usefulText(model, 200) || !usefulText(provider, 200)
    || !usefulText(imagePath, 4_096)) throw new Error("visual_qa_hermes_args_invalid");
  if (sessionId !== null && !SESSION.test(sessionId)) throw new Error("visual_qa_session_id_format");
  const args = ["chat", "-q", prompt, "-Q", "--source", VISUAL_QA_SOURCE, "--no-restore-cwd",
    "--model", model, "--provider", provider, "--toolsets", VISUAL_QA_NO_TOOLS_SELECTOR,
    "--safe-mode", "--ignore-rules", "--max-turns", "1", "--pass-session-id", "--image", imagePath];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export async function verifyVisualQaHermesSession(
  stateDb,
  sessionId,
  startedAfter,
  finishedBefore,
  expectedModel,
  expectedProvider,
  run,
) {
  if (!SESSION.test(sessionId)) throw new Error("visual_qa_session_id_format");
  const sql = `select id,source,started_at,model,model_config,billing_provider from sessions where id='${sessionId}'`;
  const checked = await run("/usr/bin/sqlite3", ["-json", stateDb, sql], { maxBytes: 16_384, timeoutMs: 10_000 });
  let rows; try { rows = JSON.parse(checked.stdout || "[]"); } catch { throw new Error("visual_qa_state_db_invalid"); }
  let modelConfig; try { modelConfig = JSON.parse(rows[0]?.model_config || "null"); } catch { throw new Error("visual_qa_state_db_session_mismatch"); }
  const recordedStart = Number(rows[0]?.started_at);
  if (rows.length !== 1 || rows[0].id !== sessionId || rows[0].source !== VISUAL_QA_SOURCE
    || rows[0].model !== expectedModel || modelConfig?.provider !== expectedProvider
    || rows[0].billing_provider !== expectedProvider || modelConfig?.max_iterations !== 1
    || !Number.isFinite(recordedStart) || recordedStart < startedAfter - 5 || recordedStart > finishedBefore + 5) {
    throw new Error("visual_qa_state_db_session_mismatch");
  }
}

export function createHermesPlannerSessionAudit({ stateDb, expectedModel, expectedProvider, run, bindPlannerSession }) {
  if (typeof stateDb !== "string" || !stateDb || typeof expectedModel !== "string" || !expectedModel
    || typeof expectedProvider !== "string" || !expectedProvider
    || typeof run !== "function" || typeof bindPlannerSession !== "function") {
    throw new Error("visual_qa_planner_audit_invalid");
  }
  let sessionId = null;
  let originalStartedAfter = null;
  let bound = false;
  return {
    get sessionId() { return sessionId; },
    get originalStartedAfter() { return originalStartedAfter; },
    get bound() { return bound; },
    async verify({ sessionId: observedSessionId, startedAfter, finishedBefore }) {
      if (!SESSION.test(observedSessionId)) throw new Error("visual_qa_session_id_format");
      if (sessionId && sessionId !== observedSessionId) throw new Error("visual_qa_hermes_session_changed");
      if (!Number.isFinite(startedAfter) || !Number.isFinite(finishedBefore)) throw new Error("visual_qa_planner_audit_window_invalid");
      if (originalStartedAfter === null) originalStartedAfter = startedAfter;
      await verifyVisualQaHermesSession(
        stateDb, observedSessionId, originalStartedAfter, finishedBefore, expectedModel, expectedProvider, run,
      );
      if (!bound) {
        await bindPlannerSession(observedSessionId);
        sessionId = observedSessionId;
        bound = true;
      }
      return { sessionId: observedSessionId, originalStartedAfter, bound };
    },
  };
}

export async function assertMissionControlAppRole(client) {
  const identity = await client.query("select current_user", []);
  if (identity.rows?.length !== 1 || identity.rows[0]?.current_user !== "aipaths_mc_app") {
    throw new Error("visual_qa_database_role_mismatch");
  }
}

export async function assertAgentBrowserPinned(agentBrowserBin, run) {
  const version = await run(agentBrowserBin, ["--version"], { maxBytes: 16_384, timeoutMs: 10_000 });
  if (!new RegExp(`\\b${AGENT_BROWSER_VERSION.replaceAll(".", "\\.")}\\b`).test(`${version.stdout}\n${version.stderr}`)) {
    throw new Error("visual_qa_agent_browser_version_mismatch");
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("visual_qa_canonical_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("visual_qa_canonical_non_json_value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function hashVisualQaResult(result) {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}

export async function readQaCapabilityOnce(path = "/dev/fd/3") {
  const capability = await readFile(path, { encoding: "utf8" });
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("visual_qa_capability_invalid");
  return capability;
}

export async function resolveArtifactRef(root, storageRef) {
  if (!safeStorageRef(storageRef)) throw new Error("visual_qa_artifact_ref_invalid");
  const rootReal = await realpath(root);
  const target = resolve(rootReal, storageRef);
  if (!inside(rootReal, target)) throw new Error("visual_qa_artifact_ref_escape");
  const targetReal = await realpath(target);
  if (!inside(rootReal, targetReal)) throw new Error("visual_qa_artifact_ref_escape");
  return targetReal;
}

export function sniffImageMediaType(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || "");
  if (bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function detectSafeImageMediaType(filePath, bytes) {
  const data = bytes || await readFile(filePath);
  const name = filePath.toLowerCase();
  const sniffed = sniffImageMediaType(data);
  if (name.endsWith(".png") && sniffed === "image/png") return "image/png";
  if ((name.endsWith(".jpg") || name.endsWith(".jpeg")) && sniffed === "image/jpeg") return "image/jpeg";
  if (name.endsWith(".webp") && sniffed === "image/webp") return "image/webp";
  throw new Error("visual_qa_artifact_media_type_unsupported");
}

async function assertNoSymlinkedParents(rootReal, absolute) {
  const parent = dirname(absolute);
  if (!inside(rootReal, parent)) throw new Error("visual_qa_artifact_ref_escape");
  const relativeParent = relative(rootReal, parent);
  let current = rootReal;
  for (const segment of relativeParent.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("visual_qa_artifact_parent_symlink");
    if (!info.isDirectory()) throw new Error("visual_qa_artifact_parent_invalid");
  }
}

async function writeFileNoFollowExclusive(filePath, buffer, signal) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    assertNotAborted(signal);
    handle = await open(filePath, flags, 0o600);
    await handle.writeFile(buffer, { signal });
    assertNotAborted(signal);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("visual_qa_artifact_no_follow");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeImmutableArtifact(root, {
  executionId, viewport = null, flow = null, kind, mediaType, content, signal,
}) {
  assertNotAborted(signal);
  if (!UUID.test(executionId)) throw new Error("visual_qa_artifact_execution_invalid");
  if (!["screenshot", "trace", "log", "video"].includes(kind)) throw new Error("visual_qa_artifact_kind_invalid");
  if (!ARTIFACT_TYPES.has(mediaType)) throw new Error("visual_qa_artifact_media_type_invalid");
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  if (buffer.length === 0 || buffer.length > 100 * 1024 * 1024) throw new Error("visual_qa_artifact_bytes_invalid");
  if (IMAGE_TYPES.has(mediaType) && sniffImageMediaType(buffer) !== mediaType) {
    throw new Error("visual_qa_artifact_media_type_mismatch");
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const ext = ARTIFACT_TYPES.get(mediaType);
  const label = [slug(viewport, "all"), slug(flow, kind)].join(".");
  const storageRef = `qa/${executionId}/${sha256.slice(0, 2)}/${sha256}.${label}.${ext}`;
  if (!safeStorageRef(storageRef)) throw new Error("visual_qa_artifact_ref_invalid");
  await mkdir(root, { recursive: true, mode: 0o700 });
  assertNotAborted(signal);
  const rootReal = await realpath(root);
  const absolute = resolve(rootReal, storageRef);
  if (!inside(rootReal, absolute)) throw new Error("visual_qa_artifact_ref_escape");
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  assertNotAborted(signal);
  await assertNoSymlinkedParents(rootReal, absolute);
  try {
    await writeFileNoFollowExclusive(absolute, buffer, signal);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingInfo = await lstat(absolute);
    if (existingInfo.isSymbolicLink()) throw new Error("visual_qa_artifact_no_follow");
    const existing = await readFile(absolute, { signal });
    if (!existing.equals(buffer)) throw new Error("visual_qa_artifact_immutable_conflict");
  }
  const absoluteReal = await resolveArtifactRef(rootReal, storageRef);
  const current = await readFile(absoluteReal, { signal });
  assertNotAborted(signal);
  if (createHash("sha256").update(current).digest("hex") !== sha256) throw new Error("visual_qa_artifact_checksum_mismatch");
  await access(absoluteReal, fsConstants.R_OK);
  const info = await stat(absoluteReal);
  return {
    kind,
    storage_ref: storageRef,
    sha256,
    bytes: Number(info.size),
    media_type: mediaType,
    viewport,
    flow,
  };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error("visual_qa_lifecycle_aborted");
}

async function chmodTree(root, modeFor, signal) {
  assertNotAborted(signal);
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(root)) await chmodTree(join(root, entry), modeFor, signal);
    assertNotAborted(signal);
    await chmod(root, modeFor(true));
    return;
  }
  await chmod(root, modeFor(false));
}

export async function makeTreeReadOnly(root, signal) {
  await chmodTree(root, (isDirectory) => isDirectory ? 0o500 : 0o400, signal);
}

export async function makeTreeWritable(root, signal) {
  await chmodTree(root, (isDirectory) => isDirectory ? 0o700 : 0o600, signal);
}

async function cleanupVisualQaSourceWorktree(repositoryRoot, sourceWorktree, git) {
  let cleanupError = null;
  await makeTreeWritable(sourceWorktree).catch(() => {});
  await git(repositoryRoot, ["worktree", "remove", "--force", sourceWorktree], { timeoutMs: 60_000 })
    .catch((error) => { cleanupError ||= error; });
  await git(repositoryRoot, ["worktree", "prune"], { timeoutMs: 60_000 })
    .catch((error) => { cleanupError ||= error; });
  if (cleanupError) {
    throw new Error(`visual_qa_worktree_cleanup_failed:${cleanupError instanceof Error ? cleanupError.message : "unknown"}`);
  }
}

export async function prepareVisualQaTargetTrees({ repositoryRoot, targetSha, tempDir, git = defaultGit, signal }) {
  if (!targetSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(targetSha)) throw new Error("visual_qa_target_sha_invalid");
  assertNotAborted(signal);
  const sourceWorktree = join(tempDir, "source-worktree");
  const previewDir = join(tempDir, "preview");
  let added = false;
  let readOnly = false;
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  await mkdir(previewDir, { recursive: true, mode: 0o700 });
  try {
    await git(repositoryRoot, ["worktree", "add", "--detach", sourceWorktree, targetSha], { timeoutMs: 60_000 });
    added = true;
    const head = (await git(sourceWorktree, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (head !== targetSha) throw new Error("visual_qa_worktree_head_mismatch");
    const status = (await git(sourceWorktree, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
    if (status !== "") throw new Error("visual_qa_worktree_dirty");
    await makeTreeReadOnly(sourceWorktree, signal);
    readOnly = true;
    await git(sourceWorktree, ["checkout-index", "-a", "-f", `--prefix=${previewDir}/`], { timeoutMs: 60_000 });
    await makeTreeWritable(sourceWorktree, signal);
    readOnly = false;
    await git(repositoryRoot, ["worktree", "remove", "--force", sourceWorktree], { timeoutMs: 60_000 });
    added = false;
    await git(repositoryRoot, ["worktree", "prune"], { timeoutMs: 60_000 });
    return { sourceWorktree, detachedSourceWorktree: sourceWorktree, previewDir };
  } catch (error) {
    if (added) {
      if (readOnly) await makeTreeWritable(sourceWorktree).catch(() => {});
      await cleanupVisualQaSourceWorktree(repositoryRoot, sourceWorktree, git);
    }
    throw error;
  }
}

function safePid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid < 2 ** 31;
}

export function isDetachedProcessGroupAlive(pid, kill = process.kill.bind(process)) {
  if (!safePid(pid)) return false;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw new Error("visual_qa_process_group_probe_failed");
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForGroupExit(pid, { kill, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let probeFailed = false;
  while (Date.now() < deadline) {
    try {
      if (!isDetachedProcessGroupAlive(pid, kill)) return true;
    } catch (error) {
      if (error?.message !== "visual_qa_process_group_probe_failed") throw error;
      if (processGroupHasOnlyZombies(pid)) return true;
      probeFailed = true;
    }
    await sleep(pollIntervalMs);
  }
  try {
    return !isDetachedProcessGroupAlive(pid, kill);
  } catch (error) {
    if (error?.message === "visual_qa_process_group_probe_failed" && processGroupHasOnlyZombies(pid)) return true;
    if (probeFailed && error?.message === "visual_qa_process_group_probe_failed") throw error;
    throw error;
  }
}

function processGroupHasOnlyZombies(pid) {
  if (process.platform !== "darwin" || !safePid(pid)) return false;
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return false;
  const states = result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    return match && Number(match[1]) === pid ? [match[2]] : [];
  });
  return states.length > 0 && states.every((state) => state.startsWith("Z"));
}

export async function terminateDetachedProcessGroup(pid, {
  kill = process.kill.bind(process),
  termWaitMs = 5_000,
  killWaitMs = 5_000,
  pollIntervalMs = 100,
} = {}) {
  if (!safePid(pid)) return false;
  try { kill(-pid, "SIGTERM"); } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  if (await waitForGroupExit(pid, { kill, timeoutMs: termWaitMs, pollIntervalMs })) return true;
  try { kill(-pid, "SIGKILL"); } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  if (!(await waitForGroupExit(pid, { kill, timeoutMs: killWaitMs, pollIntervalMs }))) {
    throw new Error("visual_qa_process_group_alive_after_sigkill");
  }
  return true;
}

export function createDetachedProcessGroupRegistry({
  terminate = terminateDetachedProcessGroup,
  probe = isDetachedProcessGroupAlive,
} = {}) {
  if (typeof terminate !== "function" || typeof probe !== "function") {
    throw new Error("visual_qa_process_group_registry_invalid");
  }
  const groups = new Set();
  const verifyAbsent = async (pid) => {
    const deadline = Date.now() + 5_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (!probe(pid)) return true;
      } catch (error) {
        lastError = error;
        if (processGroupHasOnlyZombies(pid)) return true;
      }
      await sleep(50);
    }
    if (lastError) throw lastError;
    return false;
  };
  return {
    track(pid) {
      if (!safePid(pid)) throw new Error("visual_qa_process_group_pid_invalid");
      groups.add(pid);
      return pid;
    },
    untrack(pid) {
      if (!groups.has(pid)) return;
      if (probe(pid)) throw new Error("visual_qa_process_group_still_alive");
      groups.delete(pid);
    },
    get size() { return groups.size; },
    async terminateAll() {
      let failed = false;
      for (const pid of [...groups].reverse()) {
        try {
          await terminate(pid);
          if (!(await verifyAbsent(pid))) throw new Error("visual_qa_process_group_still_alive");
          groups.delete(pid);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("visual_qa_process_group_cleanup_failed");
    },
  };
}

async function boundedCleanupStep(step, timeoutMs, drainTimeoutMs) {
  const controller = new AbortController();
  let timeout;
  let drainTimeout;
  const operation = Promise.resolve().then(() => step({ signal: controller.signal }));
  const outcome = await Promise.race([
    operation.then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    ),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ status: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.status === "fulfilled") return { failed: false };
  if (outcome.status === "rejected") throw outcome.error;

  controller.abort(new Error("visual_qa_cleanup_step_timeout"));
  const drained = await Promise.race([
    operation.then(
      () => ({ status: "fulfilled" }),
      () => ({ status: "rejected" }),
    ),
    new Promise((resolveDrainTimeout) => {
      drainTimeout = setTimeout(() => resolveDrainTimeout({ status: "drain_timeout" }), drainTimeoutMs);
    }),
  ]);
  clearTimeout(drainTimeout);
  if (drained.status === "drain_timeout") {
    const error = new Error("visual_qa_cleanup_step_drain_timeout");
    error.cleanupUndrained = true;
    throw error;
  }
  return { failed: true };
}

export function runVisualQaCleanup(steps, { stepTimeoutMs = 60_000, drainTimeoutMs = 20_000 } = {}) {
  if (!steps || typeof steps !== "object" || !Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 1
    || !Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000) {
    throw new Error("visual_qa_cleanup_invalid");
  }
  const names = ["browser", "preview", "proxy", "postgres", "worktree", "temp", "socket"];
  const completed = new Set();
  let cleanupPromise = null;
  return () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let failed = false;
      for (const name of names) {
        if (completed.has(name)) continue;
        const step = steps[name];
        if (typeof step !== "function") {
          completed.add(name);
          continue;
        }
        try {
          const outcome = await boundedCleanupStep(step, stepTimeoutMs, drainTimeoutMs);
          completed.add(name);
          if (outcome.failed) failed = true;
        } catch (error) {
          failed = true;
          if (error?.cleanupUndrained) break;
        }
      }
      if (failed) throw new Error("visual_qa_cleanup_failed");
    })().finally(() => { cleanupPromise = null; });
    return cleanupPromise;
  };
}

export async function runVisualQaAllSettledSteps(steps, failureCode) {
  if (!Array.isArray(steps) || steps.some((step) => typeof step !== "function")
    || typeof failureCode !== "string" || !/^visual_qa_[a-z0-9_]+$/.test(failureCode)) {
    throw new Error("visual_qa_all_settled_steps_invalid");
  }
  let failed = false;
  for (const step of steps) {
    const [result] = await Promise.allSettled([Promise.resolve().then(step)]);
    if (result.status === "rejected") failed = true;
  }
  if (failed) throw new Error(failureCode);
}

export async function runVisualQaDeadlinePhase(name, operation, {
  deadlineMs,
  signal,
  onDeadline,
  drainTimeoutMs = 20_000,
} = {}) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name) || typeof operation !== "function"
    || !Number.isFinite(deadlineMs) || (onDeadline !== undefined && typeof onDeadline !== "function")
    || !Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000) {
    throw new Error("visual_qa_phase_deadline_invalid");
  }
  const remainingMs = Math.floor(deadlineMs - Date.now());
  if (remainingMs < 1) throw new Error(`visual_qa_${name}_deadline_exceeded`);
  if (signal?.aborted) throw new Error("visual_qa_lifecycle_aborted");

  const controller = new AbortController();
  let deadlineExceeded = false;
  let deadlineTimer;
  let drainTimer;
  const onParentAbort = () => controller.abort(new Error("visual_qa_lifecycle_aborted"));
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const aborted = new Promise((resolveAbort) => {
    controller.signal.addEventListener("abort", () => resolveAbort({ status: "aborted" }), { once: true });
  });
  deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    try { onDeadline?.(); } catch {}
    controller.abort(new Error(`visual_qa_${name}_deadline_exceeded`));
  }, remainingMs);
  const phaseOperation = Promise.resolve().then(() => operation({ signal: controller.signal }));
  const settled = phaseOperation.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  try {
    const first = await Promise.race([settled, aborted]);
    if (first.status === "fulfilled") return first.value;
    if (first.status === "rejected" && !controller.signal.aborted) throw first.error;

    const drained = first.status === "rejected" ? first : await Promise.race([
      settled,
      new Promise((resolveDrainTimeout) => {
        drainTimer = setTimeout(() => resolveDrainTimeout({ status: "drain_timeout" }), drainTimeoutMs);
      }),
    ]);
    if (drained.status === "drain_timeout") throw new Error(`visual_qa_${name}_deadline_drain_failed`);
    if (deadlineExceeded) throw new Error(`visual_qa_${name}_deadline_exceeded`);
    throw new Error("visual_qa_lifecycle_aborted");
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(drainTimer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

export function installVisualQaSignalHandlers({
  cleanup,
  controller = new AbortController(),
  exit = (code) => process.exit(code),
}) {
  if (typeof cleanup !== "function" || typeof exit !== "function"
    || !controller || typeof controller.abort !== "function" || !controller.signal) {
    throw new Error("visual_qa_signal_handler_invalid");
  }
  let signaled = false;
  let cleanupPromise = null;
  let exitPromise = null;
  const handlers = new Map();
  const runCleanup = () => {
    cleanupPromise ||= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
  for (const [signalName, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const handler = () => {
      if (signaled) return;
      signaled = true;
      controller.abort(new Error("visual_qa_signal_received"));
      exitPromise = runCleanup().then(
        () => exit(code),
        () => exit(1),
      );
    };
    handlers.set(signalName, handler);
    process.on(signalName, handler);
  }
  return {
    get signaled() { return signaled; },
    canComplete() { return !signaled; },
    cleanup: runCleanup,
    settled() { return exitPromise || Promise.resolve(); },
    remove() {
      for (const [signalName, handler] of handlers) process.off(signalName, handler);
    },
  };
}

export function createVisualQaHeartbeat({ beat, intervalMs = 60_000, beatTimeoutMs = 15_000 }) {
  if (typeof beat !== "function" || !Number.isInteger(intervalMs) || intervalMs < 1
    || !Number.isInteger(beatTimeoutMs) || beatTimeoutMs < 1) {
    throw new Error("visual_qa_heartbeat_invalid");
  }
  let started = false;
  let stopped = false;
  let timer = null;
  let inFlight = null;
  let failureError = null;
  let rejectFailure;
  const failure = new Promise((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});

  const fail = () => {
    if (failureError) return failureError;
    failureError = new Error("visual_qa_heartbeat_failed");
    stopped = true;
    clearTimeout(timer);
    rejectFailure(failureError);
    return failureError;
  };

  const runBeat = async () => {
    if (stopped) return;
    let timeout;
    inFlight = Promise.race([
      Promise.resolve().then(beat),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("visual_qa_heartbeat_timeout")), beatTimeoutMs);
      }),
    ]);
    try {
      await inFlight;
    } catch {
      throw fail();
    } finally {
      clearTimeout(timeout);
      inFlight = null;
    }
    if (!stopped) timer = setTimeout(() => { void runBeat().catch(() => {}); }, intervalMs);
  };

  return {
    get failure() { return failure; },
    async start() {
      if (started) throw new Error("visual_qa_heartbeat_already_started");
      started = true;
      await runBeat();
    },
    guard(promise) {
      if (!started) return Promise.reject(new Error("visual_qa_heartbeat_not_started"));
      if (failureError) return Promise.reject(failureError);
      return Promise.race([Promise.resolve(promise), failure]);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight?.catch(() => {});
    },
  };
}

export function createVisualQaLifecycleGuard({
  heartbeat,
  controller = new AbortController(),
  drainTimeoutMs = 20_000,
}) {
  if (!heartbeat || typeof heartbeat.guard !== "function"
    || !controller || typeof controller.abort !== "function" || !controller.signal
    || !Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000) {
    throw new Error("visual_qa_lifecycle_guard_invalid");
  }
  return {
    signal: controller.signal,
    async guard(promise) {
      const operation = Promise.resolve(promise);
      try {
        return await heartbeat.guard(operation);
      } catch (error) {
        controller.abort();
        let drainTimer;
        await Promise.race([
          operation.catch(() => {}),
          new Promise((resolveDrain) => {
            drainTimer = setTimeout(resolveDrain, drainTimeoutMs);
          }),
        ]);
        clearTimeout(drainTimer);
        throw error;
      }
    },
  };
}
