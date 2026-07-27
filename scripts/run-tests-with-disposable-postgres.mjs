#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl,
  databaseUrlForName,
  defaultTestAdminDatabaseUrl,
  generateMissionControlTestDatabaseName,
  quotePostgresIdentifier,
} from "./lib/test-postgres-guard.mjs";

const { Client } = pg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(repoRoot, "ops/local-postgres/schema.sql");

export function buildTestEnvironment(baseEnv, { adminUrl, databaseUrl }) {
  const env = {
    ...baseEnv,
    NODE_ENV: "test",
    MISSION_CONTROL_TEST_ADMIN_URL: adminUrl,
    MISSION_CONTROL_TEST_DATABASE_URL: databaseUrl,
    // Compatibility for application paths that consume the operational name:
    // in test mode it is pinned to the exact same disposable target.
    MISSION_CONTROL_DATABASE_URL: databaseUrl,
  };
  // libpq/pg accepts many PG* fallback variables. Remove all of them rather
  // than maintaining an incomplete allow/deny list (PGDATABASE, PGHOST,
  // PGHOSTADDR, PGPORT, PGSERVICE, PGSERVICEFILE, and future additions).
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG")) delete env[key];
  }
  delete env.DATABASE_URL;
  return env;
}

function runNodeTests(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--test", ...args], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      // A terminal sends Ctrl-C/termination to its foreground process group.
      // Isolate node:test (and its workers) so only this wrapper handles that
      // group signal and can wait for nested cleanup before dropping the outer
      // database. On Windows detached has different process semantics.
      detached: process.platform !== "win32",
    });
    child.once("error", (error) => {
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      resolveRun({ code: code ?? 1, signal });
    });
  });
}

async function removeDisposableDatabase(admin, databaseName) {
  await admin.query(
    `select pg_terminate_backend(pid)
       from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()`,
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quotePostgresIdentifier(databaseName)}`);
}

export async function runTestsWithDisposablePostgres({
  testArgs,
  baseEnv = process.env,
  runTests = runNodeTests,
} = {}) {
  if (!testArgs?.length) throw new Error("At least one node:test file or pattern is required");

  const adminUrl = assertTestAdminDatabaseUrl(
    baseEnv.MISSION_CONTROL_TEST_ADMIN_URL || defaultTestAdminDatabaseUrl(),
  ).toString();
  const databaseName = generateMissionControlTestDatabaseName();
  const databaseUrl = databaseUrlForName(adminUrl, databaseName);
  const admin = new Client({ connectionString: adminUrl });
  let databaseCreated = false;
  let requestedSignal;
  let result;
  let operationError;
  let cleanupError;

  const recordSignal = (signal) => {
    if (!requestedSignal) {
      requestedSignal = signal;
      console.error(`[test-db] received ${signal}; waiting for safe child and database cleanup`);
    } else {
      console.error(`[test-db] already handling ${requestedSignal}; ignoring repeated ${signal} until cleanup completes`);
    }
  };
  const onSigint = () => recordSignal("SIGINT");
  const onSigterm = () => recordSignal("SIGTERM");
  // These handlers cover connect, creation, schema setup, child execution, and
  // teardown. In particular, do not forward the signal to node:test: it can
  // kill a test worker in the middle of its own disposable-database cleanup.
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    await admin.connect();
    if (!requestedSignal) {
      await admin.query(`CREATE DATABASE ${quotePostgresIdentifier(databaseName)}`);
      databaseCreated = true;
    }

    if (!requestedSignal) {
      const schema = await readFile(schemaPath, "utf8");
      const testDatabase = new Client({ connectionString: databaseUrl });
      try {
        await testDatabase.connect();
        await testDatabase.query(schema);
      } finally {
        await testDatabase.end().catch(() => {});
      }
    }

    if (!requestedSignal) {
      console.log(`[test-db] created disposable database ${databaseName}`);
      result = await runTests(testArgs, buildTestEnvironment(baseEnv, { adminUrl, databaseUrl }));
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (databaseCreated) {
        await removeDisposableDatabase(admin, databaseName);
        console.log(`[test-db] dropped disposable database ${databaseName}`);
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      await admin.end().catch(() => {});
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }

  if (cleanupError) throw cleanupError;
  if (requestedSignal) return { code: 1, signal: requestedSignal };
  if (operationError) throw operationError;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runTestsWithDisposablePostgres({ testArgs: process.argv.slice(2) });
    if (result.signal) {
      console.error(`[test-db] node:test terminated by ${result.signal}`);
      process.exitCode = result.signal === "SIGINT" ? 130 : 143;
    } else {
      process.exitCode = result.code;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}