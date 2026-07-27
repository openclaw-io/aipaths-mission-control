import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import {
  LIVE_OPERATIONAL_DATABASE_NAME,
  MISSION_CONTROL_TEST_DATABASE_PREFIX,
  assertDisposableTestDatabaseUrl,
  assertLoopbackPostgresUrl,
  databaseNameFromUrl,
  requireMissionControlTestDatabaseUrl,
} from "../../src/lib/db/test-postgres-guard.mjs";

export function assertTestAdminDatabaseUrl(value) {
  const variableName = "MISSION_CONTROL_TEST_ADMIN_URL";
  const url = assertLoopbackPostgresUrl(value, variableName);
  const databaseName = databaseNameFromUrl(url, variableName);
  if (databaseName !== "postgres" && databaseName !== "template1") {
    throw new Error(`${variableName} must target the postgres or template1 maintenance database`);
  }
  return url;
}

export {
  LIVE_OPERATIONAL_DATABASE_NAME,
  MISSION_CONTROL_TEST_DATABASE_PREFIX,
  assertDisposableTestDatabaseUrl,
  assertLoopbackPostgresUrl,
  databaseNameFromUrl,
  requireMissionControlTestDatabaseUrl,
};

export function defaultTestAdminDatabaseUrl() {
  const username = encodeURIComponent(userInfo().username);
  return `postgresql://${username}@127.0.0.1:5432/postgres`;
}

export function generateMissionControlTestDatabaseName({
  pid = process.pid,
  now = Date.now(),
  randomSuffix = randomBytes(4).toString("hex"),
} = {}) {
  const name = `${MISSION_CONTROL_TEST_DATABASE_PREFIX}${pid}_${now}_${randomSuffix}`;
  if (name.length > 63 || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Generated disposable PostgreSQL database name is invalid");
  }
  return name;
}

export function databaseUrlForName(adminUrl, databaseName) {
  if (!/^[a-z0-9_]+$/.test(databaseName) || databaseName.length > 63) {
    throw new Error("Disposable PostgreSQL database name is invalid");
  }
  const url = new URL(adminUrl.toString());
  url.pathname = `/${databaseName}`;
  const result = url.toString();
  assertDisposableTestDatabaseUrl(result);
  return result;
}

export function quotePostgresIdentifier(identifier) {
  if (!/^[a-z0-9_]+$/.test(identifier) || identifier.length > 63) {
    throw new Error("Unsafe PostgreSQL identifier");
  }
  return `"${identifier}"`;
}