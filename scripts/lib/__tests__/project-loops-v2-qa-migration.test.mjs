import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertTestAdminDatabaseUrl, databaseUrlForName, generateMissionControlTestDatabaseName,
  quotePostgresIdentifier,
} from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifact = resolve(repoRoot, "ops/migrations/20260730_project_loops_v2_phase5b");

async function qaCatalog(client) {
  return {
    columns: (await client.query(`select table_name,column_name,data_type,is_nullable,column_default
      from information_schema.columns where table_schema='public' and table_name in ('qa_executions','qa_work_item_transition_authorities')
      order by table_name,column_name`)).rows,
    constraints: (await client.query(`select conname,pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid in ('public.qa_executions'::regclass,'public.qa_work_item_transition_authorities'::regclass,'public.loop_task_runs'::regclass,'public.loop_tasks'::regclass)
        and (conrelid in ('public.qa_executions'::regclass,'public.qa_work_item_transition_authorities'::regclass)
          or conname in ('loop_task_runs_run_role_check','loop_task_runs_role_target_check','loop_tasks_status_check'))
      order by conname`)).rows,
    functions: (await client.query(`select proname,provolatile,proisstrict,prosecdef,prorettype::regtype::text result_type,
      pg_get_function_identity_arguments(pg_proc.oid) arguments from pg_proc join pg_namespace n on n.oid=pronamespace
      where n.nspname='public' and proname in ('qa_jsonb_canonical','qa_jsonb_sha256','qa_policy_is_valid','qa_result_is_valid','transition_visual_qa_work_item','validate_loop_quality_integrity','validate_qa_execution_integrity','guard_visual_qa_work_item','guard_visual_qa_evidence','persist_visual_qa_evidence','reject_terminal_loop_quality_mutation','attach_visual_qa_execution_pid','bind_visual_qa_planner_session') order by proname`)).rows,
    triggers: (await client.query(`select tgname,pg_get_triggerdef(oid) definition from pg_trigger
      where not tgisinternal and tgname in ('loop_task_runs_quality_integrity','loop_task_reviews_quality_integrity','qa_executions_integrity','visual_qa_work_items_guard','visual_qa_evidence_guard','qa_executions_terminal_immutable') order by tgname`)).rows,
    indexes: (await client.query(`select tablename,indexname,indexdef from pg_indexes where schemaname='public'
      and (tablename='qa_executions' or indexname='idx_loop_evidence_visual_qa_uri') order by tablename,indexname`)).rows,
  };
}

