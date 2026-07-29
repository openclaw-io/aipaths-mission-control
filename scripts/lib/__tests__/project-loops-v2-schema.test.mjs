import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 2 });

after(async () => pool.end());

test("fresh schema exposes the additive Project Loops V2 core contract", async () => {
  const columns = await pool.query(`
    select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public'
       and table_name = any($1::text[])
     order by table_name, ordinal_position
  `, [[
    "loops",
    "loop_plan_revisions",
    "loop_stages",
    "loop_tasks",
    "loop_task_dependencies",
    "loop_task_runs",
    "loop_task_reviews",
    "loop_evidence",
  ]]);
  const byTable = Map.groupBy(columns.rows, (row) => row.table_name);

  assert.deepEqual(
    Array.from(byTable.keys()).sort(),
    [
      "loop_evidence",
      "loop_plan_revisions",
      "loop_stages",
      "loop_task_dependencies",
      "loop_task_reviews",
      "loop_task_runs",
      "loop_tasks",
      "loops",
    ],
  );

  const loopColumns = Object.fromEntries(byTable.get("loops").map((row) => [row.column_name, row]));
  assert.equal(loopColumns.workflow_version.data_type, "smallint");
  assert.equal(loopColumns.workflow_version.is_nullable, "NO");
  assert.match(loopColumns.workflow_version.column_default, /1/);
  assert.equal(loopColumns.mode.data_type, "text");
  assert.equal(loopColumns.mode.is_nullable, "NO");
  assert.match(loopColumns.mode.column_default, /linear/);
  assert.equal(loopColumns.current_plan_revision_id.data_type, "uuid");
  assert.equal(loopColumns.current_plan_revision_id.is_nullable, "YES");
  assert.equal(loopColumns.row_version.data_type, "bigint");
  assert.equal(loopColumns.row_version.is_nullable, "NO");
  assert.match(loopColumns.row_version.column_default, /1/);

  const requiredColumns = {
    loop_plan_revisions: ["id", "loop_id", "revision_number", "status", "summary", "created_by", "approved_by", "approved_at", "created_at", "updated_at"],
    loop_stages: ["id", "plan_revision_id", "key", "title", "description", "position", "status", "created_at", "updated_at"],
    loop_tasks: ["id", "stage_id", "key", "title", "description", "position", "status", "assignee_agent", "metadata", "created_at", "updated_at"],
    loop_task_dependencies: ["task_id", "depends_on_task_id", "dependency_type", "created_at"],
    loop_task_runs: ["id", "task_id", "attempt_number", "status", "started_at", "finished_at", "error", "output", "created_at", "updated_at"],
    loop_task_reviews: ["id", "task_id", "task_run_id", "status", "reviewer", "feedback", "decided_at", "created_at", "updated_at"],
    loop_evidence: ["id", "task_id", "task_run_id", "kind", "uri", "content", "metadata", "created_at"],
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    assert.deepEqual(byTable.get(table).map((row) => row.column_name), expected, table);
  }
});

