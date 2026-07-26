#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { executeSqlEditorStatements, splitTopLevelSql } from "./lib/sql-editor-harness.mjs";

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = resolve(root, "ops/migrations/20260726_loops_cutover");
const forwardPath = resolve(root, "supabase/migrations/030_projects_to_loops_total_cutover.sql");

const fixtureSql = `
CREATE TABLE public.projects (
  id uuid PRIMARY KEY,
  key text UNIQUE,
  name text,
  title text,
  acceptance_criteria jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_completed_at timestamptz
);
CREATE TABLE public.work_items (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES public.work_items(id) ON DELETE SET NULL,
  source_type text,
  source_id uuid,
  status text NOT NULL DEFAULT 'ready',
  requested_by text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT work_items_source_type_check CHECK (source_type IS NULL OR source_type = ANY (ARRAY['manual'::text,'service'::text,'project'::text]))
);
CREATE TABLE public.project_events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.project_work_items (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  PRIMARY KEY (project_id,work_item_id,relation_type)
);
CREATE INDEX idx_work_items_project ON public.work_items(project_id);
CREATE INDEX idx_project_events_project ON public.project_events(project_id);
CREATE INDEX idx_project_work_items_project ON public.project_work_items(project_id);

INSERT INTO public.projects VALUES (
  '10000000-0000-0000-0000-000000000001','P-1','Local name','Cloud title',
  '["preserve","jsonb"]'::jsonb,
  '{"created_from":"quick_project_box","nested":{"normalized_by":"project-planner"}}'::jsonb,
  NULL
);
INSERT INTO public.work_items VALUES (
  '20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',NULL,
  'project','10000000-0000-0000-0000-000000000001','ready','project-planner',
  '{"source_project_id":"10000000-0000-0000-0000-000000000001","materialized_from_project":true,"nested":{"materializer":"project-execution-materializer"}}'::jsonb
);
INSERT INTO public.work_items VALUES (
  '20000000-0000-0000-0000-000000000002',NULL,NULL,
  'project','ffffffff-ffff-ffff-ffff-ffffffffffff','done','system','{}'::jsonb
);
INSERT INTO public.work_items VALUES (
  '20000000-0000-0000-0000-000000000003',NULL,NULL,
  'manual',NULL,'ready','system','{}'::jsonb
);
INSERT INTO public.project_events VALUES (
  '30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  'project.created','project-planner',
  '{"source":"quick_project_box","project_status_at_materialization":"planning","nested":{"planner":"project-planner"}}'::jsonb
);
INSERT INTO public.project_work_items VALUES (
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','primary_execution'
);
`;

const cloudShapeOptionalSql = `
CREATE TABLE public.pipeline_items (
  id uuid PRIMARY KEY,
  project_id uuid,
  CONSTRAINT pipeline_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL
);
CREATE INDEX idx_pipeline_items_project_id ON public.pipeline_items(project_id);
CREATE TABLE public.recurrence_rules (
  id uuid PRIMARY KEY,
  project_id uuid,
  CONSTRAINT recurrence_rules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_recurrence_rules_project_id ON public.recurrence_rules(project_id);
INSERT INTO public.pipeline_items VALUES ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
INSERT INTO public.recurrence_rules VALUES ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
`;

const localShapeOptionalSql = `
CREATE TABLE public.pipeline_items (
  id uuid PRIMARY KEY,
  stage text NOT NULL DEFAULT 'queued',
  CONSTRAINT pipeline_items_projectless_stage_check CHECK (stage <> '')
);
CREATE INDEX idx_pipeline_items_projectless_stage ON public.pipeline_items(stage);
INSERT INTO public.pipeline_items(id,stage) VALUES ('40000000-0000-0000-0000-000000000001','ready');
`;

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function schemaFingerprint(client) {
  const result = await client.query(`
    select jsonb_build_object(
      'columns', (select jsonb_agg(to_jsonb(c) order by c.table_name,c.ordinal_position)
        from (select table_name,ordinal_position,column_name,data_type,udt_name,is_nullable,column_default
                from information_schema.columns
               where table_schema='public' and table_name in ('projects','project_events','project_work_items','work_items','pipeline_items','recurrence_rules')) c),
      'constraints', (select jsonb_agg(to_jsonb(c) order by c.table_name,c.conname)
        from (select r.relname as table_name,c.conname,c.contype,c.confdeltype,pg_get_constraintdef(c.oid) as definition
                from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
               where n.nspname='public' and r.relname in ('projects','project_events','project_work_items','work_items','pipeline_items','recurrence_rules')) c),
      'indexes', (select jsonb_agg(to_jsonb(i) order by i.tablename,i.indexname)
        from (select tablename,indexname,indexdef from pg_indexes
               where schemaname='public'
                 and tablename not like '__mc_loops_cutover_20260726%') i)
    ) as fingerprint
  `);
  return result.rows[0].fingerprint;
}

