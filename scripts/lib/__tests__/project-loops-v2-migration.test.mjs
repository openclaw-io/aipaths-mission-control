import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl,
  databaseUrlForName,
  generateMissionControlTestDatabaseName,
  quotePostgresIdentifier,
} from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const forwardPath = resolve(repoRoot, "supabase/migrations/032_project_loops_v2_foundation.sql");
const artifactDir = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase1");
const rollbackPath = resolve(artifactDir, "rollback.sql");
const verifyPath = resolve(artifactDir, "verify.sql");
const runbookPath = resolve(artifactDir, "README.md");
const syncPath = resolve(repoRoot, "scripts/sync-local-core-from-cloud.mjs");

test("phase 1 artifacts are additive, transactional, manual, and explicitly keep V2 runtime off", () => {
  const forward = readFileSync(forwardPath, "utf8");
  const rollback = readFileSync(rollbackPath, "utf8");
  const verify = readFileSync(verifyPath, "utf8");
  const runbook = readFileSync(runbookPath, "utf8");
  const sync = readFileSync(syncPath, "utf8");

  assert.match(forward, /^BEGIN;/m);
  assert.match(forward, /^COMMIT;/m);
  assert.match(rollback, /^BEGIN;/m);
  assert.match(rollback, /^COMMIT;/m);
  assert.match(verify, /TRANSACTION READ ONLY/i);
  assert.doesNotMatch(forward, /\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?public\.loops\b/i, "no mutable live backfill");
  assert.doesNotMatch(forward, /CREATE TABLE[^;]*(?:outbox|lease|cost)/i);
  assert.match(runbook, /no activa|runtime V2.*apagado/is);
  assert.match(runbook, /no.*backfill/is);
  assert.match(runbook, /cada.*store|independiente/is);
  assert.match(runbook, /backup/i);

  const syncOrder = [
    'name: "loops"',
    'name: "loop_plan_revisions"',
    'name: "loop_stages"',
    'name: "loop_tasks"',
    'name: "loop_task_dependencies"',
    'name: "loop_task_runs"',
    'name: "loop_task_reviews"',
    'name: "loop_evidence"',
  ].map((needle) => sync.indexOf(needle));
  assert.equal(syncOrder.every((position) => position >= 0), true, "sync must include every V2 core table");
  assert.deepEqual(syncOrder, syncOrder.slice().sort((left, right) => left - right), "sync must insert V2 parents before children");
  assert.match(sync, /\["loops", "current_plan_revision_id", "loop_plan_revisions", "id"\]/);
  assert.match(sync, /\["loop_evidence", "task_run_id", "loop_task_runs", "id"\]/);
});

test("migration 032 rehearses forward, read-only verification, constraint behavior, and exact legacy rollback", async () => {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const databaseName = generateMissionControlTestDatabaseName();
  const databaseUrl = databaseUrlForName(adminUrl, databaseName);
  const admin = new pg.Client({ connectionString: adminUrl });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotePostgresIdentifier(databaseName)}`);
    created = true;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`
        create extension if not exists pgcrypto;
        create table public.loops (
          id uuid primary key default gen_random_uuid(),
          key text unique,
          name text not null,
          plan jsonb not null default '[]'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        insert into public.loops (id, key, name, plan, created_at, updated_at)
        values (
          '00000000-0000-0000-0000-000000000032',
          'legacy-before-v2',
          'Legacy before V2',
          '[{"id":"one","title":"Keep me","status":"pending"}]'::jsonb,
          '2026-07-29T00:00:00Z',
          '2026-07-29T00:00:00Z'
        );
      `);
      const beforeColumns = (await client.query(`
        select column_name, data_type, is_nullable, column_default
          from information_schema.columns
         where table_schema='public' and table_name='loops'
         order by ordinal_position
      `)).rows;
      const beforeRow = (await client.query("select * from public.loops order by id")).rows;

      await client.query(readFileSync(forwardPath, "utf8"));
      await client.query(readFileSync(verifyPath, "utf8"));

      const legacy = (await client.query(`
        select key, name, plan, workflow_version, mode, current_plan_revision_id, row_version
          from public.loops where key='legacy-before-v2'
      `)).rows[0];
      assert.deepEqual(legacy, {
        key: "legacy-before-v2",
        name: "Legacy before V2",
        plan: [{ id: "one", title: "Keep me", status: "pending" }],
        workflow_version: 1,
        mode: "linear",
        current_plan_revision_id: null,
        row_version: "1",
      });

      await assert.rejects(
        () => client.query("insert into public.loops (name, workflow_version) values ('bad', 0)"),
        (error) => error.code === "23514",
      );

      await client.query(readFileSync(rollbackPath, "utf8"));
      const afterColumns = (await client.query(`
        select column_name, data_type, is_nullable, column_default
          from information_schema.columns
         where table_schema='public' and table_name='loops'
         order by ordinal_position
      `)).rows;
      const afterRow = (await client.query("select * from public.loops order by id")).rows;
      const v2Tables = await client.query(`
        select table_name from information_schema.tables
         where table_schema='public' and table_name = any($1::text[])
      `, [[
        "loop_plan_revisions", "loop_stages", "loop_tasks", "loop_task_dependencies",
        "loop_task_runs", "loop_task_reviews", "loop_evidence",
      ]]);

      assert.deepEqual(afterColumns, beforeColumns);
      assert.deepEqual(afterRow, beforeRow);
      assert.equal(v2Tables.rowCount, 0);
    } finally {
      await client.end();
    }
  } finally {
    if (created) {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${quotePostgresIdentifier(databaseName)}`);
    }
    await admin.end();
  }
});
