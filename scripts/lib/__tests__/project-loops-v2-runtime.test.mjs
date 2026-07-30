import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import {
  assertTestAdminDatabaseUrl,
  databaseUrlForName,
  generateMissionControlTestDatabaseName,
  quotePostgresIdentifier,
  requireMissionControlTestDatabaseUrl,
} from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 8 });
const HEAD_SHA = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const REPOSITORY_KEY = "phase4-test-worktree";

function transpileModule(sourcePath, requires = {}, globals = {}) {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule, exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Date, Number, Set, Map, JSON, String, RegExp, Object, Array, Math, Promise, Error, URL, console,
    process: { env: { AGENT_API_KEY: "test-key" } },
    ...globals,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

async function postgresTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };
const localAuth = {
  isLocalAuthDisabled: () => true,
  getLocalMissionControlUser: () => ({ email: "v2-reviewer@example.test" }),
};
const qaPolicy = transpileModule(resolve(repoRoot, "src/lib/loops/qa-policy.ts"));
const executionInstruction = transpileModule(resolve(repoRoot, "src/lib/loops/execution-instruction.ts"));
const gitArtifact = transpileModule(resolve(repoRoot, "src/lib/work-items/git-artifact.ts"), {
  "node:child_process": { execFile }, "node:fs/promises": { realpath },
});
const createRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/project/create/route.ts"), {
  "node:crypto": { createHash, randomUUID }, "next/server": nextServer,
  "@/lib/auth/local": localAuth, "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/loops/qa-policy": qaPolicy,
});
const approveRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/[id]/approve/route.ts"), {
  "node:crypto": { createHash }, "next/server": nextServer, "@/lib/auth/local": localAuth,
  "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/supabase/server": { createClient: async () => { throw new Error("unexpected cloud auth"); } },
});
const materializeRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/materialize-queued/route.ts"), {
  "node:crypto": { createHash, randomUUID }, "next/server": nextServer,
  "@/lib/db/postgres": { query: (sql, params) => pool.query(sql, params), withTransaction: postgresTransaction },
  "@/lib/execution-window": {
    getExecutionWindowConfig: async () => ({}),
    isExecutionWindowOpenNow: () => ({ open: true, source: "test", mode: "open" }),
  },
  "@/lib/loops/execution-instruction": executionInstruction,
  "@/lib/work-items/git-artifact": gitArtifact,
  "@/lib/loops/lifecycle-local": {
    getPrimaryExecutionWorkItemLocal: async () => null,
    isPrimaryExecutionOpen: () => false,
    reconcileLoopStatusWithPrimaryExecutionLocal: async () => {},
    supersedePrimaryExecutionLinksLocal: async () => {},
  },
});
const reviewRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/[id]/review/route.ts"), {
  "node:crypto": { randomUUID }, "next/server": nextServer,
  "@/lib/auth/local": localAuth, "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/supabase/server": { createClient: async () => { throw new Error("unexpected cloud auth"); } },
  "@/lib/loops/execution-instruction": executionInstruction,
});
const youtubePipeline = transpileModule(resolve(repoRoot, "src/lib/youtube-pipeline.ts"));
const completion = transpileModule(resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts"), {
  "@/lib/youtube-pipeline": youtubePipeline,
  "@/lib/work-items/git-artifact": gitArtifact,
});
const agentCompletion = transpileModule(resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts"), {
  "@/lib/content/live-verification": { verifyPublishedContent: async () => { throw new Error("unexpected verification"); } },
  "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": { query: (sql, params) => pool.query(sql, params), withTransaction: postgresTransaction },
  "@/lib/work-items/completion-orchestration": completion,
});
const reviewCompletion = transpileModule(resolve(repoRoot, "src/lib/reviewer/review-completion.ts"), {
  "node:crypto": { randomUUID },
});

before(async () => {
  const identity = await gitArtifact.inspectRepositoryRegistration(repoRoot);
  await pool.query(`insert into review_repositories(key,canonical_root,git_common_dir,object_format)
    values ($1,$2,$3,$4) on conflict (canonical_root) do update set enabled=true`,
    [REPOSITORY_KEY, identity.canonicalRoot, identity.gitCommonDir, identity.objectFormat]);
});
after(async () => pool.end());

function chainPayload(overrides = {}) {
  return {
    idempotency_key: randomUUID(),
    title: "Ship serial V2 runtime",
    input: "Build the approved project without broadening scope.",
    owner_agent: "systems",
    repository: REPOSITORY_KEY,
    acceptance_criteria: ["Each task is completed in order", "Final review remains manual"],
    approval_scope: {
      allowed_actions: ["edit_repository", "run_tests"],
      forbidden_actions: ["deploy", "publish_external_output"],
      notes: "Do not touch live services.",
    },
    stages: [
      { key: "build", title: "Build", tasks: [
        { key: "one", title: "Implement foundation", description: "Only implement the foundation." },
        { key: "two", title: "Connect runtime", description: "Only connect the runtime.", depends_on: ["one"] },
      ] },
      { key: "verify", title: "Verify", tasks: [
        { key: "three", title: "Verify result", description: "Only verify the approved result.", depends_on: [{ key: "two", type: "hard" }] },
      ] },
    ],
    ...overrides,
  };
}