test("migration 035 rehearses preflight, forward, read-only verify and guarded rollback", async () => {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const name = generateMissionControlTestDatabaseName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${quotePostgresIdentifier(name)}`);
    const client = new pg.Client({ connectionString: databaseUrlForName(adminUrl, name) });
    await client.connect();
    try {
      await client.query(readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8"));
      const localCatalog = await qaCatalog(client);
      await client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8"));
      assert.equal((await client.query("select to_regclass('public.qa_executions') relation")).rows[0].relation, null);
      await client.query(readFileSync(resolve(artifact, "preflight.sql"), "utf8"));
      assert.equal(readFileSync(resolve(repoRoot, "supabase/migrations/035_project_loops_v2_visual_qa.sql"), "utf8"),
        readFileSync(resolve(artifact, "forward.sql"), "utf8"), "migration 035 and ops forward must be byte-identical");
      await client.query(readFileSync(resolve(artifact, "forward.sql"), "utf8"));
      await client.query(readFileSync(resolve(repoRoot, "supabase/migrations/036_visual_qa_runner_v1.sql"), "utf8"));
      await client.query(readFileSync(resolve(artifact, "verify.sql"), "utf8"));
      assert.equal((await client.query("select to_regclass('public.qa_executions') relation")).rows[0].relation, "qa_executions");
      assert.match((await client.query("select pg_get_constraintdef(oid) definition from pg_constraint where conname='loop_task_runs_run_role_check'")).rows[0].definition, /qa/);
      assert.deepEqual(await qaCatalog(client), localCatalog, "local schema Phase 5B catalog must equal rollback + ops forward catalog");

      await client.query("create table public.phase5b_future_acl_rehearsal(id bigint primary key, value text not null)");
      await client.query("create sequence public.phase5b_future_sequence_rehearsal");
      await client.query("begin");
      await client.query("set local role aipaths_mc_app");
      await client.query("insert into public.phase5b_future_acl_rehearsal values (nextval('public.phase5b_future_sequence_rehearsal'),'usable')");
      assert.equal((await client.query("select value from public.phase5b_future_acl_rehearsal")).rows[0].value,"usable");
      await client.query("commit");
      await client.query("drop table public.phase5b_future_acl_rehearsal");
      await client.query("drop sequence public.phase5b_future_sequence_rehearsal");

      const loopId = (await client.query("insert into loops(name,status) values ('rollback QA event','blocked') returning id")).rows[0].id;
      const eventId = (await client.query(`insert into loop_events(loop_id,event_type,actor,payload)
        values ($1,'loop.qa_rehearsal','migration-test','{}') returning id`, [loopId])).rows[0].id;
      await assert.rejects(client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8")), /rollback refused: QA rows\/work\/status\/events exist/i);
      await client.query("rollback");
      assert.equal((await client.query("select count(*)::int n from loop_events where id=$1", [eventId])).rows[0].n, 1,
        "refused rollback must not delete the authority/event that caused refusal");
      await client.query("delete from loop_events where id=$1", [eventId]);
      await client.query("delete from loops where id=$1", [loopId]);
      await client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8"));
      assert.equal((await client.query("select to_regclass('public.qa_executions') relation")).rows[0].relation, null);
      for (const artifactName of ["qa_authority_secrets","qa_work_item_transition_authorities"]) {
        assert.equal((await client.query("select to_regclass($1) relation",[`public.${artifactName}`])).rows[0].relation,null);
      }
      for (const signature of ["claim_visual_qa_execution(jsonb,text,text)","heartbeat_visual_qa_execution(uuid,text)",
        "attach_visual_qa_execution_pid(uuid,integer,text,text)",
        "lock_visual_qa_execution(uuid)",
        "bind_visual_qa_planner_session(uuid,text,text)",
        "persist_visual_qa_evidence(uuid,text)",
        "guard_visual_qa_evidence()",
        "complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamp with time zone)",
        "reconcile_visual_qa_execution(uuid,text,timestamp with time zone)",
        "transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)","install_qa_authority_hmac_key(text)"]) {
        assert.equal((await client.query("select to_regprocedure($1) procedure",[`public.${signature}`])).rows[0].procedure,null,signature);
      }
      assert.equal((await client.query("select to_regclass('public.idx_loop_evidence_visual_qa_uri') relation")).rows[0].relation,null);
      const defaultAclResidue=(await client.query(`select count(*)::int n from pg_default_acl defaults
        cross join lateral aclexplode(defaults.defaclacl) acl join pg_roles grantee on grantee.oid=acl.grantee
        where defaults.defaclrole=(select oid from pg_roles where rolname=current_user)
          and defaults.defaclnamespace='public'::regnamespace and grantee.rolname='aipaths_mc_app'`)).rows[0].n;
      assert.equal(defaultAclResidue,0,"rollback must remove migration-executor default ACLs for app");
      const schemaResidue=(await client.query(`select
        has_schema_privilege('aipaths_mc_app','public','USAGE') app_usage,
        has_schema_privilege('aipaths_mc_app','public','CREATE') app_create,
        exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
          where n.nspname='public' and acl.grantee=0 and acl.privilege_type='CREATE') public_create`)).rows[0];
      assert.deepEqual({...schemaResidue},{app_usage:true,app_create:false,public_create:false},
        "rollback retains safe schema USAGE and the CREATE hardening");
    } finally { await client.end(); }
  } finally {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [name]);
    await admin.query(`drop database if exists ${quotePostgresIdentifier(name)}`);
    await admin.end();
  }
});

test("guarded rollback refuses any persisted QA authority", async () => {
  const client = new pg.Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL });
  await client.connect();
  try {
    // A row-free authority is enough for the rehearsal above; this assertion verifies the SQL guard is explicit
    // and executes before destructive DDL. Runtime behavior tests create fully-bound rows.
    const rollback = readFileSync(resolve(artifact, "rollback.sql"), "utf8");
    assert.match(rollback, /LOCK TABLE[\s\S]*qa_executions[\s\S]*IN ACCESS EXCLUSIVE MODE/i);
    assert.match(rollback, /EXISTS \(SELECT 1 FROM public\.qa_executions\)/i);
    assert.match(rollback, /visual_qa_v1/);
  } finally { await client.end(); }
});

test("fresh schema and upgrade migrations reject zero-byte QA evidence descriptors", () => {
  const sources = [
    "supabase/migrations/035_project_loops_v2_visual_qa.sql",
    "ops/migrations/20260730_project_loops_v2_phase5b/forward.sql",
    "supabase/migrations/036_visual_qa_runner_v1.sql",
    "ops/local-postgres/schema.sql",
  ];
  for (const sourcePath of sources) {
    const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
    assert.ok(source.includes("item->>'bytes' !~ '^[1-9][0-9]*$'"), `${sourcePath} must require bytes > 0`);
    assert.equal(source.includes("item->>'bytes' !~ '^(0|[1-9][0-9]*)$'"), false, `${sourcePath} must not accept zero bytes`);
  }
});

test("runner migration persists a birth token and binds it atomically in PID attach authority", () => {
  const migration = readFileSync(resolve(repoRoot, "supabase/migrations/036_visual_qa_runner_v1.sql"), "utf8");
  const localSchema = readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8");
  const verify = readFileSync(resolve(artifact, "verify.sql"), "utf8");
  const rollback = readFileSync(resolve(artifact, "rollback.sql"), "utf8");
  for (const source of [migration, localSchema]) {
    assert.match(source, /runner_birth_token text/);
    assert.match(source, /attach_visual_qa_execution_pid\(p_execution_id uuid,p_pid integer,p_runner_birth_token text,raw_capability text\)/);
    assert.match(source, /SET pid=p_pid,runner_birth_token=p_runner_birth_token/);
    assert.match(source, /lock_visual_qa_execution\(execution_id uuid\)[\s\S]*FOR UPDATE/);
  }
  assert.match(verify, /attach_visual_qa_execution_pid\(uuid,integer,text,text\)/);
  assert.match(verify, /lock_visual_qa_execution\(uuid\)/);
  assert.match(verify, /runner_birth_token/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.attach_visual_qa_execution_pid\(uuid,integer,text,text\)/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.lock_visual_qa_execution\(uuid\)/);
});

test("verify permits only a consumed pre-planner infrastructure failure without a planner session", () => {
  const verify = readFileSync(resolve(artifact, "verify.sql"), "utf8");
  assert.match(verify,
    /capability_revoked_at IS NULL AND e\.planner_session_id IS NULL[\s\S]*capability_consumed_at IS NOT NULL[\s\S]*result->>'verdict'='infrastructure_failure'/);
});

test("verify and rollback cover immutable Visual QA evidence authority", () => {
  const verify = readFileSync(resolve(artifact, "verify.sql"), "utf8");
  const rollback = readFileSync(resolve(artifact, "rollback.sql"), "utf8");
  for (const token of ["persist_visual_qa_evidence", "guard_visual_qa_evidence", "visual_qa_evidence_guard",
    "idx_loop_evidence_visual_qa_uri", "jsonb_array_elements", "qa_jsonb_sha256", "task_run_id", "result_hash"]) {
    assert.match(verify, new RegExp(token), `verify must cover ${token}`);
  }
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.persist_visual_qa_evidence\(uuid,text\)/);
  assert.match(rollback, /DROP TRIGGER IF EXISTS visual_qa_evidence_guard ON public\.loop_evidence/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.guard_visual_qa_evidence\(\)/);
  assert.match(rollback, /DROP INDEX IF EXISTS public\.idx_loop_evidence_visual_qa_uri/);
});

test("preflight and forward reject every membership edge touching either fixed role", async () => {
  const client = new pg.Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL });
  await client.connect();
  const suffix = generateMissionControlTestDatabaseName().replaceAll("-", "_").slice(-24);
  const app = `mc_edge_app_${suffix}`;
  const owner = `mc_edge_owner_${suffix}`;
  const other = `mc_edge_other_${suffix}`;
  const quote = (value) => quotePostgresIdentifier(value);
  try {
    await client.query(`create role ${quote(app)} noinherit; create role ${quote(owner)} noinherit; create role ${quote(other)} createdb createrole noinherit; create schema ${quote(other)} authorization ${quote(other)}`);
    const blocks = ["preflight.sql", "forward.sql"].map((name) => {
      const source = readFileSync(resolve(artifact, name), "utf8");
      const block = source.match(/IF EXISTS \(SELECT 1 FROM pg_auth_members[\s\S]*?END IF;/)?.[0];
      assert.ok(block, `${name} membership guard`);
      return block.replaceAll("aipaths_mc_app", app).replaceAll("aipaths_mc_qa_owner", owner);
    });
    for (const [granted, member] of [[other,app],[app,other],[other,owner],[owner,other]]) {
      await client.query(`grant ${quote(granted)} to ${quote(member)}`);
      try {
        for (const block of blocks) {
          await assert.rejects(client.query(`do $guard$ begin ${block} end $guard$`), /exactly zero membership edges/i);
        }
      } finally {
        await client.query(`revoke ${quote(granted)} from ${quote(member)}`);
      }
    }
  } finally {
    await client.query(`drop schema if exists ${quote(other)} cascade; drop role if exists ${quote(app)},${quote(owner)},${quote(other)}`).catch(() => {});
    await client.end();
  }
});
