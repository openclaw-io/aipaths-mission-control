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
    loop_plan_revisions: ["id", "loop_id", "revision_number", "status", "summary", "content_hash", "plan_snapshot", "created_by", "approved_by", "approved_at", "created_at", "updated_at"],
    loop_stages: ["id", "plan_revision_id", "key", "title", "description", "position", "status", "created_at", "updated_at"],
    loop_tasks: ["id", "stage_id", "key", "title", "description", "position", "status", "assignee_agent", "metadata", "created_at", "updated_at"],
    loop_task_dependencies: ["task_id", "depends_on_task_id", "dependency_type", "created_at"],
    loop_task_runs: ["id", "task_id", "work_item_id", "execution_attempt_id", "run_role", "quality_cycle", "attempt_number", "status", "started_at", "finished_at", "error", "output", "created_at", "updated_at", "server_session_id", "artifact_sha", "target_run_id", "target_sha", "repository_id", "base_sha"],
    loop_task_reviews: ["id", "task_id", "task_run_id", "status", "reviewer", "feedback", "decided_at", "created_at", "updated_at", "review_run_id", "quality_cycle", "reviewed_sha", "reviewer_session_id", "findings", "decision_id"],
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
  assert.equal(currentRevisionFk.confdeltype, "a", "a V2 current revision cannot be deleted into an invalid NULL state");
  assert.equal(currentRevisionFk.condeferrable, true);
  assert.equal(currentRevisionFk.condeferred, true);

  const expectedForeignKeys = new Map([
    ["loop_plan_revisions_loop_id_fkey", ["loop_plan_revisions", "loops", "c"]],
    ["loop_stages_plan_revision_id_fkey", ["loop_stages", "loop_plan_revisions", "c"]],
    ["loop_tasks_stage_id_fkey", ["loop_tasks", "loop_stages", "c"]],
    ["loop_task_dependencies_task_id_fkey", ["loop_task_dependencies", "loop_tasks", "c"]],
    ["loop_task_dependencies_depends_on_task_id_fkey", ["loop_task_dependencies", "loop_tasks", "c"]],
    ["loop_task_runs_task_id_fkey", ["loop_task_runs", "loop_tasks", "c"]],
    ["loop_task_runs_work_item_id_fkey", ["loop_task_runs", "work_items", "r"]],
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
    "loops_workflow_state_check",
    "loop_plan_revisions_revision_number_check",
    "loop_plan_revisions_status_check",
    "loop_stages_status_check",
    "loop_tasks_status_check",
    "loop_task_dependencies_not_self_check",
    "loop_task_runs_status_check",
    "loop_task_runs_run_role_check",
    "loop_task_runs_quality_cycle_check",
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
    "uq_loop_task_runs_work_item",
    "idx_loop_task_runs_task_created",
    "idx_loop_task_reviews_task_created",
    "idx_loop_evidence_task_created",
  ]]);
  assert.equal(indexes.rowCount, 13);

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
      `insert into public.loop_plan_revisions (id, loop_id, revision_number, status, content_hash, plan_snapshot)
       values ($1, $2, 1, 'approved', $3, '{}'::jsonb)`,
      [revisionId, v2Id, "0".repeat(64)],
    );
    await client.query("set constraints loops_current_plan_revision_id_fkey immediate");
    await client.query("savepoint delete_current_revision");
    await assert.rejects(
      () => client.query("delete from public.loop_plan_revisions where id=$1", [revisionId]),
      (error) => error.code === "23514" && /approved loop plan revision is immutable/i.test(error.message),
      "deleting the selected revision must fail rather than violate loops_workflow_state_check",
    );
    await client.query("rollback to savepoint delete_current_revision");
    await client.query("rollback");
  } finally {
    client.release();
  }
});