async function invokeCreate(body) { return createRoute.POST({ json: async () => body }); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}
async function invokeApprove(loopId, body = {}) {
  const revision = (await pool.query(
    "select current_plan_revision_id plan_revision_id, content_hash plan_hash from loops join loop_plan_revisions on loop_plan_revisions.id=loops.current_plan_revision_id where loops.id=$1",
    [loopId],
  )).rows[0] || {};
  return approveRoute.POST({ json: async () => ({ action: "approve", queue: true, decision_id: randomUUID(), ...revision, ...body }) },
    { params: Promise.resolve({ id: loopId }) });
}
async function invokeMaterialize() {
  return materializeRoute.POST({ headers: { get: () => "Bearer test-key" } });
}
async function invokeReview(loopId, body) {
  return reviewRoute.POST({ json: async () => ({ decision_id: randomUUID(), ...body }) },
    { params: Promise.resolve({ id: loopId }) });
}
async function rowsFor(loopId) {
  return pool.query(`select t.key,t.status,r.status as run_status,r.work_item_id,r.repository_id,r.base_sha,
      wi.status as work_status,wi.instruction,wi.payload
    from loop_tasks t join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
    left join loop_task_runs r on r.task_id=t.id left join work_items wi on wi.id=r.work_item_id
    where p.loop_id=$1 order by s.position,t.position`, [loopId]);
}
async function activeFreshWork(loopId) {
  return (await pool.query(`select wi.id,wi.status,wi.payload,r.id run_id,r.run_role,r.quality_cycle,t.id task_id,t.key
    from work_items wi join loop_task_runs r on r.work_item_id=wi.id join loop_tasks t on t.id=r.task_id
    join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
    where p.loop_id=$1 and wi.status in ('ready','in_progress') order by r.created_at desc,r.id desc limit 1`, [loopId])).rows[0];
}
async function assignDispatch(workItemId, sessionId = randomUUID()) {
  await pool.query("update work_items set status='in_progress',payload=payload||jsonb_build_object('dispatch_session_id',$2::text) where id=$1 and status in ('ready','in_progress')", [workItemId, sessionId]);
  return sessionId;
}
async function completeImplementationAndApprove(loopId, implementation, sha = HEAD_SHA) {
  const implementationId = implementation.work_item_id || implementation.id;
  const implementerSession = await assignDispatch(implementationId);
  await agentCompletion.patchAgentWorkItemWithCompletion(implementationId, {
    status: "done", execution_attempt_id: implementation.payload.execution_attempt_id,
    output: { head_sha: sha, repository_path: repoRoot },
  });
  const review = await activeFreshWork(loopId);
  assert.equal(review.run_role, "review");
  let reviewerSession = randomUUID();
  while (reviewerSession === implementerSession) reviewerSession = randomUUID();
  await assignDispatch(review.id, reviewerSession);
  await postgresTransaction(async (client) => {
    await client.query("update loop_task_runs set status='running',started_at=now(),updated_at=now() where id=$1 and status='queued'", [review.run_id]);
    const execution = (await client.query(`select 'running'::text status,'in_progress'::text work_status,r.id review_run_id,r.work_item_id,r.execution_attempt_id,
      r.repository_id,r.base_sha,r.target_sha,r.task_id,r.quality_cycle,r.target_run_id implementation_run_id,
      impl.server_session_id implementer_session_id,t.status task_status,t.title task_title,s.id stage_id,
      s.plan_revision_id,p.content_hash plan_hash,l.id loop_id,l.status loop_status,l.priority,l.owner_agent
      from loop_task_runs r join loop_task_runs impl on impl.id=r.target_run_id join loop_tasks t on t.id=r.task_id
      join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
      join loops l on l.id=p.loop_id where r.id=$1 for update of r,t,l`, [review.run_id])).rows[0];
    await reviewCompletion.applyReviewerResult(client, execution,
      { verdict: "approved", feedback: null, findings: [] }, reviewerSession);
  });
  return review;
}
async function cleanup(loopId) {
  // Approved graphs are intentionally immutable and the harness database is
  // disposable. Retire the Loop so later materializer tests cannot select it;
  // the runner drops all rows after the file completes.
  await pool.query("update loops set status='completed', updated_at=now() where id=$1", [loopId]);
}

let savepointSequence = 0;
async function assertSqlRejected(client, sql, params, pattern) {
  savepointSequence += 1;
  const savepoint = `adversarial_${savepointSequence}`;
  await client.query(`savepoint ${savepoint}`);
  await assert.rejects(
    () => client.query(sql, params),
    (error) => error.code === "23514" && pattern.test(error.message),
  );
  await client.query(`rollback to savepoint ${savepoint}`);
}

test("migration 033/fresh schema expose forward, verify, guarded rollback and unique runtime map", async () => {
  const migrationPath = resolve(repoRoot, "supabase/migrations/033_project_loops_v2_serial_runtime.sql");
  const artifact = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase3");
  assert.equal(existsSync(migrationPath), true);
  const migration = readFileSync(migrationPath, "utf8");
  const schema = readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8");
  const verify = readFileSync(resolve(artifact, "verify.sql"), "utf8");
  const rollback = readFileSync(resolve(artifact, "rollback.sql"), "utf8");
  for (const source of [migration, schema]) {
    assert.match(source, /work_item_id uuid/);
    assert.match(source, /run_role text NOT NULL DEFAULT 'implementation'/);
    assert.match(source, /quality_cycle integer NOT NULL DEFAULT 1/);
    assert.match(source, /loop_task_runs_work_item_id_fkey/);
    assert.match(source, /uq_loop_task_runs_work_item/);
  }
  assert.match(verify, /TRANSACTION READ ONLY/i);
  assert.match(rollback, /work_item_id IS NOT NULL/);
  const columns = await pool.query("select column_name,column_default,is_nullable from information_schema.columns where table_name='loop_task_runs' and column_name=any($1) order by column_name", [["work_item_id", "run_role", "quality_cycle"]]);
  assert.equal(columns.rowCount, 3);
});

