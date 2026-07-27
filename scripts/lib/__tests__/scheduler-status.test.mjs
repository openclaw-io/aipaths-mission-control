import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

import {
  LAUNCHER_SCHEDULE_MINUTES,
  buildSchedulerConfigResponse,
  parseSchedulerPatch,
} from "../../../src/lib/scheduler/config.ts";
import {
  buildSchedulerStatusResponse,
  buildWorkItemSchedulerStatus,
} from "../../../src/lib/scheduler/status.ts";

const { Client } = pg;

const validRows = [
  { key: "enabled", value: "true" },
  { key: "max_concurrent", value: "2" },
  { key: "daily_budget_usd", value: "50" },
  { key: "schedule_minutes", value: "5" },
];

test("scheduler status uses explicit boolean parsing and fails closed on absent/invalid enabled", () => {
  for (const value of [undefined, "TRUE", "yes", "1", "", " true "]) {
    const rows = validRows.filter((row) => row.key !== "enabled");
    if (value !== undefined) rows.push({ key: "enabled", value });
    const status = buildWorkItemSchedulerStatus(rows, null);
    assert.equal(status.enabled, false);
    assert.equal(status.state, "degraded");
    assert.match(status.last_error || "", /enabled/i);
  }

  const paused = buildWorkItemSchedulerStatus(
    validRows.map((row) => row.key === "enabled" ? { ...row, value: "false" } : row),
    null,
  );
  assert.equal(paused.enabled, false);
  assert.equal(paused.state, "paused");
});

test("status never advertises a config cadence that disagrees with the launcher", () => {
  const mismatch = buildWorkItemSchedulerStatus(
    validRows.map((row) => row.key === "schedule_minutes" ? { ...row, value: "10" } : row),
    null,
  );

  assert.equal(mismatch.state, "degraded");
  assert.equal(mismatch.schedule_minutes, 5);
  assert.equal(mismatch.schedule, "every 5 min");
  assert.match(mismatch.last_error || "", /schedule_minutes/i);
  assert.equal(Number.isInteger(mismatch.schedule_minutes), true);
  assert.equal(LAUNCHER_SCHEDULE_MINUTES, 5);
});

test("status degrades for every missing, malformed, or out-of-range canonical control", () => {
  const invalidCases = [
    ["max_concurrent", undefined],
    ["max_concurrent", "0"],
    ["max_concurrent", "11"],
    ["max_concurrent", "2.5"],
    ["daily_budget_usd", undefined],
    ["daily_budget_usd", "0"],
    ["daily_budget_usd", "100001"],
    ["daily_budget_usd", "1.5"],
    ["schedule_minutes", undefined],
  ];

  for (const [key, value] of invalidCases) {
    const rows = validRows.filter((row) => row.key !== key);
    if (value !== undefined) rows.push({ key, value });
    const status = buildWorkItemSchedulerStatus(rows, {
      last_run_at: "2026-07-27T12:00:00.000Z",
      last_status: "ok",
      last_error: null,
      rows_affected: 0,
    });
    assert.equal(status.state, "degraded", `${key}=${String(value)} must degrade`);
    assert.match(status.last_error || "", new RegExp(key));
  }
});

test("an idle interval job remains scheduled between successful runs", () => {
  const status = buildWorkItemSchedulerStatus(validRows, {
    last_run_at: "2026-07-27T12:00:00.000Z",
    last_status: "ok",
    last_error: null,
    rows_affected: 2,
  });

  assert.equal(status.state, "scheduled");
  assert.equal(status.health, "healthy");
  assert.equal(status.schedule, "every 5 min");
  assert.equal(status.schedule_minutes, 5);
  assert.equal(status.rows_affected, 2);
});

test("cron_health read failures are observability degradation with HTTP 200 control", () => {
  const response = buildSchedulerStatusResponse(validRows, null, new Error("cron_health timeout"));

  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.state, "degraded");
  assert.equal(response.body.health, "unknown");
  assert.equal(response.body.last_status, "unknown");
  assert.match(response.body.last_error || "", /cron_health timeout/);
});

test("failed health reports remain degraded without claiming the launcher was unloaded", () => {
  const status = buildWorkItemSchedulerStatus(validRows, {
    last_run_at: "2026-07-27T12:00:00.000Z",
    last_status: "error",
    last_error: "worker timeout",
    rows_affected: 0,
  });

  assert.equal(status.state, "degraded");
  assert.equal(status.health, "degraded");
  assert.equal(status.schedule, "every 5 min");
  assert.equal(status.last_error, "worker timeout");
});

test("scheduler PATCH is allowlisted, normalized, and range checked before writes", () => {
  assert.deepEqual(
    parseSchedulerPatch({ enabled: true, max_concurrent: "4", daily_budget_usd: 75, schedule_minutes: 5 }),
    { enabled: "true", max_concurrent: "4", daily_budget_usd: "75", schedule_minutes: "5" },
  );
  assert.deepEqual(parseSchedulerPatch({ enabled: "false" }), { enabled: "false" });

  for (const body of [
    {},
    [],
    null,
    { admin: "true" },
    { enabled: "yes" },
    { max_concurrent: 0 },
    { max_concurrent: 11 },
    { max_concurrent: 2.5 },
    { daily_budget_usd: 0 },
    { daily_budget_usd: 2.5 },
    { schedule_minutes: 10 },
    { schedule_minutes: 5.5 },
  ]) {
    assert.throws(() => parseSchedulerPatch(body), /scheduler|config|field|integer|enabled|schedule/i);
  }
});

