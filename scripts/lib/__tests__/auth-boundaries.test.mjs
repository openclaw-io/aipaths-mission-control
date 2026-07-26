import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "../../../src/lib/auth/local.ts";
import { isPublicPath } from "../../../src/lib/auth/public-paths.ts";

const originalValue = process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;

afterEach(() => {
  if (originalValue === undefined) delete process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;
  else process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED = originalValue;
});

test("local auth fails closed and is disabled only by the exact true flag", () => {
  delete process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;
  assert.equal(isLocalAuthDisabled(), false);
  assert.equal(getLocalMissionControlUser(), null);

  for (const value of ["false", "TRUE", "1", "yes", " true "]) {
    process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED = value;
    assert.equal(isLocalAuthDisabled(), false, value);
    assert.equal(getLocalMissionControlUser(), null, value);
  }

  process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED = "true";
  assert.equal(isLocalAuthDisabled(), true);
  assert.deepEqual(getLocalMissionControlUser(), { email: "local@mission-control" });
});

test("middleware public paths are exact and limited to self-authenticating endpoints", () => {
  for (const pathname of [
    "/login",
    "/api/health",
    "/api/healthz",
    "/api/health/gateway",
    "/api/agent/memory",
    "/api/work-items/notify",
    "/api/loops/materialize-queued",
    "/api/loops/plan-pending",
    "/api/youtube/launch-package",
  ]) {
    assert.equal(isPublicPath(pathname), true, pathname);
  }

  for (const pathname of [
    "/api/healthcheck",
    "/api/healthz/extra",
    "/api/memory/search",
    "/api/work-items",
    "/api/work-items/example",
    "/api/work-items/notify/extra",
    "/api/loops/create",
    "/api/loops/materialize-queued/extra",
  ]) {
    assert.equal(isPublicPath(pathname), false, pathname);
  }
});