test("migration 033 rehearses forward, read-only verify, and guarded rollback in disposable Postgres", async () => {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const databaseName = generateMissionControlTestDatabaseName();
  const databaseUrl = databaseUrlForName(adminUrl, databaseName);
  const admin = new pg.Client({ connectionString: adminUrl });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create database ${quotePostgresIdentifier(databaseName)}`);
    created = true;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const artifact = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase3");
      const rollbackSql = readFileSync(resolve(artifact, "rollback.sql"), "utf8");
      await client.query(readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8"));
      await client.query(rollbackSql);
      await client.query(readFileSync(resolve(repoRoot, "supabase/migrations/033_project_loops_v2_serial_runtime.sql"), "utf8"));
      await client.query(readFileSync(resolve(artifact, "verify.sql"), "utf8"));
      assert.equal((await client.query("select count(*)::int count from information_schema.columns where table_name='loop_task_runs' and column_name=any($1)", [["work_item_id", "run_role", "quality_cycle"]])).rows[0].count, 3);
      const migrationLoopId = (await client.query("insert into loops(name) values ('migration 033 insert guard') returning id")).rows[0].id;
      await assert.rejects(
        () => client.query(
          "insert into loop_plan_revisions(id,loop_id,revision_number,status) values ($1,$2,1,'approved')",
          [randomUUID(), migrationLoopId],
        ),
        (error) => error.code === "23514" && /requires an exact snapshot and hash/i.test(error.message),
      );
      await client.query(
        `insert into loop_plan_revisions(id,loop_id,revision_number,status,content_hash,plan_snapshot)
         values ($1,$2,2,'approved',$3,'{}'::jsonb)`,
        [randomUUID(), migrationLoopId, "a".repeat(64)],
      );
      await client.query("set session_replication_role=replica");
      await client.query("delete from loop_plan_revisions where loop_id=$1", [migrationLoopId]);
      await client.query("delete from loops where id=$1", [migrationLoopId]);
      await client.query("set session_replication_role=origin");
      await client.query(rollbackSql);
      assert.equal((await client.query("select count(*)::int count from information_schema.columns where table_name='loop_task_runs' and column_name=any($1)", [["work_item_id", "run_role", "quality_cycle"]])).rows[0].count, 0);
    } finally { await client.end(); }
  } finally {
    if (created) {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`drop database if exists ${quotePostgresIdentifier(databaseName)}`);
    }
    await admin.end();
  }
});

test("Project create is atomic/idempotent, validates DAGs, creates one pending revision, and V1 quick-create stays V1", async () => {
  const body = chainPayload();
  const created = await invokeCreate(body);
  assert.equal(created.status, 201);
  const loopId = created.payload.loop.id;
  try {
    const replay = await invokeCreate(JSON.parse(JSON.stringify(body)));
    assert.equal(replay.status, 200);
    assert.equal(replay.payload.loop.id, loopId);
    assert.equal(replay.payload.replay, true);
    const conflict = await invokeCreate({ ...body, title: "Different payload" });
    assert.equal(conflict.status, 409);
    const graph = await pool.query(`select l.workflow_version,l.mode,l.status,p.status as revision_status,
      count(distinct p.id)::int revisions,count(distinct s.id)::int stages,count(distinct t.id)::int tasks,count(distinct d.task_id||':'||d.depends_on_task_id)::int deps
      from loops l join loop_plan_revisions p on p.loop_id=l.id join loop_stages s on s.plan_revision_id=p.id
      join loop_tasks t on t.stage_id=s.id left join loop_task_dependencies d on d.task_id=t.id where l.id=$1
      group by l.workflow_version,l.mode,l.status,p.status`, [loopId]);
    assert.deepEqual({ ...graph.rows[0] }, { workflow_version: 2, mode: "dag", status: "needs_approval", revision_status: "pending_approval", revisions: 1, stages: 2, tasks: 3, deps: 2 });
    assert.equal((await pool.query("select count(*)::int count from loop_events where loop_id=$1", [loopId])).rows[0].count, 2);
  } finally { await cleanup(loopId); }

  const cyclic = chainPayload({ stages: [{ key: "s", title: "Cycle", tasks: [
    { key: "a", title: "A", depends_on: ["b"] }, { key: "b", title: "B", depends_on: ["a"] },
  ] }] });
  const invalid = await invokeCreate(cyclic);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.error, "dependency_cycle");
  assert.equal((await pool.query("select count(*)::int count from loops where metadata->>'project_create_idempotency_key'=$1", [cyclic.idempotency_key])).rows[0].count, 0);

  const quickCreate = readFileSync(resolve(repoRoot, "src/app/api/loops/create/route.ts"), "utf8");
  assert.doesNotMatch(quickCreate, /workflow_version\s*[:,].*2/);
});

test("Project create canonicalizes, hashes, and persists an explicit per-task QA policy while omission stays field-absent", async () => {
  const required = chainPayload({
    stages: [{ key: "ui", title: "UI", tasks: [{
      key: "responsive", title: "Responsive UI",
      qa_policy: {
        required: true,
        target_url: "https://staging.example.test/app?fixture=qa",
        flows: ["  Open dashboard  ", "Inspect navigation"],
      },
    }] }],
  });
  const requiredCreated = await invokeCreate(required);
  assert.equal(requiredCreated.status, 201);
  const requiredLoopId = requiredCreated.payload.loop.id;
  const omittedCreated = await invokeCreate(chainPayload({
    stages: [{ key: "api", title: "API", tasks: [{ key: "server", title: "Server task" }] }],
  }));
  assert.equal(omittedCreated.status, 201);
  const omittedLoopId = omittedCreated.payload.loop.id;
  try {
    const requiredState = (await pool.query(`select p.plan_snapshot,t.metadata
      from loop_plan_revisions p join loop_stages s on s.plan_revision_id=p.id
      join loop_tasks t on t.stage_id=s.id where p.loop_id=$1`, [requiredLoopId])).rows[0];
    const policy = {
      required: true,
      target_url: "https://staging.example.test/app?fixture=qa",
      viewports: [
        { name: "desktop", width: 1440, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ],
      flows: ["Open dashboard", "Inspect navigation"],
    };
    assert.deepEqual(requiredState.plan_snapshot.stages[0].tasks[0].qa_policy, policy);
    assert.deepEqual(requiredState.metadata.qa_policy, policy);
    assert.equal(requiredCreated.payload.loop.plan_hash,
      createHash("sha256").update(JSON.stringify(canonical(requiredState.plan_snapshot))).digest("hex"));

    const replay = await invokeCreate({
      ...required,
      stages: [{ ...required.stages[0], tasks: [{
        ...required.stages[0].tasks[0],
        qa_policy: { ...required.stages[0].tasks[0].qa_policy, viewports: [] },
      }] }],
    });
    assert.equal(replay.status, 200, "empty required viewports canonicalize to the same defaults");
    assert.equal(replay.payload.loop.plan_hash, requiredCreated.payload.loop.plan_hash);

    const omittedState = (await pool.query(`select p.plan_snapshot,t.metadata
      from loop_plan_revisions p join loop_stages s on s.plan_revision_id=p.id
      join loop_tasks t on t.stage_id=s.id where p.loop_id=$1`, [omittedLoopId])).rows[0];
    assert.equal(Object.hasOwn(omittedState.plan_snapshot.stages[0].tasks[0], "qa_policy"), false);
    assert.equal(Object.hasOwn(omittedState.metadata, "qa_policy"), false);
  } finally {
    await cleanup(requiredLoopId);
    await cleanup(omittedLoopId);
  }
});

test("Project create rejects malformed QA policy keys, URLs, viewports, flows, and non-required payload", async () => {
  const validViewport = { name: "desktop", width: 1440, height: 900 };
  const cases = [
    [{ required: true, target_url: "https://example.test", viewports: [], flows: [], surprise: true }, "exact keys"],
    [{ required: true, target_url: "relative/path", viewports: [], flows: [] }, "absolute URL"],
    [{ required: true, target_url: "ftp://example.test", viewports: [], flows: [] }, "HTTP(S) URL"],
    [{ required: true, target_url: "https://user:pass@example.test", viewports: [], flows: [] }, "credentials"],
    [{ required: true, target_url: "https://exa mple.test", viewports: [], flows: [] }, "malformed URL"],
    [{ required: true, target_url: "https://example.test/#secret", viewports: [], flows: [] }, "fragment"],
    [{ required: true, target_url: null, viewports: [], flows: [] }, "required target"],
    [{ required: true, target_url: "https://example.test", viewports: [{ ...validViewport, extra: 1 }], flows: [] }, "viewport exact keys"],
    [{ required: true, target_url: "https://example.test", viewports: [{ ...validViewport, width: 319 }], flows: [] }, "viewport minimum"],
    [{ required: true, target_url: "https://example.test", viewports: [validViewport, { ...validViewport }], flows: [] }, "unique viewport names"],
    [{ required: true, target_url: "https://example.test", viewports: [{ ...validViewport, name: "   " }], flows: [] }, "useful viewport name"],
    [{ required: true, target_url: "https://example.test", viewports: [{ ...validViewport, name: "x".repeat(81) }], flows: [] }, "viewport name limit"],
    [{ required: true, target_url: "https://example.test", viewports: [validViewport, { ...validViewport, name: " Desktop " }], flows: [] }, "canonical unique viewport names"],
    [{ required: true, target_url: "https://example.test", viewports: Array.from({ length: 9 }, (_, i) => ({ name: `v${i}`, width: 320, height: 320 })), flows: [] }, "viewport limit"],
    [{ required: true, target_url: "https://example.test", viewports: [], flows: ["   "] }, "useful flow"],
    [{ required: true, target_url: "https://example.test", viewports: [], flows: ["x".repeat(501)] }, "flow text limit"],
    [{ required: true, target_url: "https://example.test", viewports: [], flows: ["Open dashboard", " Open dashboard "] }, "unique canonical flows"],
    [{ required: true, target_url: "https://example.test", viewports: [], flows: Array.from({ length: 21 }, (_, i) => `flow ${i}`) }, "flow limit"],
    [{ required: false, target_url: "https://example.test", viewports: [], flows: [] }, "non-required target"],
    [{ required: false, target_url: null, viewports: [validViewport], flows: [] }, "non-required viewports"],
    [{ required: false, target_url: null, viewports: [], flows: ["open"] }, "non-required flows"],
  ];
  for (const [qaPolicy, label] of cases) {
    const response = await invokeCreate(chainPayload({
      stages: [{ key: "qa", title: "QA", tasks: [{ key: "invalid", title: "Invalid", qa_policy: qaPolicy }] }],
    }));
    assert.equal(response.status, 400, label);
    assert.equal(response.payload.error, "invalid_qa_policy", label);
  }

  const optional = await invokeCreate(chainPayload({
    stages: [{ key: "qa", title: "QA", tasks: [{ key: "optional", title: "Optional", qa_policy: { required: false } }] }],
  }));
  assert.equal(optional.status, 201);
  try {
    const state = (await pool.query(`select p.plan_snapshot,t.metadata
      from loop_plan_revisions p join loop_stages s on s.plan_revision_id=p.id
      join loop_tasks t on t.stage_id=s.id where p.loop_id=$1`, [optional.payload.loop.id])).rows[0];
    const canonicalOptional = { required: false, target_url: null, viewports: [], flows: [] };
    assert.deepEqual(state.plan_snapshot.stages[0].tasks[0].qa_policy, canonicalOptional);
    assert.deepEqual(state.metadata.qa_policy, canonicalOptional);
  } finally { await cleanup(optional.payload.loop.id); }
});

test("V2 approval rejects QA policy added, removed, or changed before approval", async () => {
  const policy = {
    required: true,
    target_url: "https://example.test/app",
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
    flows: ["Open dashboard"],
  };
  const fixtures = [
    { label: "added", task: { key: "added", title: "Added" },
      assignment: "metadata=jsonb_set(metadata,'{qa_policy}',$2::jsonb,true)", value: policy },
    { label: "removed", task: { key: "removed", title: "Removed", qa_policy: policy },
      assignment: "metadata=metadata-'qa_policy'" },
    { label: "changed", task: { key: "changed", title: "Changed", qa_policy: policy },
      assignment: "metadata=jsonb_set(metadata,'{qa_policy,target_url}','\"https://changed.example.test\"'::jsonb)" },
  ];
  const loopIds = [];
  try {
    for (const fixture of fixtures) {
      const created = await invokeCreate(chainPayload({
        stages: [{ key: fixture.label, title: fixture.label, tasks: [fixture.task] }],
      }));
      assert.equal(created.status, 201, fixture.label);
      loopIds.push(created.payload.loop.id);
      await pool.query(`update loop_tasks set ${fixture.assignment}
        where stage_id in (select s.id from loop_stages s join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1)`,
      fixture.value === undefined ? [created.payload.loop.id] : [created.payload.loop.id, JSON.stringify(fixture.value)]);
      const approved = await invokeApprove(created.payload.loop.id);
      assert.equal(approved.status, 409, fixture.label);
      assert.equal(approved.payload.error, "v2_plan_snapshot_integrity_conflict", fixture.label);
    }
  } finally {
    for (const loopId of loopIds) await cleanup(loopId);
  }
});

test("materializer rejects QA policy added, removed, or changed after approval but keeps absent/absent compatible", async () => {
  const policy = {
    required: true,
    target_url: "http://127.0.0.1:3001/fixture",
    viewports: [{ name: "tablet", width: 768, height: 1024 }],
    flows: ["Open fixture"],
  };
  const fixtures = [
    { label: "added", task: { key: "added", title: "Added" },
      assignment: "metadata=jsonb_set(metadata,'{qa_policy}',$2::jsonb,true)", value: policy },
    { label: "removed", task: { key: "removed", title: "Removed", qa_policy: policy },
      assignment: "metadata=metadata-'qa_policy'" },
    { label: "changed", task: { key: "changed", title: "Changed", qa_policy: policy },
      assignment: "metadata=jsonb_set(metadata,'{qa_policy,flows}','[\"Tampered flow\"]'::jsonb)" },
  ];
  const driftedLoopIds = [];
  const historicalCreated = await invokeCreate(chainPayload({
    stages: [{ key: "legacy", title: "Legacy", tasks: [{ key: "old", title: "Old task" }] }],
  }));
  const historicalLoopId = historicalCreated.payload.loop.id;
  try {
    for (const fixture of fixtures) {
      const created = await invokeCreate(chainPayload({
        stages: [{ key: fixture.label, title: fixture.label, tasks: [fixture.task] }],
      }));
      assert.equal(created.status, 201, fixture.label);
      driftedLoopIds.push(created.payload.loop.id);
      assert.equal((await invokeApprove(created.payload.loop.id)).status, 200, fixture.label);
    }
    const corrupter = await pool.connect();
    try {
      await corrupter.query("begin");
      await corrupter.query("set local session_replication_role=replica");
      for (const [index, fixture] of fixtures.entries()) {
        await corrupter.query(`update loop_tasks set ${fixture.assignment}
          where stage_id in (select s.id from loop_stages s join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1)`,
        fixture.value === undefined ? [driftedLoopIds[index]] : [driftedLoopIds[index], JSON.stringify(fixture.value)]);
      }
      await corrupter.query("commit");
    } finally {
      await corrupter.query("rollback").catch(() => {});
      corrupter.release();
    }
    const drifted = await invokeMaterialize();
    for (const [index, fixture] of fixtures.entries()) {
      const loopId = driftedLoopIds[index];
      assert.equal(drifted.payload.details.find((entry) => entry.loopId === loopId)?.reason,
        "approved_snapshot_graph_drift", fixture.label);
      assert.equal((await rowsFor(loopId)).rows.filter((row) => row.work_item_id).length, 0, fixture.label);
    }

    await invokeApprove(historicalLoopId);
    const historical = await invokeMaterialize();
    assert.equal(historical.payload.details.find((entry) => entry.loopId === historicalLoopId)?.action, "materialized");
  } finally {
    for (const loopId of driftedLoopIds) await cleanup(loopId);
    await cleanup(historicalLoopId);
  }
});

test("approved task trigger rejects an ordinary post-approval metadata mutation", async () => {
  const created = await invokeCreate(chainPayload());
  const loopId = created.payload.loop.id;
  try {
    assert.equal((await invokeApprove(loopId)).status, 200);
    await assert.rejects(
      () => pool.query(`update loop_tasks set metadata=jsonb_set(metadata,'{qa_policy}',
        '{"required":false,"target_url":null,"viewports":[],"flows":[]}'::jsonb,true)
        where stage_id in (select s.id from loop_stages s join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1)`, [loopId]),
      /task specification is immutable/i,
    );
  } finally {
    await cleanup(loopId);
  }
});

test("V2 approval is exact/atomic and rework fails 501 without partial mutation", async () => {
  const created = await invokeCreate(chainPayload());
  const loopId = created.payload.loop.id;
  try {
    const rework = await approveRoute.POST({ json: async () => ({ action: "rework", queue: false, decision_id: randomUUID(), comment: "change it", plan_operations: [{ type: "append_step", title: "x" }] }) }, { params: Promise.resolve({ id: loopId }) });
    assert.equal(rework.status, 501);
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "needs_approval");
    const decisionId = randomUUID();
    const approved = await invokeApprove(loopId, { decision_id: decisionId });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.status, "queued");
    const state = (await pool.query("select l.status,l.approval_scope,p.status revision_status,p.approved_by from loops l join loop_plan_revisions p on p.id=l.current_plan_revision_id where l.id=$1", [loopId])).rows[0];
    assert.equal(state.status, "queued");
    assert.equal(state.revision_status, "approved");
    assert.equal(state.approval_scope.approved, true);
    const replay = await invokeApprove(loopId, { decision_id: decisionId });
    assert.equal(replay.status, 200);
  } finally { await cleanup(loopId); }
});

test("V2 exact-plan approval rejects missing/stale hashes and serializes concurrent decisions", async () => {
  const created = await invokeCreate(chainPayload());
  const loopId = created.payload.loop.id;
  try {
    const missing = await invokeApprove(loopId, { plan_revision_id: null, plan_hash: null });
    assert.equal(missing.status, 400);
    assert.equal(missing.payload.error, "v2_exact_plan_revision_and_hash_required");
    const stale = await invokeApprove(loopId, { plan_hash: "0".repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.error, "v2_plan_snapshot_integrity_conflict");

    const decisions = await Promise.all([invokeApprove(loopId), invokeApprove(loopId)]);
    assert.deepEqual(decisions.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await pool.query("select count(*)::int count from loop_events where loop_id=$1 and event_type='loop.queued'", [loopId])).rows[0].count, 1);
    const exact = (await pool.query("select l.status,p.status revision_status from loops l join loop_plan_revisions p on p.id=l.current_plan_revision_id where l.id=$1", [loopId])).rows[0];
    assert.deepEqual({ ...exact }, { status: "queued", revision_status: "approved" });
  } finally { await cleanup(loopId); }
});

test("approved revision, stage, task and dependency specifications reject adversarial insert/update/delete mutations", async () => {
  const created = await invokeCreate(chainPayload());
  const loopId = created.payload.loop.id;
  const client = await pool.connect();
  try {
    await invokeApprove(loopId);
    const graph = (await client.query(`select p.id revision_id,s.id stage_id,t.id task_id,t.key
      from loop_plan_revisions p join loop_stages s on s.plan_revision_id=p.id join loop_tasks t on t.stage_id=s.id
      where p.loop_id=$1 order by s.position,t.position`, [loopId])).rows;
    const dependency = (await client.query(`select d.task_id,d.depends_on_task_id from loop_task_dependencies d
      join loop_tasks t on t.id=d.task_id join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1 limit 1`, [loopId])).rows[0];
    await client.query("begin");
    await assertSqlRejected(client,
      "insert into loop_plan_revisions(id,loop_id,revision_number,status) values ($1,$2,2,'approved')",
      [randomUUID(), loopId], /requires an exact snapshot and hash/i);
    await assertSqlRejected(client, "update loop_plan_revisions set summary='tampered' where id=$1", [graph[0].revision_id], /revision is immutable/i);
    await assertSqlRejected(client, "delete from loop_plan_revisions where id=$1", [graph[0].revision_id], /revision is immutable/i);

    await assertSqlRejected(client,
      "insert into loop_stages(id,plan_revision_id,key,title,position) values ($1,$2,'evil-stage','Evil',99)",
      [randomUUID(), graph[0].revision_id], /structure is immutable/i);
    await assertSqlRejected(client, "update loop_stages set title='tampered' where id=$1", [graph[0].stage_id], /stage specification is immutable/i);
    await assertSqlRejected(client, "delete from loop_stages where id=$1", [graph[0].stage_id], /structure is immutable/i);

    await assertSqlRejected(client,
      "insert into loop_tasks(id,stage_id,key,title,position) values ($1,$2,'evil-task','Evil',99)",
      [randomUUID(), graph[0].stage_id], /structure is immutable/i);
    await assertSqlRejected(client, "update loop_tasks set title='tampered' where id=$1", [graph[0].task_id], /task specification is immutable/i);
    await assertSqlRejected(client, "delete from loop_tasks where id=$1", [graph[0].task_id], /structure is immutable/i);

    await assertSqlRejected(client,
      "insert into loop_task_dependencies(task_id,depends_on_task_id,dependency_type) values ($1,$2,'soft')",
      [graph[0].task_id, graph.at(-1).task_id], /structure is immutable/i);
    await assertSqlRejected(client,
      "update loop_task_dependencies set dependency_type='soft' where task_id=$1 and depends_on_task_id=$2",
      [dependency.task_id, dependency.depends_on_task_id], /structure is immutable/i);
    await assertSqlRejected(client,
      "delete from loop_task_dependencies where task_id=$1 and depends_on_task_id=$2",
      [dependency.task_id, dependency.depends_on_task_id], /structure is immutable/i);
    await client.query("rollback");
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await cleanup(loopId);
  }
});

test("moving a dependency edge from an approved revision to a draft revision is rejected", async () => {
  const approvedCreated = await invokeCreate(chainPayload());
  const draftCreated = await invokeCreate(chainPayload({
    idempotency_key: randomUUID(),
    stages: [{ key: "draft", title: "Draft", tasks: [
      { key: "draft-one", title: "Draft one" }, { key: "draft-two", title: "Draft two" },
    ] }],
  }));
  const approvedLoopId = approvedCreated.payload.loop.id;
  const draftLoopId = draftCreated.payload.loop.id;
  const client = await pool.connect();
  try {
    await invokeApprove(approvedLoopId);
    await client.query("update loop_plan_revisions set status='draft' where loop_id=$1", [draftLoopId]);
    const dependency = (await client.query(`select d.task_id,d.depends_on_task_id from loop_task_dependencies d
      join loop_tasks t on t.id=d.task_id join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1 limit 1`, [approvedLoopId])).rows[0];
    const draftTasks = (await client.query(`select t.id from loop_tasks t join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1 order by t.position`, [draftLoopId])).rows;
    await client.query("begin");
    await assertSqlRejected(client,
      `update loop_task_dependencies set task_id=$3,depends_on_task_id=$4
        where task_id=$1 and depends_on_task_id=$2`,
      [dependency.task_id, dependency.depends_on_task_id, draftTasks[1].id, draftTasks[0].id], /structure is immutable/i);
    await client.query("rollback");
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await cleanup(approvedLoopId);
    await cleanup(draftLoopId);
  }
});

test("dependency input order is canonical for request replay, plan hash, and exact approval", async () => {
  const idempotencyKey = randomUUID();
  const dependencies = [
    { key: "base-z", type: "soft" },
    { key: "base-a", type: "hard" },
    { key: "base-m", type: "hard" },
  ];
  const payload = chainPayload({
    idempotency_key: idempotencyKey,
    stages: [{ key: "canonical", title: "Canonical", tasks: [
      { key: "base-z", title: "Base Z" },
      { key: "base-a", title: "Base A" },
      { key: "base-m", title: "Base M" },
      { key: "dependent", title: "Dependent", depends_on: dependencies },
    ] }],
  });
  const created = await invokeCreate(payload);
  const loopId = created.payload.loop.id;
  try {
    const replay = await invokeCreate({
      ...payload,
      stages: [{ ...payload.stages[0], tasks: [
        ...payload.stages[0].tasks.slice(0, 3),
        { ...payload.stages[0].tasks[3], depends_on: [dependencies[2], dependencies[0], dependencies[1]] },
      ] }],
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.payload.replay, true);
    assert.equal(replay.payload.loop.plan_hash, created.payload.loop.plan_hash);
    const snapshotDependencies = (await pool.query(
      "select plan_snapshot->'stages'->0->'tasks'->3->'dependencies' dependencies from loop_plan_revisions where loop_id=$1",
      [loopId],
    )).rows[0].dependencies;
    assert.deepEqual(snapshotDependencies.map((dependency) => [dependency.key, dependency.type]), [
      ["base-a", "hard"], ["base-m", "hard"], ["base-z", "soft"],
    ]);
    assert.equal((await invokeApprove(loopId)).status, 200);
  } finally { await cleanup(loopId); }
});

test("materializer revalidates revoked approval under the Loop lock and rejects a corrupted approved snapshot", async () => {
  const lockedCreated = await invokeCreate(chainPayload());
  const lockedLoopId = lockedCreated.payload.loop.id;
  const locker = await pool.connect();
  try {
    await invokeApprove(lockedLoopId);
    await locker.query("begin");
    await locker.query("select id from loops where id=$1 for update", [lockedLoopId]);
    const materializing = invokeMaterialize();
    const beforeRevocation = await Promise.race([
      materializing.then(() => "settled"),
      new Promise((resolveWait) => setTimeout(() => resolveWait("waiting"), 50)),
    ]);
    assert.equal(beforeRevocation, "waiting", "materializer must wait for the Loop lock");
    await locker.query(`update loops set approval_scope=jsonb_set(
      jsonb_set(approval_scope,'{approved}','false'::jsonb),'{can_execute_unattended}','false'::jsonb)
      where id=$1`, [lockedLoopId]);
    await locker.query("commit");
    const revoked = await materializing;
    assert.equal(revoked.payload.materialized, 0);
    assert.equal(revoked.payload.details.find((entry) => entry.loopId === lockedLoopId)?.reason, "approval_scope_not_exact");
    assert.equal((await rowsFor(lockedLoopId)).rows.filter((row) => row.work_item_id).length, 0);
  } finally {
    await locker.query("rollback").catch(() => {});
    locker.release();
    await cleanup(lockedLoopId);
  }

  const corruptedCreated = await invokeCreate(chainPayload());
  const corruptedLoopId = corruptedCreated.payload.loop.id;
  const corrupter = await pool.connect();
  try {
    await invokeApprove(corruptedLoopId);
    await corrupter.query("begin");
    await corrupter.query("set local session_replication_role=replica");
    await corrupter.query(`update loop_plan_revisions set plan_snapshot=jsonb_set(plan_snapshot,'{objective,title}','\"corrupted\"'::jsonb)
      where id=(select current_plan_revision_id from loops where id=$1)`, [corruptedLoopId]);
    await corrupter.query("commit");
    const corrupted = await invokeMaterialize();
    assert.equal(corrupted.payload.materialized, 0);
    assert.equal(corrupted.payload.details.find((entry) => entry.loopId === corruptedLoopId)?.reason, "current_revision_not_approved_exactly");
    assert.equal((await rowsFor(corruptedLoopId)).rows.filter((row) => row.work_item_id).length, 0);
  } finally {
    await corrupter.query("rollback").catch(() => {});
    corrupter.release();
    await cleanup(corruptedLoopId);
  }
});

test("three-task chain serializes concurrent materializers, unblocks on completion, ignores replay/stale completion, and reaches final review", async () => {
  const created = await invokeCreate(chainPayload());
  const loopId = created.payload.loop.id;
  try {
    assert.equal((await invokeApprove(loopId)).payload.status, "queued");
    const concurrent = await Promise.all([invokeMaterialize(), invokeMaterialize()]);
    const responses = [...concurrent];
    let materializedCount = responses.flatMap((response) => response.payload.details)
      .filter((entry) => entry.loopId === loopId && entry.action === "materialized").length;
    for (let attempt = 0; attempt < 10 && (await rowsFor(loopId)).rows.every((row) => !row.work_item_id); attempt += 1) {
      const response = await invokeMaterialize();
      responses.push(response);
      materializedCount += response.payload.details
        .filter((entry) => entry.loopId === loopId && entry.action === "materialized").length;
    }
    assert.equal(materializedCount, 1);
    let rows = (await rowsFor(loopId)).rows;
    assert.deepEqual(rows.map((row) => [row.key, row.status]), [["one", "in_progress"], ["two", "pending"], ["three", "pending"]]);
    assert.equal(rows.filter((row) => row.work_item_id).length, 1);
    assert.match(rows[0].instruction, /Objective:\s*Implement foundation/);
    assert.doesNotMatch(rows[0].instruction, /Connect runtime|Verify result|Build the approved project/);
    assert.match(rows[0].instruction, /Do not touch live services/);

    const first = rows[0];
    await completeImplementationAndApprove(loopId, first);
    const eventCount = (await pool.query("select count(*)::int count from loop_events where loop_id=$1 and event_type='loop.task_review_approved'", [loopId])).rows[0].count;
    const replay = await agentCompletion.patchAgentWorkItemWithCompletion(first.work_item_id, { status: "done", execution_attempt_id: first.payload.execution_attempt_id });
    assert.equal(replay.status, "done");
    assert.equal((await pool.query("select count(*)::int count from loop_events where loop_id=$1 and event_type='loop.task_review_approved'", [loopId])).rows[0].count, eventCount);
    await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(first.work_item_id, { status: "done", execution_attempt_id: randomUUID() }), /stale_execution_attempt/);

    for (const expectedKey of ["two", "three"]) {
      const materialized = await invokeMaterialize();
      assert.equal(materialized.payload.details
        .filter((entry) => entry.loopId === loopId && entry.action === "materialized").length, 1);
      const current = await activeFreshWork(loopId);
      assert.equal(current.key, expectedKey);
      await completeImplementationAndApprove(loopId, current);
    }
    const finalTasks = (await pool.query(`select t.status from loop_tasks t join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1 order by s.position,t.position`, [loopId])).rows;
    assert.deepEqual(finalTasks.map((row) => row.status), Array(3).fill("completed"));
    assert.equal((await pool.query("select count(*)::int count from loop_task_runs r join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1 and r.status='succeeded'", [loopId])).rows[0].count, 6);
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "in_review");

    const unsupported = await invokeReview(loopId, { action: "request_changes", feedback: "redo" });
    assert.equal(unsupported.status, 501);
    const decisionId = randomUUID();
    const approved = await invokeReview(loopId, { action: "approve_deliverable", feedback: "ship", decision_id: decisionId });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.status, "completed");
    const reviewReplay = await invokeReview(loopId, { action: "approve_deliverable", feedback: "ship", decision_id: decisionId });
    assert.equal(reviewReplay.status, 200);
  } finally { await cleanup(loopId); }
});

test("V2 final review completes against the historical local loops shape without last_completed_at", async () => {
  const created = await invokeCreate(chainPayload({
    stages: [{ key: "only", title: "Only", tasks: [{ key: "finish", title: "Finish" }] }],
  }));
  const loopId = created.payload.loop.id;
  let historicalShapeInstalled = false;
  try {
    await invokeApprove(loopId);
    await invokeMaterialize();
    const task = (await rowsFor(loopId)).rows[0];
    await completeImplementationAndApprove(loopId, task);
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "in_review");

    await pool.query("alter table loops drop column last_completed_at");
    historicalShapeInstalled = true;
    assert.equal((await pool.query(`select count(*)::int count from information_schema.columns
      where table_schema='public' and table_name='loops' and column_name='last_completed_at'`)).rows[0].count, 0);

    const decisionId = randomUUID();
    const approved = await invokeReview(loopId, {
      action: "approve_deliverable", feedback: "ship historical local shape", decision_id: decisionId,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.status, "completed");
    const completed = (await pool.query("select status,metadata from loops where id=$1", [loopId])).rows[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.metadata.decision_ledger.at(-1).decision_id, decisionId);
    assert.equal((await pool.query(
      "select count(*)::int count from loop_events where loop_id=$1 and event_type='loop.review_approved'",
      [loopId],
    )).rows[0].count, 1);
  } finally {
    await cleanup(loopId);
    if (historicalShapeInstalled) await pool.query("alter table loops add column last_completed_at timestamptz");
  }
});

test("failed/canceled V2 task blocks run, task, stage and Loop; final review fails closed", async () => {
  const created = await invokeCreate(chainPayload({ stages: [{ key: "only", title: "Only", tasks: [{ key: "fail", title: "Fail safely" }] }] }));
  const loopId = created.payload.loop.id;
  try {
    await invokeApprove(loopId);
    await invokeMaterialize();
    const row = (await rowsFor(loopId)).rows[0];
    await agentCompletion.patchAgentWorkItemWithCompletion(row.work_item_id, { status: "failed", execution_attempt_id: row.payload.execution_attempt_id, result: "boom" });
    const state = (await pool.query(`select l.status loop_status,s.status stage_status,t.status task_status,r.status run_status
      from loops l join loop_plan_revisions p on p.id=l.current_plan_revision_id join loop_stages s on s.plan_revision_id=p.id
      join loop_tasks t on t.stage_id=s.id join loop_task_runs r on r.task_id=t.id where l.id=$1`, [loopId])).rows[0];
    assert.deepEqual({ ...state }, { loop_status: "blocked", stage_status: "blocked", task_status: "blocked", run_status: "failed" });
    const review = await invokeReview(loopId, { action: "approve_deliverable" });
    assert.equal(review.status, 409);
  } finally { await cleanup(loopId); }
});

test("blocked V2 Loop rejects a late task completion without mutating work item, run, or task", async () => {
  const created = await invokeCreate(chainPayload({ stages: [{ key: "only", title: "Only", tasks: [{ key: "late", title: "Late" }] }] }));
  const loopId = created.payload.loop.id;
  try {
    await invokeApprove(loopId);
    await invokeMaterialize();
    const row = (await rowsFor(loopId)).rows[0];
    await pool.query("update loops set status='blocked' where id=$1", [loopId]);
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(row.work_item_id, {
        status: "done", execution_attempt_id: row.payload.execution_attempt_id,
      }),
      /v2_task_completion_state_conflict/,
    );
    const unchanged = (await rowsFor(loopId)).rows[0];
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.work_status], ["in_progress", "queued", "ready"]);
    assert.equal((await pool.query("select count(*)::int count from loop_events where loop_id=$1 and event_type='loop.task_completed'", [loopId])).rows[0].count, 0);
  } finally { await cleanup(loopId); }
});

test("V2 task execution rejects every unsupported nonterminal status before work-item mutation", async () => {
  const created = await invokeCreate(chainPayload({
    stages: [{ key: "only", title: "Only", tasks: [{ key: "matrix", title: "Matrix" }] }],
  }));
  const loopId = created.payload.loop.id;
  try {
    await invokeApprove(loopId);
    await invokeMaterialize();
    const before = (await rowsFor(loopId)).rows[0];
    const eventCount = (await pool.query("select count(*)::int count from event_log where entity_id=$1", [before.work_item_id])).rows[0].count;
    for (const status of ["draft", "ready", "blocked", "pending", "queued", "running", "in_review"]) {
      await assert.rejects(
        () => agentCompletion.patchAgentWorkItemWithCompletion(before.work_item_id, {
          status,
          execution_attempt_id: before.payload.execution_attempt_id,
          payload_patch: { forbidden_nonterminal_patch: status },
        }),
        /v2_task_status_transition_conflict/,
      );
      const unchanged = (await rowsFor(loopId)).rows[0];
      assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.work_status], ["in_progress", "queued", "ready"]);
      assert.equal(unchanged.payload.forbidden_nonterminal_patch, undefined);
      assert.equal((await pool.query("select count(*)::int count from event_log where entity_id=$1", [before.work_item_id])).rows[0].count, eventCount);
    }
    const started = await agentCompletion.patchAgentWorkItemWithCompletion(before.work_item_id, {
      status: "in_progress", execution_attempt_id: before.payload.execution_attempt_id,
    });
    assert.equal(started.status, "in_progress");
    assert.equal((await rowsFor(loopId)).rows[0].run_status, "running");
  } finally { await cleanup(loopId); }
});

test("V1 approval replays a pre-V2 decision ledger request without null V2 plan fields", async () => {
  const loopId = randomUUID();
  const decisionId = randomUUID();
  const response = { ok: true, id: loopId, status: "queued", decision_id: decisionId };
  const request = {
    decision_type: "plan_approval",
    loop_id: loopId,
    action: "approve",
    queue: true,
    comment: null,
    plan_operations: [],
    acted_by: "v2-reviewer@example.test",
  };
  await pool.query(
    `insert into loops(id,name,status,metadata)
     values ($1,'V1 ledger replay','needs_approval',$2::jsonb)`,
    [loopId, JSON.stringify({ decision_ledger: [{
      decision_id: decisionId, decision_type: "plan_approval", request, response,
    }] })],
  );
  try {
    const replay = await approveRoute.POST({
      json: async () => ({ action: "approve", queue: true, decision_id: decisionId }),
    }, { params: Promise.resolve({ id: loopId }) });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.payload, response);
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "needs_approval");
  } finally {
    await pool.query("delete from loops where id=$1", [loopId]);
  }
});

test("V2 completion rejects cross-loop/fake mappings, primary_execution, and mapping cardinality violations", async () => {
  const oneTask = (key) => chainPayload({ stages: [{ key: "only", title: "Only", tasks: [{ key, title: key }] }] });
  const sourceCreated = await invokeCreate(oneTask("source"));
  const targetCreated = await invokeCreate(oneTask("target"));
  const sourceLoopId = sourceCreated.payload.loop.id;
  const targetLoopId = targetCreated.payload.loop.id;
  try {
    await invokeApprove(sourceLoopId);
    await invokeMaterialize();
    const source = (await rowsFor(sourceLoopId)).rows[0];
    await invokeApprove(targetLoopId);
    await cleanup(targetLoopId);
    const targetTaskId = (await pool.query(`select t.id from loop_tasks t join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id where p.loop_id=$1`, [targetLoopId])).rows[0].id;

    await assert.rejects(
      () => pool.query(`insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,status,repository_id,base_sha)
        values ($1,$2,$3,'queued',$4,$5)`, [targetTaskId, source.work_item_id, randomUUID(), source.repository_id, source.base_sha]),
      (error) => error.code === "23505" && /uq_loop_task_runs_work_item/.test(error.constraint),
    );

    await pool.query("update loop_work_items set loop_id=$1 where loop_id=$2 and work_item_id=$3 and relation_type='task_execution'",
      [targetLoopId, sourceLoopId, source.work_item_id]);
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(source.work_item_id, {
        status: "done", execution_attempt_id: source.payload.execution_attempt_id,
      }),
      /v2_task_execution_identity_mismatch/,
    );
    const sourceUnchanged = (await rowsFor(sourceLoopId)).rows[0];
    assert.deepEqual([sourceUnchanged.status, sourceUnchanged.run_status, sourceUnchanged.work_status], ["in_progress", "queued", "ready"]);

    const primaryWork = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1,'task','loop',$2,'fake primary','ready',$3::jsonb) returning id`,
      [targetLoopId, targetLoopId, JSON.stringify({ execution_attempt_id: randomUUID() })])).rows[0];
    await pool.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'primary_execution')",
      [targetLoopId, primaryWork.id]);
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(primaryWork.id, { status: "done" }),
      /primary_execution_requires_v1/,
    );
    await pool.query("update work_items set status='canceled' where id=$1", [primaryWork.id]);

    const fakeAttempt = randomUUID();
    const fakeTaskWork = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1,'task','loop',$2,'fake task','ready',$3::jsonb) returning id`,
      [targetLoopId, targetTaskId, JSON.stringify({ execution_attempt_id: fakeAttempt })])).rows[0];
    await pool.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')",
      [targetLoopId, fakeTaskWork.id]);
    await assert.rejects(
      () => pool.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')",
        [sourceLoopId, fakeTaskWork.id]),
      (error) => error.code === "23505" && /uq_loop_work_items_task_execution_work_item/.test(error.constraint),
    );
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(fakeTaskWork.id, {
        status: "done", execution_attempt_id: fakeAttempt,
      }),
      /v2_task_execution_run_cardinality/,
    );
  } finally {
    await cleanup(sourceLoopId);
    await cleanup(targetLoopId);
  }
});

test("final V2 review rejects an extra fake/cross-loop task work-item mapping", async () => {
  const created = await invokeCreate(chainPayload({ stages: [{ key: "only", title: "Only", tasks: [{ key: "real", title: "Real" }] }] }));
  const loopId = created.payload.loop.id;
  try {
    await invokeApprove(loopId);
    await invokeMaterialize();
    const real = (await rowsFor(loopId)).rows[0];
    await completeImplementationAndApprove(loopId, real);
    const fake = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1,'task','loop',$2,'fake final mapping','done','{}'::jsonb) returning id`, [loopId, loopId])).rows[0];
    await pool.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [loopId, fake.id]);
    const review = await invokeReview(loopId, { action: "approve_deliverable" });
    assert.equal(review.status, 409);
    assert.equal(review.payload.error, "v2_task_runs_inconsistent");
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "in_review");
  } finally { await cleanup(loopId); }
});

test("cloud/non-local Project create fails closed before any transaction", async () => {
  let transactions = 0;
  const cloudRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/project/create/route.ts"), {
    "node:crypto": { randomUUID }, "next/server": nextServer,
    "@/lib/auth/local": { isLocalAuthDisabled: () => false, getLocalMissionControlUser: () => null },
    "@/lib/db/postgres": { withTransaction: async () => { transactions += 1; } },
    "@/lib/loops/qa-policy": qaPolicy,
  });
  const response = await cloudRoute.POST({ json: async () => chainPayload() });
  assert.equal(response.status, 503);
  assert.equal(transactions, 0);
});
