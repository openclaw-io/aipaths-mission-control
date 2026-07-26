import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const requiredLoopRoutes = [
  "src/app/loops/page.tsx",
  "src/app/api/loops/create/route.ts",
  "src/app/api/loops/plan-pending/route.ts",
  "src/app/api/loops/materialize-queued/route.ts",
  "src/app/api/loops/[id]/clarify/route.ts",
  "src/app/api/loops/[id]/submit-for-approval/route.ts",
  "src/app/api/loops/[id]/approve/route.ts",
  "src/app/api/loops/[id]/review/route.ts",
];

const removedLegacyRoutes = [
  "src/app/projects",
  "src/app/api/projects",
];

test("Loop UI and API routes are the only domain routes", () => {
  for (const route of requiredLoopRoutes) {
    assert.equal(existsSync(resolve(root, route)), true, `missing Loop route: ${route}`);
  }
  for (const route of removedLegacyRoutes) {
    assert.equal(existsSync(resolve(root, route)), false, `legacy route remains: ${route}`);
  }
});

test("fresh-install schema exposes only canonical Loop relations", () => {
  const schema = readFileSync(resolve(root, "ops/local-postgres/schema.sql"), "utf8");
  for (const expected of ["public.loops", "public.loop_events", "public.loop_work_items", "loop_id"]) {
    assert.match(schema, new RegExp(expected.replace(".", "\\.")), `schema missing ${expected}`);
  }
  for (const legacy of ["public.projects", "public.project_events", "public.project_work_items", "project_id"]) {
    assert.doesNotMatch(schema, new RegExp(legacy.replace(".", "\\.")), `schema retains ${legacy}`);
  }
});

test("cloud/local sync imports the Loop graph in dependency order", () => {
  const sync = readFileSync(resolve(root, "scripts/sync-local-core-from-cloud.mjs"), "utf8");
  const positions = ["loops", "work_items", "loop_events", "loop_work_items"].map((name) => sync.indexOf(`name: \"${name}\"`));
  assert.ok(positions.every((position) => position >= 0), "sync is missing one or more Loop graph tables");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "Loop graph sync order is not dependency-safe");
  assert.match(sync, /count assertion|assertImportedCounts/i, "sync does not assert imported counts");
});
