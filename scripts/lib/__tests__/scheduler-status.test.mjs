import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkItemSchedulerStatus } from "../../../src/lib/scheduler/status.ts";

test("scheduler status is available from canonical config before the first health report", () => {
  assert.deepEqual(
    buildWorkItemSchedulerStatus(
      [
        { key: "enabled", value: "false" },
        { key: "schedule_minutes", value: "15" },
      ],
      null,
    ),
    {
      cron_name: "work-item-scheduler",
      enabled: false,
      schedule: "every 15 min",
      schedule_minutes: 15,
      state: "paused",
      last_run_at: null,
      last_status: "unknown",
      last_error: null,
      rows_affected: 0,
    },
  );
});

test("an idle interval job remains scheduled between successful runs", () => {
  const status = buildWorkItemSchedulerStatus(
    [
      { key: "enabled", value: "true" },
      { key: "schedule_minutes", value: "10" },
    ],
    {
      last_run_at: "2026-07-27T12:00:00.000Z",
      last_status: "ok",
      last_error: null,
      rows_affected: 2,
    },
  );

  assert.equal(status.state, "scheduled");
  assert.equal(status.enabled, true);
  assert.equal(status.last_status, "ok");
  assert.equal(status.rows_affected, 2);
});

test("a failed run is degraded without claiming the scheduler was unloaded", () => {
  const status = buildWorkItemSchedulerStatus(
    [{ key: "enabled", value: "true" }],
    {
      last_run_at: "2026-07-27T12:00:00.000Z",
      last_status: "error",
      last_error: "network timeout",
      rows_affected: 0,
    },
  );

  assert.equal(status.state, "degraded");
  assert.equal(status.schedule, "every 10 min");
  assert.equal(status.last_error, "network timeout");
});
