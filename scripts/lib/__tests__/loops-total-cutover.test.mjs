import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("local Loop review records last_completed_at with cloud parity", () => {
  const reviewRoute = readFileSync(resolve(root, "src/app/api/loops/[id]/review/route.ts"), "utf8");
  assert.match(reviewRoute, /last_completed_at\s*=\s*case when \$1 = 'completed'/i);
});

test("cloud/local sync is bounded, FK-safe, and verifies the local target", () => {
  const sync = readFileSync(resolve(root, "scripts/sync-local-core-from-cloud.mjs"), "utf8");
  const positions = ["loops", "work_items", "loop_events", "loop_work_items"].map((name) => sync.indexOf(`name: \"${name}\"`));
  assert.ok(positions.every((position) => position >= 0), "sync is missing one or more Loop graph tables");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "Loop graph sync order is not dependency-safe");
  assert.match(sync, /count assertion|assertImportedCounts/i, "sync does not assert imported counts");
  assert.doesNotMatch(sync, /\btruncate\b/i, "sync must not use TRUNCATE (especially CASCADE)");
  assert.match(sync, /external foreign key|assertNoExternalReferencingForeignKeys/i);
  assert.match(sync, /new URL\s*\(/);
  assert.match(sync, /current_database\s*\(\)|verifyLocalDatabaseTarget/i);
  assert.match(sync, /restoreWorkItemParents|parent_id.*null/is, "work_items.parent_id is not imported in two FK-safe phases");
});

test("active runtime passes the zero-legacy-domain guard", () => {
  const output = execFileSync(process.execPath, [resolve(root, "scripts/guard-no-project-domain.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /zero unapproved legacy domain references/);
});

test("versioned migration artifacts are transactional, reversible, and drift-loud", () => {
  const forward = readFileSync(resolve(root, "supabase/migrations/030_projects_to_loops_total_cutover.sql"), "utf8");
  const migrationDir = resolve(root, "ops/migrations/20260726_loops_cutover");
  const preflight = readFileSync(resolve(migrationDir, "preflight.sql"), "utf8");
  const postflight = readFileSync(resolve(migrationDir, "postflight.sql"), "utf8");
  const rollback = readFileSync(resolve(migrationDir, "rollback.sql"), "utf8");

  assert.match(forward, /^BEGIN;/m);
  assert.match(forward, /^COMMIT;/m);
  assert.match(rollback, /^BEGIN;/m);
  assert.match(rollback, /^COMMIT;/m);
  for (const sql of [forward, preflight, postflight, rollback]) {
    assert.match(sql, /lock_timeout/i);
    assert.match(sql, /statement_timeout/i);
    assert.doesNotMatch(sql, /DECLARE[^;]*;\s*DECLARE/is, "PL/pgSQL block repeats DECLARE");
  }
  assert.match(forward, /source tables are absent/);
  assert.match(preflight, /source tables absent/);
  assert.match(postflight, /legacy domain tables remain/);
  assert.match(preflight, /destination controlled (?:keys|values)/i);
  assert.match(preflight, /work_items\.project_id.*orphan|orphan work_items\.project_id/is);
  assert.match(postflight, /work_items\.loop_id.*orphan|orphan work_items\.loop_id/is);
  assert.match(forward, /source_type[\s\S]*DROP CONSTRAINT[\s\S]*ADD CONSTRAINT/i);
  assert.match(rollback, /source_type[\s\S]*DROP CONSTRAINT[\s\S]*ADD CONSTRAINT/i);
  assert.match(forward, /quick_project_box/);
  assert.match(forward, /quick_loop_box/);
  assert.match(rollback, /quick_project_box/);
  assert.match(rollback, /quick_loop_box/);
  assert.match(postflight, /quick_project_box/);
  assert.match(postflight, /project-planner/);

  // Migration 030 is a reversible namespace/value cutover, not a schema normalizer.
  for (const destructiveShapeChange of [
    /RENAME COLUMN title TO name/i,
    /DROP COLUMN title/i,
    /acceptance_criteria_loop/i,
    /ALTER COLUMN acceptance_criteria TYPE/i,
    /ALTER COLUMN id SET DEFAULT/i,
    /ADD CONSTRAINT loop_work_items_pkey PRIMARY KEY/i,
  ]) {
    assert.doesNotMatch(forward, destructiveShapeChange);
  }

  for (const [legacy, canonical] of [
    ["source_project_id", "source_loop_id"],
    ["source_project_title", "source_loop_title"],
    ["materialized_from_project", "materialized_from_loop"],
    ["project_status_at_materialization", "loop_status_at_materialization"],
    ["superseded_for_project_id", "superseded_for_loop_id"],
  ]) {
    assert.match(forward, new RegExp(legacy));
    assert.match(forward, new RegExp(canonical));
    assert.match(rollback, new RegExp(legacy));
    assert.match(rollback, new RegExp(canonical));
  }
});