test("V2 foreign keys, checks, and query indexes enforce the minimum safe graph", async () => {
  const constraints = await pool.query(`
    select c.conname, c.contype, c.condeferrable, c.condeferred,
           child.relname as child_table,
           parent.relname as parent_table,
           c.confdeltype,
           pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_namespace n on n.oid = child.relnamespace
      left join pg_class parent on parent.oid = c.confrelid
     where n.nspname = 'public'
       and (child.relname = 'loops' or child.relname like 'loop_%')
  `);
  const byName = new Map(constraints.rows.map((row) => [row.conname, row]));

  const currentRevisionFk = byName.get("loops_current_plan_revision_id_fkey");
  assert.equal(currentRevisionFk.parent_table, "loop_plan_revisions");
  assert.equal(currentRevisionFk.confdeltype, "n", "current revision deletion must SET NULL");
  assert.equal(currentRevisionFk.condeferrable, true);
  assert.equal(currentRevisionFk.condeferred, true);

  const expectedForeignKeys = new Map([
    ["loop_plan_revisions_loop_id_fkey", ["loop_plan_revisions", "loops", "c"]],
    ["loop_stages_plan_revision_id_fkey", ["loop_stages", "loop_plan_revisions", "c"]],
    ["loop_tasks_stage_id_fkey", ["loop_tasks", "loop_stages", "c"]],
    ["loop_task_dependencies_task_id_fkey", ["loop_task_dependencies", "loop_tasks", "c"]],
    ["loop_task_dependencies_depends_on_task_id_fkey", ["loop_task_dependencies", "loop_tasks", "c"]],
    ["loop_task_runs_task_id_fkey", ["loop_task_runs", "loop_tasks", "c"]],
    ["loop_task_reviews_task_id_fkey", ["loop_task_reviews", "loop_tasks", "c"]],
    ["loop_task_reviews_task_run_id_fkey", ["loop_task_reviews", "loop_task_runs", "n"]],
    ["loop_evidence_task_id_fkey", ["loop_evidence", "loop_tasks", "c"]],
    ["loop_evidence_task_run_id_fkey", ["loop_evidence", "loop_task_runs", "n"]],
  ]);
  for (const [name, expected] of expectedForeignKeys) {
    const fk = byName.get(name);
    assert.ok(fk, `${name} is missing`);
    assert.deepEqual([fk.child_table, fk.parent_table, fk.confdeltype], expected, name);
  }

  for (const check of [
    "loops_workflow_version_check",
    "loops_mode_check",
    "loops_row_version_check",
    "loop_plan_revisions_revision_number_check",
    "loop_plan_revisions_status_check",
    "loop_stages_status_check",
    "loop_tasks_status_check",
    "loop_task_dependencies_not_self_check",
    "loop_task_runs_status_check",
    "loop_task_reviews_status_check",
    "loop_evidence_payload_check",
  ]) assert.equal(byName.get(check)?.contype, "c", `${check} is missing`);

  const indexes = await pool.query(`
    select indexname from pg_indexes
     where schemaname = 'public' and indexname = any($1::text[])
  `, [[
    "uq_loop_plan_revisions_loop_revision",
    "idx_loop_plan_revisions_loop_status",
    "uq_loop_stages_revision_key",
    "idx_loop_stages_revision_position",
    "uq_loop_tasks_stage_key",
    "idx_loop_tasks_stage_position",
    "idx_loop_tasks_status",
    "idx_loop_task_dependencies_depends_on",
    "uq_loop_task_runs_task_attempt",
    "idx_loop_task_runs_task_created",
    "idx_loop_task_reviews_task_created",
    "idx_loop_evidence_task_created",
  ]]);
  assert.equal(indexes.rowCount, 12);

  const forbidden = await pool.query(`
    select table_name from information_schema.tables
     where table_schema = 'public'
       and (table_name like 'loop%outbox%' or table_name like 'loop%lease%' or table_name like 'loop%cost%')
  `);
  assert.equal(forbidden.rowCount, 0, "phase 1 must not add outbox, lease, or cost tables");
});

test("legacy inserts remain V1/linear while the circular current revision FK is safely deferred", async () => {
  const client = await pool.connect();
  const legacyId = randomUUID();
  const v2Id = randomUUID();
  const revisionId = randomUUID();
  try {
    await client.query("begin");
    const legacy = (await client.query(
      "insert into public.loops (id, key, name) values ($1, $2, 'Legacy') returning workflow_version, mode, current_plan_revision_id, row_version",
      [legacyId, `phase1-legacy-${legacyId}`],
    )).rows[0];
    assert.deepEqual(legacy, {
      workflow_version: 1,
      mode: "linear",
      current_plan_revision_id: null,
      row_version: "1",
    });

    await client.query(
      `insert into public.loops (id, key, name, workflow_version, mode, current_plan_revision_id)
       values ($1, $2, 'V2 shadow fixture', 2, 'dag', $3)`,
      [v2Id, `phase1-v2-${v2Id}`, revisionId],
    );
    await client.query(
      `insert into public.loop_plan_revisions (id, loop_id, revision_number, status)
       values ($1, $2, 1, 'approved')`,
      [revisionId, v2Id],
    );
    await client.query("set constraints loops_current_plan_revision_id_fkey immediate");
    await client.query("rollback");
  } finally {
    client.release();
  }
});