async function dataFingerprint(client, namespace = "project") {
  const p = namespace === "project" ? "projects" : "loops";
  const e = namespace === "project" ? "project_events" : "loop_events";
  const m = namespace === "project" ? "project_work_items" : "loop_work_items";
  const relationColumn = namespace === "project" ? "project_id" : "loop_id";
  const result = await client.query(`
    select jsonb_build_object(
      '${p}', (select jsonb_agg(to_jsonb(t) order by id) from public.${p} t),
      'work_items', (select jsonb_agg(to_jsonb(t) order by id) from public.work_items t),
      '${e}', (select jsonb_agg(to_jsonb(t) order by id) from public.${e} t),
      '${m}', (select jsonb_agg(to_jsonb(t) order by ${relationColumn},work_item_id,relation_type) from public.${m} t)
    ) as fingerprint
  `);
  const fingerprint = result.rows[0].fingerprint;
  for (const relation of ["pipeline_items", "recurrence_rules"]) {
    const exists = await client.query("select to_regclass($1) is not null as present", [`public.${relation}`]);
    fingerprint[relation] = exists.rows[0].present
      ? (await client.query(`select jsonb_agg(to_jsonb(t) order by id) as rows from public.${relation} t`)).rows[0].rows
      : null;
  }
  return fingerprint;
}

