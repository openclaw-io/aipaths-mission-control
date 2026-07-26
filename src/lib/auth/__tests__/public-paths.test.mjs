import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPublicPath } from "../public-paths.ts";

describe("middleware public paths", () => {
  test("allows login and health endpoints", () => {
    for (const pathname of ["/login", "/api/healthz", "/api/health/gateway"]) {
      assert.equal(isPublicPath(pathname), true, pathname);
    }
  });

  test("allows only API endpoints with route-level authentication", () => {
    for (const pathname of [
      "/api/agent/memory",
      "/api/agent/memory/search",
      "/api/agent/usage",
      "/api/agent/work-items/example",
      "/api/work-items/notify",
      "/api/loops/materialize-queued",
      "/api/loops/plan-pending",
      "/api/youtube/launch-package",
    ]) {
      assert.equal(isPublicPath(pathname), true, pathname);
    }
  });

  test("does not expose memory or general work-item routes", () => {
    for (const pathname of [
      "/api/memory/search",
      "/api/memory/example",
      "/api/work-items",
      "/api/work-items/example",
      "/api/work-items/example/requeue",
      "/api/work-items/recurring-rules",
      "/api/work-items/recurring-rules/materialize",
    ]) {
      assert.equal(isPublicPath(pathname), false, pathname);
    }
  });

  test("does not match health or authenticated endpoint lookalikes", () => {
    for (const pathname of [
      "/api/healthcheck",
      "/api/healthz/extra",
      "/api/work-items/notify/extra",
      "/api/loops/materialize-queued/extra",
    ]) {
      assert.equal(isPublicPath(pathname), false, pathname);
    }
  });
});
