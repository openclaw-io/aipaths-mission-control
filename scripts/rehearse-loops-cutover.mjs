#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

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
  'project','project-planner',
  '{"source_project_id":"10000000-0000-0000-0000-000000000001","materialized_from_project":true,"nested":{"materializer":"project-execution-materializer"}}'::jsonb
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

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function schemaFingerprint(client) {
  const result = await client.query(`
    select jsonb_build_object(
      'columns', (select jsonb_agg(to_jsonb(c) order by c.table_name,c.ordinal_position)
        from (select table_name,ordinal_position,column_name,data_type,udt_name,is_nullable,column_default
                from information_schema.columns
               where table_schema='public' and table_name in ('projects','project_events','project_work_items','work_items')) c),
      'constraints', (select jsonb_agg(to_jsonb(c) order by c.table_name,c.conname)
        from (select conrelid::regclass::text as table_name,conname,contype,confdeltype,pg_get_constraintdef(oid) as definition
                from pg_constraint
               where conrelid in ('public.projects'::regclass,'public.project_events'::regclass,'public.project_work_items'::regclass,'public.work_items'::regclass)) c),
      'indexes', (select jsonb_agg(to_jsonb(i) order by i.tablename,i.indexname)
        from (select tablename,indexname,indexdef from pg_indexes
               where schemaname='public' and tablename in ('projects','project_events','project_work_items','work_items')) i)
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
  return result.rows[0].fingerprint;
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

export async function runLoopsCutoverRehearsal({ adminConnectionString = process.env.LOOPS_REHEARSAL_ADMIN_URL || "postgres:///postgres" } = {}) {
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

    await scratch.query(fixtureSql);
    const schemaBefore = await schemaFingerprint(scratch);
    const dataBefore = await dataFingerprint(scratch,"project");

    await scratch.query(preflight);
    await scratch.query(forward);
    await scratch.query(postflight);

    const transformed = await scratch.query(`
      select wi.source_type,wi.requested_by,wi.payload,l.metadata,le.event_type,le.actor,le.payload as event_payload,
             pg_get_constraintdef(c.oid) as source_type_check
        from public.work_items wi
        cross join public.loops l
        cross join public.loop_events le
        join pg_constraint c on c.conrelid='public.work_items'::regclass and c.conname='work_items_source_type_check'
    `);
    const row = transformed.rows[0];
    if (row.source_type !== "loop" || row.requested_by !== "loop-planner" || row.event_type !== "loop.created" || row.actor !== "loop-planner") {
      throw new Error(`controlled column transformation failed: ${JSON.stringify(row)}`);
    }
    if (row.metadata.created_from !== "quick_loop_box" || row.metadata.nested.normalized_by !== "loop-planner"
      || row.event_payload.source !== "quick_loop_box" || row.event_payload.nested.planner !== "loop-planner"
      || !row.payload.source_loop_id || row.payload.source_project_id
      || row.payload.nested.materializer !== "loop-execution-materializer"
      || !row.source_type_check.includes("'loop'::text") || row.source_type_check.includes("'project'::text")) {
      throw new Error(`controlled JSON/CHECK transformation failed: ${JSON.stringify(row)}`);
    }
    await assertCheckBehavior(scratch,"loop","project");

    await scratch.query(rollback);
    await assertCheckBehavior(scratch,"project","loop");
    const schemaAfter = await schemaFingerprint(scratch);
    const dataAfter = await dataFingerprint(scratch,"project");
    if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore)) throw new Error("rollback schema fingerprint differs from pre-cutover schema");
    if (JSON.stringify(dataAfter) !== JSON.stringify(dataBefore)) throw new Error("rollback data fingerprint differs from pre-cutover data");

    return { database, forward: "passed", postflight: "passed", rollback: "passed", exactSchemaAndData: true };
  } finally {
    if (scratch) await scratch.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runLoopsCutoverRehearsal();
    console.log(`Loops PostgreSQL rehearsal passed: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
