import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl,
  quotePostgresIdentifier,
} from "../test-postgres-guard.mjs";

const { Client } = pg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const wrapperPath = resolve(repoRoot, "scripts/run-tests-with-disposable-postgres.mjs");
const rehearsalPath = resolve(repoRoot, "scripts/rehearse-loops-cutover.mjs");
const fixturePath = resolve(repoRoot, "scripts/lib/__tests__/fixtures/signal-safe-test-child.mjs");

function collectProcess(child) {
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  return { get output() { return output; }, closed };
}

async function waitForOutput(capture, pattern, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = capture.output.match(pattern);
    if (match) return match;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`subprocess exited before readiness marker:\n${capture.output}`);
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for subprocess output ${pattern}:\n${capture.output}`);
}

async function databaseExists(admin, database) {
  const result = await admin.query("select 1 from pg_database where datname=$1", [database]);
  return result.rowCount > 0;
}

async function dropIfPresent(admin, database) {
  await admin.query(`DROP DATABASE IF EXISTS ${quotePostgresIdentifier(database)} WITH (FORCE)`);
}

function signalProcessGroup(child, signal) {
  if (process.platform === "win32") return child.kill(signal);
  process.kill(-child.pid, signal);
  return true;
}

async function runWrapperSignalCase(signal, { repeated = false } = {}) {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let outerDatabase;
  let rehearsalDatabase;
  try {
    const childEnv = { ...process.env, MISSION_CONTROL_TEST_ADMIN_URL: adminUrl };
    // node:test marks workers with this private variable; a separately spawned
    // node --test run must not inherit it or Node treats the run as recursive.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [wrapperPath, fixturePath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Make the wrapper the leader of a fresh group, then signal that whole
      // group exactly as a terminal/supervisor would. The wrapper must isolate
      // its own node:test child for nested finally blocks to survive.
      detached: process.platform !== "win32",
    });
    const capture = collectProcess(child);
    const ready = await waitForOutput(capture, /\[signal-fixture-ready\] (mc_loops_rehearsal_[a-z0-9_]+)/, child);
    rehearsalDatabase = ready[1];
    outerDatabase = capture.output.match(/\[test-db\] created disposable database (aipaths_mission_control_test_[a-z0-9_]+)/)?.[1];
    assert.ok(outerDatabase, `missing outer database marker:\n${capture.output}`);
    assert.equal(await databaseExists(admin, outerDatabase), true);
    assert.equal(await databaseExists(admin, rehearsalDatabase), true);

    assert.equal(signalProcessGroup(child, signal), true);
    if (repeated) {
      await delay(25);
      assert.equal(signalProcessGroup(child, signal), true);
    }
    const result = await capture.closed;
    assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, signal: null }, capture.output);
    assert.match(capture.output, /ignoring repeated SIGTERM|received SIGINT/);
    assert.equal(await databaseExists(admin, outerDatabase), false, capture.output);
    assert.equal(await databaseExists(admin, rehearsalDatabase), false, capture.output);
  } finally {
    if (rehearsalDatabase) await dropIfPresent(admin, rehearsalDatabase);
    if (outerDatabase) await dropIfPresent(admin, outerDatabase);
    await admin.end().catch(() => {});
  }
}

for (const [signal, repeated] of [["SIGTERM", true], ["SIGINT", false]]) {
  test(`whole wrapper process-group ${signal}${repeated ? " plus a repeated signal" : ""} cleans outer and nested databases`, {
    timeout: 30_000,
    skip: process.platform === "win32" && "POSIX process-group behavior",
  }, async () => {
    await runWrapperSignalCase(signal, { repeated });
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`loops rehearsal drops its scratch database after whole process-group ${signal}`, { timeout: 30_000 }, async () => {
    const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const child = spawn(process.execPath, [rehearsalPath], {
      cwd: repoRoot,
      env: { ...process.env, MISSION_CONTROL_TEST_ADMIN_URL: adminUrl },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const capture = collectProcess(child);
    const databasePrefix = `mc_loops_rehearsal_${child.pid}_`;
    let database;
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const result = await admin.query(
          "select datname from pg_database where datname like $1 order by datname",
          [`${databasePrefix}%`],
        );
        database = result.rows[0]?.datname;
        if (database) break;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`rehearsal exited before creating its database:\n${capture.output}`);
        }
        await delay(20);
      }
      assert.ok(database, `rehearsal database was not observed:\n${capture.output}`);
      assert.equal(signalProcessGroup(child, signal), true);
      const result = await capture.closed;
      assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, signal: null }, capture.output);
      assert.equal(await databaseExists(admin, database), false, capture.output);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (database) await dropIfPresent(admin, database);
      await admin.end().catch(() => {});
    }
  });
}