test("scheduler GET presents typed valid values without defaults", () => {
  assert.deepEqual(buildSchedulerConfigResponse(validRows), {
    valid: true,
    errors: [],
    enabled: true,
    max_concurrent: 2,
    daily_budget_usd: 50,
    schedule_minutes: 5,
  });
});

test("scheduler GET reports corruption and never invents operational defaults", () => {
  const invalid = buildSchedulerConfigResponse([{ key: "enabled", value: "yes" }]);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.enabled, null);
  assert.equal(invalid.max_concurrent, null);
  assert.equal(invalid.daily_budget_usd, null);
  assert.equal(invalid.schedule_minutes, null);
  assert.match(invalid.errors.join(" "), /enabled/i);
  assert.match(invalid.errors.join(" "), /max_concurrent/i);
  assert.match(invalid.errors.join(" "), /daily_budget_usd/i);
  assert.match(invalid.errors.join(" "), /schedule_minutes/i);
});

test("migration safely normalizes historical invalid enabled and seeds launcher cadence", () => {
  const migration = readFileSync(new URL("../../../supabase/migrations/031_work_item_scheduler_observability.sql", import.meta.url), "utf8");
  const localSchema = readFileSync(new URL("../../../ops/local-postgres/schema.sql", import.meta.url), "utf8");

  for (const sql of [migration, localSchema]) {
    assert.doesNotMatch(sql, /value::boolean/i);
    assert.match(sql, /lower\(trim\([^)]*value[^)]*\)\)/i);
    assert.match(sql, /else\s+'false'/i);
    assert.match(sql, /schedule_minutes[\s\S]*'5'/i);
    assert.match(sql, /every 5 min/i);
  }
});

test("migration executes safely against invalid historical values", {
  skip: !process.env.MISSION_CONTROL_TEST_DATABASE_URL,
}, async () => {
  const migration = readFileSync(new URL("../../../supabase/migrations/031_work_item_scheduler_observability.sql", import.meta.url), "utf8");
  const client = new Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`update scheduler_config set value = case key
      when 'enabled' then 'definitely-not-a-boolean'
      when 'max_concurrent' then 'NaN'
      when 'daily_budget_usd' then '-7'
      when 'schedule_minutes' then '10'
      else value end`);
    await client.query(migration);
    const config = await client.query(`select key, value from scheduler_config
      where key in ('enabled', 'max_concurrent', 'daily_budget_usd', 'schedule_minutes')`);
    assert.deepEqual(Object.fromEntries(config.rows.map((row) => [row.key, row.value])), {
      enabled: "false",
      max_concurrent: "2",
      daily_budget_usd: "50",
      schedule_minutes: "5",
    });
    const health = await client.query(`select enabled, schedule from cron_health where cron_name = 'work-item-scheduler'`);
    assert.deepEqual(health.rows[0], { enabled: false, schedule: "every 5 min" });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});

test("queue UI consumes the integer schedule_minutes instead of reparsing display text", () => {
  const source = readFileSync(new URL("../../../src/components/loops/QueueSchedulerStatus.tsx", import.meta.url), "utf8");
  assert.match(source, /schedule_minutes:\s*number/);
  assert.match(source, /data\.schedule_minutes/);
  assert.doesNotMatch(source, /function scheduleMinutes\(schedule: string\)/);
});

test("queue UI renders degraded/error state before paused state", () => {
  const source = readFileSync(new URL("../../../src/components/loops/QueueSchedulerStatus.tsx", import.meta.url), "utf8");
  const degradedGuard = source.indexOf('cron.state === "degraded"');
  const errorGuard = source.indexOf('cron.last_status === "error"');
  const pausedGuard = source.indexOf("!cron.enabled");
  assert.ok(degradedGuard >= 0 && degradedGuard < pausedGuard, "degraded must be checked before paused");
  assert.ok(errorGuard >= 0 && errorGuard < pausedGuard, "error must be checked before paused");
});

test("scheduler config UI exposes API corruption as degradation instead of defaults", () => {
  const source = readFileSync(new URL("../../../src/components/SchedulerToggle.tsx", import.meta.url), "utf8");
  const cronsPage = readFileSync(new URL("../../../src/app/crons/page.tsx", import.meta.url), "utf8");
  assert.match(source, /config\.valid\s*!==\s*true/);
  assert.match(source, /Scheduler config degraded/);
  assert.doesNotMatch(source, /config\.max_concurrent\s*\|\|\s*2/);
  assert.doesNotMatch(source, /config\.daily_budget_usd\s*\|\|\s*50/);
  assert.match(cronsPage, /<SchedulerToggle\s*\/>/);
});