test("concurrent dependency writers serialize per revision and cannot commit a cycle", async () => {
  const first = await pool.connect();
  const second = await pool.connect();
  const ids = Object.fromEntries([
    "loop", "revision", "stage", "taskA", "taskB",
  ].map((key) => [key, randomUUID()]));
  try {
    await first.query(`insert into public.loops (id, key, name) values ($1, $2, 'Concurrent graph')`,
      [ids.loop, `concurrent-graph-${ids.loop}`]);
    await first.query(`insert into public.loop_plan_revisions (id, loop_id, revision_number) values ($1, $2, 1)`,
      [ids.revision, ids.loop]);
    await first.query(`insert into public.loop_stages (id, plan_revision_id, key, title) values ($1, $2, 'stage', 'Stage')`,
      [ids.stage, ids.revision]);
    await first.query(`insert into public.loop_tasks (id, stage_id, key, title) values
      ($1, $2, 'a', 'A'), ($3, $2, 'b', 'B')`, [ids.taskA, ids.stage, ids.taskB]);

    await first.query("begin");
    await first.query("insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)",
      [ids.taskA, ids.taskB]);
    await second.query("begin");
    const competingInsert = second.query(
      "insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)",
      [ids.taskB, ids.taskA],
    );

    let waiting = false;
    for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
      const state = await first.query(
        "select wait_event_type, wait_event from pg_stat_activity where pid=$1",
        [second.processID],
      );
      waiting = state.rows[0]?.wait_event_type === "Lock" && state.rows[0]?.wait_event === "advisory";
      if (!waiting) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(waiting, true, "competing graph mutation must wait on the revision advisory lock");

    await first.query("commit");
    await assert.rejects(() => competingInsert, /cycle/i);
    await second.query("rollback");
  } finally {
    await first.query("rollback").catch(() => {});
    await second.query("rollback").catch(() => {});
    await first.query("delete from public.loops where id=$1", [ids.loop]).catch(() => {});
    first.release();
    second.release();
  }
});

