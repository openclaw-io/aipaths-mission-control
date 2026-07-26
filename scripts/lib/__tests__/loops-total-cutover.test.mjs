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

test("local Loop review preserves the migrated local shape without assuming last_completed_at", () => {
  const reviewRoute = readFileSync(resolve(root, "src/app/api/loops/[id]/review/route.ts"), "utf8");
  const localBranch = reviewRoute.slice(reviewRoute.indexOf("if (useLocalMode)"), reviewRoute.indexOf("const supabase = createServiceClient"));
  assert.doesNotMatch(localBranch, /last_completed_at/i);
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

test("cutover migrates each store independently and treats sync drift as an abort", () => {
  const runbook = readFileSync(resolve(root, "ops/migrations/20260726_loops_cutover/README.md"), "utf8");
  assert.match(runbook, /independently in each store/i);
  assert.match(runbook, /sync is not a cutover step/i);
  assert.match(runbook, /sync is expected to abort.*drift/is);
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
  assert.match(forward, /pipeline_items[\s\S]*project_id[\s\S]*loop_id/i);
  assert.match(forward, /recurrence_rules[\s\S]*project_id[\s\S]*loop_id/i);
  assert.match(forward, /cutover_created/i, "forward lacks the specially named fallback primary_execution index");
  assert.match(rollback, /DROP INDEX[\s\S]*cutover_created/i);
  assert.match(postflight, /indisunique[\s\S]*primary_execution/i, "postflight does not verify the partial unique index definition");
  assert.match(preflight, /orphan[\s\S]*source_type[\s\S]*source_id|source_type[\s\S]*source_id[\s\S]*orphan/i);
  assert.match(forward, /orphaned_source_loop_id/);
  assert.match(postflight, /orphaned_source_loop_id/);
  assert.match(rollback, /orphaned_source_loop_id/);
  assert.match(forward, /source_type_loop_cutover_created/i, "forward lacks a permissive no-project CHECK fallback");
  assert.match(rollback, /source_type_loop_cutover_created/i);

  const cutoverArtifacts = { forward, preflight, postflight, rollback };
  for (const [name, sql] of Object.entries(cutoverArtifacts)) {
    assert.doesNotMatch(sql, /ALTER\s+(?:TABLE\s+[^;]+\s+)?(?:COLUMN\s+)?source_id\s+TYPE/i, `${name} must preserve the existing source_id type`);
    assert.doesNotMatch(sql, /\b(?:p|l)\.id::text\s*=\s*wi\.source_id(?!::text)/, `${name} has a one-sided source_id ID comparison`);
    assert.doesNotMatch(sql, /IS DISTINCT FROM\s+wi\.source_id(?!::text)/, `${name} has a one-sided source_id marker comparison`);
  }
  assert.match(forward, /p\.id::text\s*=\s*wi\.source_id::text/);
  assert.match(preflight, /p\.id::text\s*=\s*wi\.source_id::text/);
  assert.match(postflight, /l\.id::text\s*=\s*wi\.source_id::text/);
  assert.match(rollback, /l\.id::text\s*=\s*wi\.source_id::text/);
  assert.match(postflight, /orphaned_source_loop_id[^;]*::text\s+IS DISTINCT FROM\s+wi\.source_id::text/is);
  assert.match(rollback, /orphaned_source_loop_id[^;]*::text\s+IS DISTINCT FROM\s+wi\.source_id::text/is);

  const rehearsal = readFileSync(resolve(root, "scripts/rehearse-loops-cutover.mjs"), "utf8");
  assert.match(rehearsal, /source_id uuid/);
  assert.match(rehearsal, /ALTER COLUMN source_id TYPE text USING source_id::text/);
  assert.match(rehearsal, /assertSourceIdWrites/);
  assert.match(rehearsal, /orphaned_source_loop_id/);

  for (const sql of [forward, rollback]) {
    assert.doesNotMatch(sql, /\bCREATE\s+TEMP(?:ORARY)?\b|\bpg_temp\b|\bON\s+COMMIT\b/i, "cutover artifacts must not depend on session-local objects");
    assert.doesNotMatch(sql, /^\s*LOCK\s+TABLE\b/im, "statement-by-statement autocommit cannot retain explicit locks across statements");
    assert.doesNotMatch(sql, /^\s*SET\s+LOCAL\s+(?:lock|statement)_timeout\b/im, "SQL Editor autocommit needs session timeouts, not SET LOCAL");
    assert.match(sql, /^SET lock_timeout\b/m);
    assert.match(sql, /^SET statement_timeout\b/m);
    assert.match(sql, /^RESET lock_timeout\b/m);
    assert.match(sql, /^RESET statement_timeout\b/m);
    assert.match(sql, /__mc_loops_cutover_20260726/);
  }
  assert.ok(rollback.indexOf("rollback_entry_guard") < rollback.indexOf("CREATE OR REPLACE FUNCTION"), "rollback provenance guard must precede its first catalog mutation");
  assert.match(rollback, /Projects namespace has no cutover provenance metadata[\s\S]*refusing all mutation/i);
  for (const sql of [preflight, forward]) {
    assert.match(sql, /conname ILIKE '%loop%'/i, "missing broad Loop-named constraint provenance gate");
    assert.match(sql, /indexname ILIKE '%loop%'/i, "missing broad Loop-named index provenance gate");
    assert.match(sql, /position\('''loop'''[\s\S]*position\('''project'''/i, "missing exact source CHECK transformability gate");
    assert.match(sql, /indnkeyatts=1 AND i\.indnatts=1[\s\S]*relation_type = ''primary_execution''::text/i, "missing exact unique-partial index shape gate");
  }
  assert.equal((forward.match(/checkpoint: recoverable-mutation/g) || []).length, 14, "every mutating forward statement needs a recovery checkpoint");
  assert.match(forward, /recovery metadata\/helper already exists[\s\S]*rollback/i);
  assert.match(forward, /DROP FUNCTION[\s\S]*DROP TABLE/i, "successful forward must clean namespaced helpers");
  assert.match(rollback, /DROP FUNCTION IF EXISTS[\s\S]*DROP TABLE IF EXISTS/i, "rollback must clean namespaced helpers");
  assert.match(rollback, /mixed\/ambiguous|exactly one complete namespace/i);

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