async function assertCheckBehavior(client, accepted, rejected) {
  await client.query("BEGIN");
  try {
    await client.query("UPDATE public.work_items SET source_type=$1", [accepted]);
    await client.query("SAVEPOINT rejected_source_type");
    let rejectedByCheck = false;
    try {
      await client.query("UPDATE public.work_items SET source_type=$1", [rejected]);
    } catch (error) {
      rejectedByCheck = error?.code === "23514";
      await client.query("ROLLBACK TO SAVEPOINT rejected_source_type");
    }
    if (!rejectedByCheck) throw new Error(`source_type CHECK accepted forbidden value ${rejected}`);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function assertDuplicatePrimaryExecutionRejected(client) {
  await client.query("BEGIN");
  try {
    let code;
    try {
      await client.query(`insert into public.loop_work_items(loop_id,work_item_id,relation_type)
        values ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','primary_execution')`);
    } catch (error) {
      code = error?.code;
    }
    if (code !== "23505") throw new Error(`duplicate primary_execution did not fail with 23505 (received ${code || "success"})`);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function assertSourceIdWrites(client, expectedType) {
  await client.query("BEGIN");
  try {
    const inserted = await client.query(`
      INSERT INTO public.work_items (id,loop_id,parent_id,source_type,source_id,status,requested_by,payload)
      VALUES ('20000000-0000-0000-0000-000000000005',NULL,NULL,'loop',
              '10000000-0000-0000-0000-000000000001','ready','system','{}')
      RETURNING source_id::text AS source_id,pg_typeof(source_id)::text AS source_id_type
    `);
    if (inserted.rows[0]?.source_id_type !== expectedType
      || inserted.rows[0]?.source_id !== "10000000-0000-0000-0000-000000000001") {
      throw new Error(`source_id insert changed shape/value: ${JSON.stringify(inserted.rows[0])}`);
    }
    const updated = await client.query(`
      UPDATE public.work_items
         SET source_id='ffffffff-ffff-ffff-ffff-ffffffffffff',
             status='done',
             payload=jsonb_build_object('orphaned_source_loop_id','ffffffff-ffff-ffff-ffff-ffffffffffff')
       WHERE id='20000000-0000-0000-0000-000000000005'
       RETURNING source_id::text AS source_id,pg_typeof(source_id)::text AS source_id_type,
                 payload->>'orphaned_source_loop_id' AS marker
    `);
    if (updated.rows[0]?.source_id_type !== expectedType
      || updated.rows[0]?.source_id !== "ffffffff-ffff-ffff-ffff-ffffffffffff"
      || updated.rows[0]?.marker !== updated.rows[0]?.source_id) {
      throw new Error(`source_id update/payload marker changed shape/value: ${JSON.stringify(updated.rows[0])}`);
    }
  } finally {
    await client.query("ROLLBACK");
  }
}

async function assertGateRejects(client, sql, expectedPattern, label) {
  let rejected = false;
  try {
    await client.query(sql);
  } catch (error) {
    rejected = error?.code === "P0001" && expectedPattern.test(String(error?.message));
    await client.query("ROLLBACK").catch(() => {});
  }
  if (!rejected) throw new Error(`${label} gate did not reject the adversarial fixture`);
}

async function helperObjectCount(client) {
  const result = await client.query(`
    select count(*)::int as count from (
      select 'class:'||n.nspname||'.'||c.relname as object_name
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where c.relname like '__mc_loops_cutover_20260726%'
      union
      select 'proc:'||n.nspname||'.'||p.proname
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where p.proname like '__mc_loops_cutover_20260726%'
      union
      select 'constraint:'||c.conname from pg_constraint c
       where c.conname like '__mc_loops_cutover_20260726%'
      union
      select 'trigger:'||t.tgname from pg_trigger t
       where not t.tgisinternal and t.tgname like '__mc_loops_cutover_20260726%'
      union
      select 'namespace:'||n.nspname from pg_namespace n
       where n.nspname like '__mc_loops_cutover_20260726%'
    ) helpers
  `);
  return result.rows[0]?.count ?? -1;
}

async function assertExactProjectFingerprint(client, schemaBefore, dataBefore, label) {
  const schemaAfter = await schemaFingerprint(client);
  const dataAfter = await dataFingerprint(client, "project");
  if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore)) throw new Error(`${label} changed schema fingerprint`);
  if (JSON.stringify(dataAfter) !== JSON.stringify(dataBefore)) throw new Error(`${label} changed data fingerprint`);
}

export async function runLoopsCutoverRehearsal({
  adminConnectionString = process.env.LOOPS_REHEARSAL_ADMIN_URL || "postgres:///postgres",
  executionMode = "transactional",
  injectFailureAfterRename = false,
  injectFailureAfterEveryMutation = false,
} = {}) {
  const database = `mc_loops_rehearsal_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminConnectionString });
  let scratch;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const adminUrl = new URL(adminConnectionString.includes("://") ? adminConnectionString : "postgres://localhost/postgres");
    adminUrl.pathname = `/${database}`;
    scratch = new Client({ connectionString: adminUrl.toString() });
    await scratch.connect();

    const [preflight, forward, postflight, rollback] = await Promise.all([
      readFile(resolve(migrationDir,"preflight.sql"),"utf8"),
      readFile(forwardPath,"utf8"),
      readFile(resolve(migrationDir,"postflight.sql"),"utf8"),
      readFile(resolve(migrationDir,"rollback.sql"),"utf8"),
    ]);
    const executeArtifact = async (sql, label, options = {}) => executionMode === "sql-editor"
      ? executeSqlEditorStatements(scratch, sql, { label, ...options })
      : scratch.query(sql);

    await scratch.query(fixtureSql);
    await scratch.query(cloudShapeOptionalSql);

    const assertArtifactRejectsWithoutMutation = async (sql, label, expectedPattern) => {
      const schemaBefore = await schemaFingerprint(scratch);
      const dataBefore = await dataFingerprint(scratch, "project");
      let rejected = false;
      try {
        await executeArtifact(sql, label);
      } catch (error) {
        rejected = error?.code === "P0001" && expectedPattern.test(String(error?.message));
        await scratch.query("ROLLBACK").catch(() => {});
      }
      if (!rejected) throw new Error(`${label} did not reject before mutation`);
      await assertExactProjectFingerprint(scratch, schemaBefore, dataBefore, label);
    };

    // Reviewer adversary 1: rollback on an untouched Projects namespace has no
    // provenance. It must reject in its first non-control statement and leave an
    // exact schema+data fingerprint with no helper objects.
    await assertArtifactRejectsWithoutMutation(rollback, "rollback-without-provenance", /no cutover provenance metadata|refusing all mutation/i);
    if (await helperObjectCount(scratch) !== 0) throw new Error("rollback-without-provenance created a helper object");

    // Reviewer adversary 2: any pre-existing Loop token on a participating
    // index is reserved, even when the index is otherwise a legitimate source object.
    await scratch.query("CREATE INDEX idx_work_items_loop_marker ON public.work_items(id)");
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-loop-index-provenance", /index names.*reserved token loop/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-loop-index-provenance", /index names.*reserved token loop/i);
    await scratch.query("DROP INDEX public.idx_work_items_loop_marker");

    // Reviewer adversary 3: the fallback index name is schema-global in
    // PostgreSQL, not local to participating relations. Both entry gates must
    // reject it on an unrelated table, and recovery must not delete an
    // unprovenanced index that appears after forward has started. The global
    // index fingerprint makes an accidental DROP observable.
    await scratch.query("CREATE TABLE public.unrelated_cutover_name_holder(id uuid PRIMARY KEY)");
    await scratch.query(`CREATE INDEX uq_loop_work_items_primary_execution__cutover_created
      ON public.unrelated_cutover_name_holder(id)`);
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-global-fallback-index-name", /fallback index name.*globally reserved/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-global-fallback-index-name", /fallback index name.*globally reserved/i);
    await scratch.query("DROP INDEX public.uq_loop_work_items_primary_execution__cutover_created");

    const metadataCheckpoint = splitTopLevelSql(forward)
      .find((statement) => statement.includes("recoverable-mutation metadata-created"));
    if (!metadataCheckpoint) throw new Error("forward metadata checkpoint is absent");
    await scratch.query(metadataCheckpoint);
    await scratch.query(`CREATE INDEX uq_loop_work_items_primary_execution__cutover_created
      ON public.unrelated_cutover_name_holder(id)`);
    const recoverySchemaBefore = await schemaFingerprint(scratch);
    const recoveryDataBefore = await dataFingerprint(scratch, "project");
    await executeArtifact(rollback, "rollback-preserves-unprovenanced-global-index");
    await assertExactProjectFingerprint(
      scratch,
      recoverySchemaBefore,
      recoveryDataBefore,
      "rollback-preserves-unprovenanced-global-index",
    );
    await scratch.query("DROP TABLE public.unrelated_cutover_name_holder");

    // Reviewer adversary 4: reserve the fallback CHECK name so rollback can
    // never mistake a source constraint for one created by this cutover.
    await scratch.query(`ALTER TABLE public.work_items
      ADD CONSTRAINT work_items_source_type_loop_cutover_created
      CHECK (source_type IS NULL OR source_type=ANY(ARRAY['manual'::text,'service'::text,'project'::text]))`);
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-reserved-fallback-check", /constraint names.*reserved token loop/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-reserved-fallback-check", /constraint names.*reserved token loop/i);
    await scratch.query("ALTER TABLE public.work_items DROP CONSTRAINT work_items_source_type_loop_cutover_created");

    // Every source_type CHECK must be exactly transformable. No CHECK remains an
    // explicitly supported source shape and is exercised by the normal cycles.
    await scratch.query("ALTER TABLE public.work_items ADD CONSTRAINT source_type_without_project CHECK (source_type IS NULL OR source_type<>'forbidden')");
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-check-without-project", /not exactly transformable.*project literal/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-check-without-project", /not exactly transformable.*project literal/i);
    await scratch.query("ALTER TABLE public.work_items DROP CONSTRAINT source_type_without_project");
    await scratch.query("ALTER TABLE public.work_items ADD CONSTRAINT source_type_with_destination CHECK (source_type IS NULL OR source_type<>'loop')");
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-check-with-loop-literal", /not exactly transformable.*no loop literal/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-check-with-loop-literal", /not exactly transformable.*no loop literal/i);
    await scratch.query("ALTER TABLE public.work_items DROP CONSTRAINT source_type_with_destination");

    // The entire helper prefix is reserved, and forward uses the same broad gate.
    await scratch.query("CREATE TABLE public.__mc_loops_cutover_20260726_unexpected_helper(id integer)");
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-unexpected-helper", /metadata\/helper exists/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-unexpected-helper", /metadata\/helper already exists/i);
    if (await helperObjectCount(scratch) === 0) throw new Error("helper residue gate unexpectedly removed the adversarial helper");
    await scratch.query("DROP TABLE public.__mc_loops_cutover_20260726_unexpected_helper");

    // Preflight duplicates forward's exact unique-partial multiplicity, key, and
    // predicate gate instead of allowing a late post-mutation failure.
    await scratch.query(`CREATE UNIQUE INDEX uq_project_primary_execution_a
      ON public.project_work_items(project_id) WHERE relation_type='primary_execution'`);
    await scratch.query(`CREATE UNIQUE INDEX uq_project_primary_execution_b
      ON public.project_work_items(project_id) WHERE relation_type='primary_execution'`);
    await assertArtifactRejectsWithoutMutation(preflight, "preflight-primary-index-multiplicity", /exact primary_execution uniqueness indexes.*at most one/i);
    await assertArtifactRejectsWithoutMutation(forward, "forward-primary-index-multiplicity", /exact primary_execution uniqueness indexes.*at most one/i);
    await scratch.query("DROP INDEX public.uq_project_primary_execution_a, public.uq_project_primary_execution_b");

    if (injectFailureAfterEveryMutation) {
      if (executionMode !== "sql-editor") throw new Error("all-checkpoint injection requires executionMode=sql-editor");
      const checkpointLabels = splitTopLevelSql(forward)
        .map((statement) => statement.match(/checkpoint:\s*recoverable-mutation\s+([a-z0-9-]+)/i)?.[1])
        .filter(Boolean);
      if (checkpointLabels.length === 0) throw new Error("forward has no recoverable mutation checkpoints");

      for (const checkpoint of checkpointLabels) {
        const schemaBefore = await schemaFingerprint(scratch);
        const dataBefore = await dataFingerprint(scratch, "project");
        await executeSqlEditorStatements(scratch, preflight, { label: `preflight-before-${checkpoint}` });
        let injected = false;
        try {
          await executeSqlEditorStatements(scratch, forward, {
            label: `forward-inject-${checkpoint}`,
            afterStatement: ({ statement }) => {
              if (statement.includes(`recoverable-mutation ${checkpoint}`)) {
                injected = true;
                throw new Error(`INJECTED_FAILURE_AFTER_${checkpoint}`);
              }
            },
          });
        } catch (error) {
          if (!injected || !String(error?.message).includes(`INJECTED_FAILURE_AFTER_${checkpoint}`)) throw error;
        }
        if (!injected) throw new Error(`forward checkpoint was not reached: ${checkpoint}`);
        await executeSqlEditorStatements(scratch, rollback, { label: `rollback-after-${checkpoint}` });
        await assertExactProjectFingerprint(scratch, schemaBefore, dataBefore, `recovery after ${checkpoint}`);
        const helpers = await helperObjectCount(scratch);
        if (helpers !== 0) throw new Error(`recovery after ${checkpoint} left ${helpers} helper objects`);
      }
      return {
        database,
        executionMode,
        injectedFailure: "after-every-recoverable-mutation",
        checkpoints: checkpointLabels,
        checkpointCount: checkpointLabels.length,
        rollback: "passed",
        exactSchemaAndData: true,
        helperObjectsRemaining: 0,
        adversarialReviewerCases: "rejected-with-exact-fingerprints",
      };
    }

    if (injectFailureAfterRename) {
      const schemaBefore = await schemaFingerprint(scratch);
      const dataBefore = await dataFingerprint(scratch, "project");
      await executeArtifact(preflight, "preflight");
      let injected = false;
      try {
        await executeArtifact(forward, "forward", {
          afterStatement: ({ statement }) => {
            if (/ALTER TABLE public\.projects RENAME TO loops/i.test(statement)) {
              injected = true;
              throw new Error("INJECTED_FAILURE_AFTER_RENAME");
            }
          },
        });
      } catch (error) {
        if (!injected || !/INJECTED_FAILURE_AFTER_RENAME/.test(String(error?.message))) throw error;
      }
      if (!injected) throw new Error("forward rename checkpoint was not reached");
      await executeArtifact(rollback, "rollback-after-injected-forward");
      const schemaAfter = await schemaFingerprint(scratch);
      const dataAfter = await dataFingerprint(scratch, "project");
      if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore)) throw new Error("partial-forward rollback schema fingerprint differs");
      if (JSON.stringify(dataAfter) !== JSON.stringify(dataBefore)) throw new Error("partial-forward rollback data fingerprint differs");
      const helpers = await scratch.query(`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname like '__mc_loops_cutover_20260726%'`);
      const helperFunctions = await scratch.query(`select n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like '__mc_loops_cutover_20260726%'`);
      if (helpers.rowCount || helperFunctions.rowCount) throw new Error("rollback left cutover helper objects");
      return {
        database,
        executionMode,
        injectedFailure: "after-rename",
        rollback: "passed",
        exactSchemaAndData: true,
        helperObjectsRemaining: 0,
      };
    }

    const executeCycle = async ({ sourceCheck, adversarialPostflight = false, shape, sourceIdType }) => {
      const schemaBefore = await schemaFingerprint(scratch);
      const dataBefore = await dataFingerprint(scratch,"project");
      await executeArtifact(preflight, "preflight");
      await executeArtifact(forward, "forward");
      await executeArtifact(postflight, "postflight");

      const migratedSourceIdType = await scratch.query(
        "select udt_name from information_schema.columns where table_schema='public' and table_name='work_items' and column_name='source_id'",
      );
      if (migratedSourceIdType.rows[0]?.udt_name !== sourceIdType) {
        throw new Error(`forward modified work_items.source_id type (${shape}): ${migratedSourceIdType.rows[0]?.udt_name}`);
      }

      const transformed = await scratch.query(`
        select wi.source_type,wi.requested_by,wi.payload,l.metadata,le.event_type,le.actor,le.payload as event_payload
          from public.work_items wi cross join public.loops l cross join public.loop_events le
         where wi.id='20000000-0000-0000-0000-000000000001'
      `);
      const row = transformed.rows[0];
      if (row.source_type !== "loop" || row.requested_by !== "loop-planner" || row.event_type !== "loop.created" || row.actor !== "loop-planner") {
        throw new Error(`controlled column transformation failed: ${JSON.stringify(row)}`);
      }
      if (row.metadata.created_from !== "quick_loop_box" || row.metadata.nested.normalized_by !== "loop-planner"
        || row.event_payload.source !== "quick_loop_box" || row.event_payload.nested.planner !== "loop-planner"
        || !row.payload.source_loop_id || row.payload.source_project_id
        || row.payload.nested.materializer !== "loop-execution-materializer") {
        throw new Error(`controlled JSON transformation failed: ${JSON.stringify(row)}`);
      }
      const orphan = await scratch.query("select payload from public.work_items where id='20000000-0000-0000-0000-000000000002'");
      if (orphan.rows[0]?.payload?.orphaned_source_loop_id !== "ffffffff-ffff-ffff-ffff-ffffffffffff") {
        throw new Error(`terminal orphan was not explicitly marked: ${JSON.stringify(orphan.rows[0])}`);
      }
      await assertCheckBehavior(scratch,"loop","project");
      await assertDuplicatePrimaryExecutionRejected(scratch);
      await assertSourceIdWrites(scratch,sourceIdType);

      if (adversarialPostflight) {
        const leftovers = [
          ["ALTER TABLE public.pipeline_items ADD COLUMN project_id uuid", "ALTER TABLE public.pipeline_items DROP COLUMN project_id", /project_id columns/, "legacy column"],
          ["ALTER TABLE public.pipeline_items ADD CONSTRAINT pipeline_items_project_marker CHECK (true)", "ALTER TABLE public.pipeline_items DROP CONSTRAINT pipeline_items_project_marker", /constraint names/, "legacy constraint"],
          ["CREATE INDEX idx_pipeline_items_project_marker ON public.pipeline_items(id)", "DROP INDEX public.idx_pipeline_items_project_marker", /index names/, "legacy index"],
        ];
        for (const [inject, cleanup, expected, label] of leftovers) {
          await scratch.query(inject);
          await assertGateRejects(scratch, postflight, expected, `postflight ${label}`);
          await scratch.query(cleanup);
        }
      }

      await executeArtifact(rollback, "rollback");
      if (sourceCheck) await assertCheckBehavior(scratch,"project","loop");
      const remainingHelpers = await scratch.query(`
        select count(*)::int as count from (
          select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname like '__mc_loops_cutover_20260726%'
          union all
          select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname like '__mc_loops_cutover_20260726%'
        ) helpers
      `);
      if (remainingHelpers.rows[0]?.count !== 0) throw new Error(`rollback left ${remainingHelpers.rows[0]?.count} helper objects`);
      const schemaAfter = await schemaFingerprint(scratch);
      const dataAfter = await dataFingerprint(scratch,"project");
      const rolledBackSourceIdType = await scratch.query(
        "select udt_name from information_schema.columns where table_schema='public' and table_name='work_items' and column_name='source_id'",
      );
      if (rolledBackSourceIdType.rows[0]?.udt_name !== sourceIdType) {
        throw new Error(`rollback modified work_items.source_id type (${shape}): ${rolledBackSourceIdType.rows[0]?.udt_name}`);
      }
      if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore)) throw new Error(`rollback schema fingerprint differs (${shape}, ${sourceCheck ? "existing CHECK" : "no CHECK"})`);
      if (JSON.stringify(dataAfter) !== JSON.stringify(dataBefore)) throw new Error(`rollback data fingerprint differs (${shape}, ${sourceCheck ? "existing CHECK" : "no CHECK"})`);
    };

    await executeCycle({ sourceCheck: true, adversarialPostflight: true, shape: "cloud-shape", sourceIdType: "uuid" });
    await scratch.query("ALTER TABLE public.work_items DROP CONSTRAINT work_items_source_type_check");
    await scratch.query("CREATE UNIQUE INDEX uq_project_work_items_primary_execution ON public.project_work_items(project_id) WHERE relation_type='primary_execution'");
    await executeCycle({ sourceCheck: false, shape: "cloud-shape", sourceIdType: "uuid" });

    await scratch.query("DROP TABLE public.recurrence_rules, public.pipeline_items");
    await scratch.query("ALTER TABLE public.work_items ALTER COLUMN source_id TYPE text USING source_id::text");
    await scratch.query(localShapeOptionalSql);
    await executeCycle({ sourceCheck: false, shape: "local-shape", sourceIdType: "text" });

    await scratch.query("ALTER TABLE public.pipeline_items ADD COLUMN loop_id uuid");
    await assertGateRejects(scratch, preflight, /destination.*pipeline_items\.loop_id|pipeline_items\.loop_id.*collision/i, "preflight optional destination-column collision");
    await scratch.query("ALTER TABLE public.pipeline_items DROP COLUMN loop_id");

    await scratch.query(`insert into public.work_items
      (id,project_id,parent_id,source_type,source_id,status,requested_by,payload)
      values ('20000000-0000-0000-0000-000000000004',null,null,'project','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','ready','system','{}')`);
    await assertGateRejects(scratch, preflight, /non-terminal.*orphan source_id/, "preflight non-terminal orphan");
    await scratch.query("delete from public.work_items where id='20000000-0000-0000-0000-000000000004'");

    return {
      database, executionMode, forward: "passed", postflight: "passed", rollback: "passed", exactSchemaAndData: true,
      scenarios: ["cloud-shape", "local-shape"],
      sourceIdTypes: { "cloud-shape": "uuid", "local-shape": "text" },
      duplicateSqlState: "23505", adversarialPostflight: "rejected-column-constraint-index", orphanPreflight: "rejected-non-terminal",
      optionalDestinationCollision: "rejected",
      adversarialReviewerCases: "rejected-with-exact-fingerprints",
    };
  } finally {
    if (scratch) await scratch.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executionMode = process.argv.includes("--sql-editor") ? "sql-editor" : "transactional";
    const injectFailureAfterRename = process.argv.includes("--inject-after-rename");
    const injectFailureAfterEveryMutation = process.argv.includes("--inject-all-checkpoints");
    const result = await runLoopsCutoverRehearsal({ executionMode, injectFailureAfterRename, injectFailureAfterEveryMutation });
    console.log(`Loops PostgreSQL rehearsal passed: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
