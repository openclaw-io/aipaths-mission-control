import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_OPERATIONAL_DATABASE_NAME,
  assertDisposableTestDatabaseUrl,
  assertTestAdminDatabaseUrl,
  databaseNameFromUrl,
  databaseUrlForName,
  generateMissionControlTestDatabaseName,
  requireMissionControlTestDatabaseUrl,
} from "../test-postgres-guard.mjs";
import { buildTestEnvironment } from "../../run-tests-with-disposable-postgres.mjs";

test("guard accepts only recognized disposable databases on exact loopback hosts", () => {
  const ipv4 = "postgresql://tester@127.0.0.1:5432/aipaths_mission_control_test_123_456_abcdef12";
  const ipv6 = "postgresql://tester@[::1]:5432/mc_loops_rehearsal_123_456";
  assert.equal(databaseNameFromUrl(assertDisposableTestDatabaseUrl(ipv4)), "aipaths_mission_control_test_123_456_abcdef12");
  assert.equal(databaseNameFromUrl(assertDisposableTestDatabaseUrl(ipv6)), "mc_loops_rehearsal_123_456");
});

test("guard always refuses the live operational database", () => {
  for (const protocol of ["postgres", "postgresql"]) {
    assert.throws(
      () => assertDisposableTestDatabaseUrl(`${protocol}://tester@127.0.0.1:5432/${LIVE_OPERATIONAL_DATABASE_NAME}`),
      /refuses the live operational database/,
    );
  }
});

test("guard rejects remote, hostname, socket, and unrecognized database targets", () => {
  for (const value of [
    "postgresql://tester@192.168.1.10:5432/aipaths_mission_control_test_x",
    "postgresql://tester@localhost:5432/aipaths_mission_control_test_x",
    "postgresql:///aipaths_mission_control_test_x",
    "postgresql://tester@127.0.0.1:5432/some_existing_database",
    "postgresql://tester@127.0.0.1:5432/aipaths_mission_control_test_x?host=db.example.com",
  ]) {
    assert.throws(() => assertDisposableTestDatabaseUrl(value), /loopback host|recognized disposable|query parameters/);
  }
});

test("dedicated test URL is mandatory and cannot fall back to operational variables", () => {
  assert.throws(
    () => requireMissionControlTestDatabaseUrl({
      MISSION_CONTROL_DATABASE_URL: `postgresql://tester@127.0.0.1:5432/${LIVE_OPERATIONAL_DATABASE_NAME}`,
    }),
    /Missing MISSION_CONTROL_TEST_DATABASE_URL/,
  );
});

test("admin URL is loopback-only and restricted to a maintenance database", () => {
  assert.equal(
    databaseNameFromUrl(assertTestAdminDatabaseUrl("postgresql://tester@127.0.0.1:5432/postgres")),
    "postgres",
  );
  assert.throws(
    () => assertTestAdminDatabaseUrl("postgresql://tester@db.example.com:5432/postgres"),
    /loopback host/,
  );
  assert.throws(
    () => assertTestAdminDatabaseUrl("postgresql://tester@127.0.0.1:5432/application"),
    /maintenance database/,
  );
});

test("runner helpers generate safe names/URLs and strip operational DB variables", () => {
  const databaseName = generateMissionControlTestDatabaseName({ pid: 123, now: 456, randomSuffix: "abcdef12" });
  assert.equal(databaseName, "aipaths_mission_control_test_123_456_abcdef12");
  const adminUrl = "postgresql://tester@127.0.0.1:5432/postgres";
  const databaseUrl = databaseUrlForName(adminUrl, databaseName);
  assert.equal(databaseNameFromUrl(new URL(databaseUrl)), databaseName);

  const env = buildTestEnvironment({
    MISSION_CONTROL_DATABASE_URL: `postgresql://tester@127.0.0.1:5432/${LIVE_OPERATIONAL_DATABASE_NAME}`,
    DATABASE_URL: "postgresql://remote.example/application",
    PRESERVED: "yes",
  }, { adminUrl, databaseUrl });
  assert.equal(env.MISSION_CONTROL_DATABASE_URL, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.MISSION_CONTROL_TEST_DATABASE_URL, databaseUrl);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PRESERVED, "yes");
});