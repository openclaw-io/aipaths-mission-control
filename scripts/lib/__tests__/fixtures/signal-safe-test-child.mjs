import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl,
  databaseUrlForName,
  quotePostgresIdentifier,
} from "../../test-postgres-guard.mjs";

const { Client } = pg;

test("signal fixture cleans its nested rehearsal database", async () => {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const database = `mc_loops_rehearsal_signal_${process.pid}_${Date.now()}`;
  databaseUrlForName(adminUrl, database);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotePostgresIdentifier(database)}`);
    console.log(`[signal-fixture-ready] ${database}`);
    await delay(750);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${quotePostgresIdentifier(database)} WITH (FORCE)`);
    await admin.end().catch(() => {});
  }
});
