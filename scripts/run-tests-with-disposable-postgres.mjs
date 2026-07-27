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
  };
  // No test child receives an operational/default database variable. DB-backed
  // tests can only opt in through the dedicated, guarded test URL.
  delete env.MISSION_CONTROL_DATABASE_URL;
  delete env.DATABASE_URL;
  return env;
}

function runNodeTests(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--test", ...args], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    const forwardSignal = (signal) => child.kill(signal);
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      removeSignalHandlers();
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
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

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotePostgresIdentifier(databaseName)}`);
    databaseCreated = true;

    const schema = await readFile(schemaPath, "utf8");
    const testDatabase = new Client({ connectionString: databaseUrl });
    try {
      await testDatabase.connect();
      await testDatabase.query(schema);
    } finally {
      await testDatabase.end().catch(() => {});
    }

    console.log(`[test-db] created disposable database ${databaseName}`);
    return await runTests(testArgs, buildTestEnvironment(baseEnv, { adminUrl, databaseUrl }));
  } finally {
    try {
      if (databaseCreated) {
        await removeDisposableDatabase(admin, databaseName);
        console.log(`[test-db] dropped disposable database ${databaseName}`);
      }
    } finally {
      await admin.end().catch(() => {});
    }
  }
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