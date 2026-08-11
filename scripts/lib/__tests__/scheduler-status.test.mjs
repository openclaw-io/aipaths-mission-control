import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

import {
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

function runtimeHealth(overrides = {}) {
  return {
    enabled: true,
    schedule: "every 5 min",
    last_run_at: "2026-08-11T13:58:00.000Z",
    last_status: "ok",
    last_error: null,
    rows_affected: 2,
    ...overrides,
  };
}

test("runtime cron_health is the only effective enabled authority", () => {
  const paused = buildWorkItemSchedulerStatus(runtimeHealth({ enabled: false }));
  assert.equal(paused.enabled, false);
  assert.equal(paused.state, "paused");

  const scheduled = buildWorkItemSchedulerStatus(
    runtimeHealth({ enabled: true }),
    null,
    new Date("2026-08-11T14:00:00.000Z"),
  );
  assert.equal(scheduled.enabled, true);
  assert.equal(scheduled.state, "scheduled");

  const malformed = buildWorkItemSchedulerStatus(runtimeHealth({ enabled: "true" }));
  assert.equal(malformed.enabled, false);
  assert.equal(malformed.state, "degraded");
  assert.match(malformed.last_error || "", /enabled/i);
});

test("an idle interval job remains scheduled between successful runs", () => {
  const status = buildWorkItemSchedulerStatus(
    runtimeHealth(),
    null,
    new Date("2026-08-11T14:00:00.000Z"),
  );

  assert.equal(status.state, "scheduled");
  assert.equal(status.health, "healthy");
  assert.equal(status.cron_name, "publish-blog-dispatcher");
  assert.equal(status.schedule, "every 5 min");
  assert.equal(status.schedule_minutes, 5);
  assert.equal(status.rows_affected, 2);
});

test("dispatcher health degrades when last_status is ok but observation is stale", () => {
  const status = buildWorkItemSchedulerStatus(
    runtimeHealth({ last_run_at: "2026-08-11T13:30:00.000Z", rows_affected: 0 }),
    null,
    new Date("2026-08-11T14:00:00.000Z"),
  );

  assert.equal(status.state, "degraded");
  assert.equal(status.health, "degraded");
  assert.equal(status.fresh, false);
  assert.match(status.last_error, /stale/i);
});

test("dispatcher health is fresh inside the 660 second watchdog window", () => {
  const status = buildWorkItemSchedulerStatus(
    runtimeHealth({ last_run_at: "2026-08-11T13:50:00.000Z", rows_affected: 0 }),
    null,
    new Date("2026-08-11T14:00:00.000Z"),
  );

  assert.equal(status.state, "scheduled");
  assert.equal(status.health, "healthy");
  assert.equal(status.fresh, true);
});

test("enabled dispatcher degrades when no health observation exists", () => {
  const status = buildWorkItemSchedulerStatus(
    null,
    null,
    new Date("2026-08-11T14:00:00.000Z"),
  );

  assert.equal(status.state, "degraded");
  assert.equal(status.health, "unknown");
  assert.equal(status.fresh, false);
  assert.match(status.last_error || "", /health.*missing|missing.*health/i);
});

test("cron_health read failures are observability degradation with HTTP 200 control", () => {
  const response = buildSchedulerStatusResponse(null, new Error("cron_health timeout"));

  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, false);
  assert.equal(response.body.state, "degraded");
  assert.equal(response.body.health, "unknown");
  assert.equal(response.body.last_status, "unknown");
  assert.match(response.body.last_error || "", /cron_health timeout/);
});

test("status route observes only the dedicated publish_blog dispatcher health", () => {
  const source = readFileSync(
    new URL("../../../src/app/api/scheduler/status/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /PUBLISH_BLOG_DISPATCHER_CRON_NAME/);
  assert.doesNotMatch(source, /["']work-item-scheduler["']/);
  assert.doesNotMatch(source, /scheduler_config/);
  assert.match(source, /select enabled, schedule, last_run_at, last_status, last_error, rows_affected/);
});

test("failed health reports remain degraded without claiming the launcher was unloaded", () => {
  const status = buildWorkItemSchedulerStatus(runtimeHealth({
    last_run_at: "2026-08-11T13:59:00.000Z",
    last_status: "error",
    last_error: "worker timeout",
    rows_affected: 0,
  }), null, new Date("2026-08-11T14:00:00.000Z"));

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