test("stage and task structural membership is immutable after insert", async () => {
  const client = await pool.connect();
  const ids = Object.fromEntries([
    "loop", "revisionA", "revisionB", "stageA", "stageB", "task",
  ].map((key) => [key, randomUUID()]));
  try {
    await client.query("begin");
    await client.query(`insert into public.loops (id, key, name) values ($1, $2, 'Immutable graph')`,
      [ids.loop, `immutable-graph-${ids.loop}`]);
    await client.query(`insert into public.loop_plan_revisions (id, loop_id, revision_number) values
      ($1, $2, 1), ($3, $2, 2)`, [ids.revisionA, ids.loop, ids.revisionB]);
    await client.query(`insert into public.loop_stages (id, plan_revision_id, key, title) values
      ($1, $2, 'a', 'A'), ($3, $4, 'b', 'B')`, [ids.stageA, ids.revisionA, ids.stageB, ids.revisionB]);
    await client.query(`insert into public.loop_tasks (id, stage_id, key, title) values ($1, $2, 'task', 'Task')`,
      [ids.task, ids.stageA]);

    await client.query("savepoint move_task");
    await assert.rejects(
      () => client.query("update public.loop_tasks set stage_id=$1 where id=$2", [ids.stageB, ids.task]),
      (error) => error.code === "23514" && /structural membership.*immutable/i.test(error.message),
    );
    await client.query("rollback to savepoint move_task");

    await client.query("savepoint move_stage");
    await assert.rejects(
      () => client.query("update public.loop_stages set plan_revision_id=$1 where id=$2", [ids.revisionB, ids.stageA]),
      (error) => error.code === "23514" && /structural membership.*immutable/i.test(error.message),
    );
    await client.query("rollback to savepoint move_stage");
    await client.query("rollback");
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
});

test("a task move racing an edge insert cannot invalidate the committed graph", async () => {
  const first = await pool.connect();
  const second = await pool.connect();
  const ids = Object.fromEntries([
    "loop", "revisionA", "revisionB", "stageA", "stageB", "taskA", "taskB",
  ].map((key) => [key, randomUUID()]));
  try {
    await first.query(`insert into public.loops (id, key, name) values ($1, $2, 'Membership race')`,
      [ids.loop, `membership-race-${ids.loop}`]);
    await first.query(`insert into public.loop_plan_revisions (id, loop_id, revision_number) values
      ($1, $2, 1), ($3, $2, 2)`, [ids.revisionA, ids.loop, ids.revisionB]);
    await first.query(`insert into public.loop_stages (id, plan_revision_id, key, title) values
      ($1, $2, 'a', 'A'), ($3, $4, 'b', 'B')`, [ids.stageA, ids.revisionA, ids.stageB, ids.revisionB]);
    await first.query(`insert into public.loop_tasks (id, stage_id, key, title) values
      ($1, $2, 'a', 'A'), ($3, $2, 'b', 'B')`, [ids.taskA, ids.stageA, ids.taskB]);

    await first.query("begin");
    await first.query("insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)",
      [ids.taskA, ids.taskB]);

    await second.query("begin");
    const moveAttempt = second.query(
      "update public.loop_tasks set stage_id=$1 where id=$2",
      [ids.stageB, ids.taskA],
    ).then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    const beforeEdgeCommit = await Promise.race([
      moveAttempt,
      new Promise((resolveWait) => setTimeout(() => resolveWait({ status: "pending" }), 50)),
    ]);
    assert.notEqual(beforeEdgeCommit.status, "fulfilled", "a racing move must never beat graph protection");
    await first.query("commit");
    const moveResult = beforeEdgeCommit.status === "pending" ? await moveAttempt : beforeEdgeCommit;
    assert.equal(moveResult.status, "rejected");
    assert.equal(moveResult.error.code, "23514");
    assert.match(moveResult.error.message, /structural membership.*immutable/i);
    await second.query("rollback");

    const graph = await first.query(`
      select dependency.task_id, dependency.depends_on_task_id,
             task_stage.plan_revision_id as task_revision,
             dependency_stage.plan_revision_id as dependency_revision
        from public.loop_task_dependencies dependency
        join public.loop_tasks task on task.id=dependency.task_id
        join public.loop_stages task_stage on task_stage.id=task.stage_id
        join public.loop_tasks depends_on on depends_on.id=dependency.depends_on_task_id
        join public.loop_stages dependency_stage on dependency_stage.id=depends_on.stage_id
       where dependency.task_id=$1 and dependency.depends_on_task_id=$2
    `, [ids.taskA, ids.taskB]);
    assert.equal(graph.rowCount, 1);
    assert.equal(graph.rows[0].task_revision, graph.rows[0].dependency_revision);
  } finally {
    await first.query("rollback").catch(() => {});
    await second.query("rollback").catch(() => {});
    await first.query("delete from public.loops where id=$1", [ids.loop]).catch(() => {});
    first.release();
    second.release();
  }
});

test("V2 graph rejects cross-loop current revisions, cross-revision edges, cycles, and mismatched run ownership", async () => {
  const client = await pool.connect();
  const ids = Object.fromEntries([
    "loopA", "loopB", "revisionA", "revisionB", "stageA", "stageB", "taskA1", "taskA2", "taskB", "runB",
  ].map((key) => [key, randomUUID()]));
  try {
    await client.query("begin");
    await client.query(`insert into public.loops (id, key, name) values
      ($1, $2, 'A'), ($3, $4, 'B')`, [ids.loopA, `graph-a-${ids.loopA}`, ids.loopB, `graph-b-${ids.loopB}`]);
    await client.query(`insert into public.loop_plan_revisions (id, loop_id, revision_number) values
      ($1, $2, 1), ($3, $4, 1)`, [ids.revisionA, ids.loopA, ids.revisionB, ids.loopB]);
    await client.query(`insert into public.loop_stages (id, plan_revision_id, key, title) values
      ($1, $2, 'a', 'A'), ($3, $4, 'b', 'B')`, [ids.stageA, ids.revisionA, ids.stageB, ids.revisionB]);
    await client.query(`insert into public.loop_tasks (id, stage_id, key, title) values
      ($1, $2, 'a1', 'A1'), ($3, $2, 'a2', 'A2'), ($4, $5, 'b', 'B')`,
      [ids.taskA1, ids.stageA, ids.taskA2, ids.taskB, ids.stageB]);
    await client.query(`insert into public.loop_task_runs (id, task_id) values ($1, $2)`, [ids.runB, ids.taskB]);

    await client.query("savepoint bad_current_revision");
    await client.query("update public.loops set workflow_version=2, mode='dag', current_plan_revision_id=$1 where id=$2", [ids.revisionB, ids.loopA]);
    await assert.rejects(
      () => client.query("set constraints loops_current_plan_revision_id_fkey immediate"),
      (error) => error.code === "23503",
    );
    await client.query("rollback to savepoint bad_current_revision");

    await client.query("savepoint cross_revision");
    await assert.rejects(
      () => client.query("insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)", [ids.taskA1, ids.taskB]),
      /same plan revision/i,
    );
    await client.query("rollback to savepoint cross_revision");

    await client.query("insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)", [ids.taskA1, ids.taskA2]);
    await client.query("savepoint cyclic_edge");
    await assert.rejects(
      () => client.query("insert into public.loop_task_dependencies (task_id, depends_on_task_id) values ($1, $2)", [ids.taskA2, ids.taskA1]),
      /cycle/i,
    );
    await client.query("rollback to savepoint cyclic_edge");

    for (const table of ["loop_task_reviews", "loop_evidence"]) {
      await client.query(`savepoint mismatched_${table}`);
      const sql = table === "loop_task_reviews"
        ? `insert into public.${table} (task_id, task_run_id, status, reviewed_sha) values ($1, $2, 'pending', '0000000000000000000000000000000000000000')`
        : `insert into public.${table} (task_id, task_run_id, kind, content) values ($1, $2, 'artifact', 'x')`;
      await assert.rejects(() => client.query(sql, [ids.taskA1, ids.runB]), (error) => error.code === "23503");
      await client.query(`rollback to savepoint mismatched_${table}`);
    }

    await client.query("rollback");
  } finally {
    client.release();
  }
});
