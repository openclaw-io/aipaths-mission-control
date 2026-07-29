import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { REVIEW_CAPABILITY_TTL_MS } from "../reviewer-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 8 });
const REPOSITORY_PATH = repoRoot;
const REPOSITORY_KEY = "phase4-test-worktree";
const TEST_WORKTREE_PREFIX = `/Users/joaco/openclaw/worktrees/.mc-phase4-${process.pid}`;
const BUILDER_WORKTREE = `${TEST_WORKTREE_PREFIX}-builder`;
const cycleWorktrees = new Map();
let SHA1;
let SHA2;
let SHA3;
let UNRELATED_SHA;

function transpileModule(sourcePath, requires = {}, globals = {}) {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule, exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Buffer, Date, Number, Set, Map, JSON, String, RegExp, Object, Array, Math, Promise, Error, console,
    process: { env: { AGENT_API_KEY: "test-key" } },
    ...globals,
  }, { filename: sourcePath });
  return cjsModule.exports;
}

async function postgresTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };
const localAuth = { isLocalAuthDisabled: () => true, getLocalMissionControlUser: () => ({ email: "reviewer@test" }) };
const executionInstruction = transpileModule(resolve(repoRoot, "src/lib/loops/execution-instruction.ts"));
const gitArtifact = transpileModule(resolve(repoRoot, "src/lib/work-items/git-artifact.ts"), {
  "node:child_process": { execFile }, "node:fs/promises": { realpath },
});
const createRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/project/create/route.ts"), {
  "node:crypto": { createHash, randomUUID }, "next/server": nextServer,
  "@/lib/auth/local": localAuth, "@/lib/db/postgres": { withTransaction: postgresTransaction },
});
const approveRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/[id]/approve/route.ts"), {
  "node:crypto": { createHash }, "next/server": nextServer, "@/lib/auth/local": localAuth,
  "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/supabase/server": { createClient: async () => { throw new Error("cloud forbidden"); } },
});
const materializeRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/materialize-queued/route.ts"), {
  "node:crypto": { createHash, randomUUID }, "next/server": nextServer,
  "@/lib/db/postgres": { query: (sql, params) => pool.query(sql, params), withTransaction: postgresTransaction },
  "@/lib/execution-window": { getExecutionWindowConfig: async () => ({}), isExecutionWindowOpenNow: () => ({ open: true, source: "test", mode: "open" }) },
  "@/lib/loops/execution-instruction": executionInstruction,
  "@/lib/work-items/git-artifact": gitArtifact,
  "@/lib/loops/lifecycle-local": {
    getPrimaryExecutionWorkItemLocal: async () => null, isPrimaryExecutionOpen: () => false,
    reconcileLoopStatusWithPrimaryExecutionLocal: async () => {}, supersedePrimaryExecutionLinksLocal: async () => {},
  },
});
const reviewRoute = transpileModule(resolve(repoRoot, "src/app/api/loops/[id]/review/route.ts"), {
  "node:crypto": { randomUUID }, "next/server": nextServer, "@/lib/auth/local": localAuth,
  "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/supabase/server": { createClient: async () => { throw new Error("cloud forbidden"); } },
  "@/lib/loops/execution-instruction": executionInstruction,
});
const youtubePipeline = transpileModule(resolve(repoRoot, "src/lib/youtube-pipeline.ts"));
const completion = transpileModule(resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts"), {
  "@/lib/youtube-pipeline": youtubePipeline,
  "@/lib/work-items/git-artifact": gitArtifact,
});
const { isTrustedImplementationDispatchSessionId } = completion;
const agentCompletion = transpileModule(resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts"), {
  "@/lib/content/live-verification": { verifyPublishedContent: async () => { throw new Error("verification forbidden"); } },
  "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": { query: (sql, params) => pool.query(sql, params), withTransaction: postgresTransaction },
  "@/lib/work-items/completion-orchestration": completion,
});
const reviewCompletion = transpileModule(resolve(repoRoot, "src/lib/reviewer/review-completion.ts"), {
  "node:crypto": { randomUUID },
});
const reviewerPackage = transpileModule(resolve(repoRoot, "src/lib/reviewer/package.ts"), {
  "node:crypto": { createHash }, "@/lib/work-items/git-artifact": gitArtifact,
});
const reviewerExecutionContext = transpileModule(resolve(repoRoot, "src/lib/reviewer/execution-context.ts"));
const reviewerDispatch = transpileModule(resolve(repoRoot, "src/lib/reviewer/dispatch.ts"), {
  "node:child_process": { spawn: () => { throw new Error("real reviewer spawn forbidden in tests"); } },
  "node:crypto": { createHash, randomBytes, randomUUID }, "node:path": { resolve },
  "@/lib/reviewer/package": reviewerPackage,
  "@/lib/reviewer/execution-context": reviewerExecutionContext,
  "@/lib/reviewer/review-completion": reviewCompletion,
  "../../../scripts/lib/reviewer-contract.mjs": { REVIEW_CAPABILITY_TTL_MS },
});
const reviewerCompleteRoute = transpileModule(resolve(repoRoot, "src/app/api/reviewer/executions/[id]/complete/route.ts"), {
  "node:crypto": { createHash, timingSafeEqual }, "next/server": nextServer,
  "@/lib/db/postgres": { withTransaction: postgresTransaction },
  "@/lib/reviewer/execution-context": reviewerExecutionContext,
  "@/lib/reviewer/package": reviewerPackage,
  "@/lib/reviewer/review-completion": reviewCompletion,
});
const reviewerReconcileRoute = transpileModule(resolve(repoRoot, "src/app/api/reviewer/reconcile/route.ts"), {
  "next/server": nextServer,
  "@/lib/db/postgres": { query: (sql, params) => pool.query(sql, params), withTransaction: postgresTransaction },
  "@/lib/reviewer/execution-context": reviewerExecutionContext,
  "@/lib/reviewer/review-completion": reviewCompletion,
});

before(async () => {
  execFileSync("git", ["-C", REPOSITORY_PATH, "worktree", "add", "--detach", BUILDER_WORKTREE, "HEAD"]);
  const evidencePath = resolve(BUILDER_WORKTREE, `.phase4-quality-cycle-${process.pid}.txt`);
  const commitCycle = (cycle) => {
    writeFileSync(evidencePath, `quality cycle ${cycle}\n`, "utf8");
    execFileSync("git", ["-C", BUILDER_WORKTREE, "add", evidencePath]);
    execFileSync("git", ["-C", BUILDER_WORKTREE, "-c", "user.name=Mission Control Test", "-c", "user.email=mc-test@local", "commit", "-m", `test: phase4 cycle ${cycle}`]);
    return execFileSync("git", ["-C", BUILDER_WORKTREE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  SHA1 = commitCycle(1);
  SHA2 = commitCycle(2);
  SHA3 = commitCycle(3);
  for (const [sha, suffix] of [[SHA1, "cycle1"], [SHA2, "cycle2"]]) {
    const path = `${TEST_WORKTREE_PREFIX}-${suffix}`;
    execFileSync("git", ["-C", REPOSITORY_PATH, "worktree", "add", "--detach", path, sha]);
    cycleWorktrees.set(sha, path);
  }
  cycleWorktrees.set(SHA3, BUILDER_WORKTREE);
  const unrelatedPath = `${TEST_WORKTREE_PREFIX}-unrelated`;
  UNRELATED_SHA = execFileSync("git", ["-C", REPOSITORY_PATH,
    "-c", "user.name=Mission Control Test", "-c", "user.email=mc-test@local",
    "commit-tree", `${SHA1}^{tree}`, "-m", "test: unrelated phase4 artifact"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", REPOSITORY_PATH, "worktree", "add", "--detach", unrelatedPath, UNRELATED_SHA]);
  cycleWorktrees.set(UNRELATED_SHA, unrelatedPath);

  const identity = await gitArtifact.inspectRepositoryRegistration(REPOSITORY_PATH);
  await pool.query(`insert into review_repositories(key,canonical_root,git_common_dir,object_format)
    values ($1,$2,$3,$4) on conflict (canonical_root) do update set enabled=true`,
    [REPOSITORY_KEY, identity.canonicalRoot, identity.gitCommonDir, identity.objectFormat]);
});
after(async () => {
  await pool.end();
  for (const path of new Set(cycleWorktrees.values())) {
    try { execFileSync("git", ["-C", REPOSITORY_PATH, "worktree", "remove", "--force", path]); } catch {}
  }
  try { execFileSync("git", ["-C", REPOSITORY_PATH, "worktree", "prune"]); } catch {}
});

function payload() {
  return {
    idempotency_key: randomUUID(), title: "Fresh review quality cycle", input: "Implement exactly.", owner_agent: "systems",
    repository: REPOSITORY_KEY,
    acceptance_criteria: ["Artifact is reviewed from an exact SHA"],
    approval_scope: { allowed_actions: ["edit_repository", "run_tests"], forbidden_actions: ["deploy"], notes: "Local only." },
    stages: [{ key: "build", title: "Build", tasks: [{ key: "task", title: "Implement task", description: "Implement only this task." }] }],
  };
}
async function createStartedLoop() {
  const created = await createRoute.POST({ json: async () => payload() });
  assert.equal(created.status, 201);
  const loopId = created.payload.loop.id;
  const revision = (await pool.query("select current_plan_revision_id plan_revision_id,content_hash plan_hash from loops join loop_plan_revisions on loop_plan_revisions.id=loops.current_plan_revision_id where loops.id=$1", [loopId])).rows[0];
  const approved = await approveRoute.POST({ json: async () => ({ action: "approve", queue: true, decision_id: randomUUID(), ...revision }) }, { params: Promise.resolve({ id: loopId }) });
  assert.equal(approved.status, 200);
  await materializeRoute.POST({ headers: { get: () => "Bearer test-key" } });
  assert.ok(await currentWork(loopId), "the requested Loop must be materialized even when test files share a scheduler pass");
  return loopId;
}
async function currentWork(loopId) {
  return (await pool.query(`select wi.id,wi.status,wi.instruction,wi.payload,r.id run_id,r.run_role,r.quality_cycle,r.status run_status,t.id task_id,t.status task_status
    from work_items wi join loop_task_runs r on r.work_item_id=wi.id join loop_tasks t on t.id=r.task_id
    join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
    where p.loop_id=$1 order by r.created_at desc,r.id desc limit 1`, [loopId])).rows[0];
}
async function dispatch(workItemId, sessionId = randomUUID()) {
  await pool.query("update work_items set status='in_progress',payload=payload||jsonb_build_object('dispatch_session_id',$2::text) where id=$1 and status in ('ready','in_progress')", [workItemId, sessionId]);
  return sessionId;
}
// Cross-contract fixture: mirrors the generic scheduler's buildDispatchSessionId shape.
function schedulerDispatchSessionId(workItemId, attempt, nonce = randomUUID()) {
  return `${workItemId}:attempt-${attempt}:${nonce}`;
}
async function finishImplementation(loopId, sha, sessionId = randomUUID(), bodySessionId = randomUUID()) {
  const work = await currentWork(loopId);
  assert.equal(work.run_role, "implementation");
  await dispatch(work.id, sessionId);
  await agentCompletion.patchAgentWorkItemWithCompletion(work.id, {
    status: "done", execution_attempt_id: work.payload.execution_attempt_id,
    session_id: bodySessionId, output: { head_sha: sha, repository_path: cycleWorktrees.get(sha) || REPOSITORY_PATH },
  });
  return { work, sessionId, review: await currentWork(loopId) };
}
async function finishReview(loopId, { verdict, sha, sessionId = randomUUID(), findings = [], feedback = null } = {}) {
  const work = await currentWork(loopId);
  assert.equal(work.run_role, "review");
  await dispatch(work.id, sessionId);
  return postgresTransaction(async (client) => {
    await client.query("update loop_task_runs set status='running',started_at=now(),updated_at=now() where id=$1 and status='queued'", [work.run_id]);
    const execution = (await client.query(`select 'running'::text status,'in_progress'::text work_status,r.id review_run_id,r.work_item_id,r.execution_attempt_id,
      r.repository_id,r.base_sha,r.target_sha,r.task_id,r.quality_cycle,r.target_run_id implementation_run_id,
      impl.server_session_id implementer_session_id,t.status task_status,t.title task_title,s.id stage_id,
      s.plan_revision_id,p.content_hash plan_hash,l.id loop_id,l.status loop_status,l.priority,l.owner_agent
      from loop_task_runs r join loop_task_runs impl on impl.id=r.target_run_id join loop_tasks t on t.id=r.task_id
      join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
      join loops l on l.id=p.loop_id where r.id=$1 for update of r,t,l`, [work.run_id])).rows[0];
    assert.equal(execution.target_sha, sha);
    await reviewCompletion.applyReviewerResult(client, execution, { verdict, feedback, findings }, sessionId);
    return { work, sessionId };
  });
}
async function retire(loopId) { await pool.query("update loops set status='completed',updated_at=now() where id=$1", [loopId]); }

function reviewerCompletionRequest(token, body) {
  return {
    headers: { get: (name) => name === "authorization" ? `ReviewCapability ${token}` : null },
    json: async () => body,
  };
}

async function invokeReviewerCompletion(executionId, token, body) {
  return reviewerCompleteRoute.POST(reviewerCompletionRequest(token, body), {
    params: Promise.resolve({ id: executionId }),
  });
}


test("phase 4 migration artifacts exist and declare the fresh-review invariants", async () => {
  const migration = resolve(repoRoot, "supabase/migrations/034_project_loops_v2_quality_cycles.sql");
  const artifact = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase4");
  assert.equal(existsSync(migration), true);
  for (const name of ["preflight.sql", "forward.sql", "verify.sql", "rollback.sql", "README.md"]) assert.equal(existsSync(resolve(artifact, name)), true, name);
  const sources = [readFileSync(migration, "utf8"), readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8")];
  for (const source of sources) {
    assert.match(source, /fresh_review_v1/);
    assert.match(source, /server_session_id text/);
    assert.match(source, /artifact_sha text/);
    assert.match(source, /target_run_id uuid/);
    assert.match(source, /run_role IN \('implementation', 'review'\)/);
    assert.match(source, /quality_cycle BETWEEN 1 AND 3/);
    assert.match(source, /review_pending/);
    assert.match(source, /rework_required/);
  }
  assert.match(readFileSync(resolve(artifact, "verify.sql"), "utf8"), /TRANSACTION READ ONLY/i);
  assert.match(readFileSync(resolve(artifact, "rollback.sql"), "utf8"), /RAISE EXCEPTION/i);
});

test("trusted implementation dispatch identities match only local UUIDs or the scheduler contract", () => {
  const workItemId = "4a5b4ddd-35b2-4e9f-a928-8fc55ab6f3e8";
  const nonce = "6f5ec6f4-f08b-4bc0-a096-345ba74a4d92";
  const accepted = [
    nonce,
    schedulerDispatchSessionId(workItemId, 1, nonce),
    schedulerDispatchSessionId(workItemId, 42, nonce),
  ];
  for (const identity of accepted) {
    assert.equal(isTrustedImplementationDispatchSessionId(identity), true, identity);
  }

  const schedulerIdentity = schedulerDispatchSessionId(workItemId, 2, nonce);
  const rejected = [
    null,
    undefined,
    "",
    "arbitrary-session",
    `noise:${schedulerIdentity}`,
    ` ${schedulerIdentity}`,
    schedulerDispatchSessionId(workItemId, 0, nonce),
    `${workItemId}:attempt--1:${nonce}`,
    `${workItemId}:attempt-01:${nonce}`,
    `${workItemId}:attempt-1.5:${nonce}`,
    `${workItemId}:ATTEMPT-2:${nonce}`,
    `${workItemId}:attempt-${Number.MAX_SAFE_INTEGER + 1}:${nonce}`,
    `${workItemId}:attempt-${"9".repeat(129)}:${nonce}`,
    `${workItemId}:attempt-2:not-a-uuid`,
    `${workItemId}:attempt-2:${nonce}:trailing-noise`,
  ];
  for (const identity of rejected) {
    assert.equal(isTrustedImplementationDispatchSessionId(identity), false, String(identity));
  }
});

async function withPhase3MigrationDatabase(run) {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const name = generateMissionControlTestDatabaseName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${quotePostgresIdentifier(name)}`);
    const client = new pg.Client({ connectionString: databaseUrlForName(adminUrl, name) });
    await client.connect();
    try {
      const artifact = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase4");
      await client.query(readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8"));
      await client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8"));
      await run(client, artifact);
    } finally { await client.end(); }
  } finally {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [name]);
    await admin.query(`drop database if exists ${quotePostgresIdentifier(name)}`);
    await admin.end();
  }
}

async function createCompatibilityTask(client, label) {
  const loopId = (await client.query("insert into loops(name,status) values ($1,'completed') returning id", [label])).rows[0].id;
  const revisionId = (await client.query("insert into loop_plan_revisions(loop_id,revision_number,status) values ($1,1,'draft') returning id", [loopId])).rows[0].id;
  const stageId = (await client.query("insert into loop_stages(plan_revision_id,key,title,status) values ($1,'stage','Stage','completed') returning id", [revisionId])).rows[0].id;
  return (await client.query("insert into loop_tasks(stage_id,key,title,status) values ($1,'task','Task','completed') returning id", [stageId])).rows[0].id;
}

test("phase 4 preflight rejects a compatibility run outside the global cycle range before DDL", async () => {
  await withPhase3MigrationDatabase(async (client, artifact) => {
    const taskId = await createCompatibilityTask(client, "Compatibility cycle four");
    await client.query("insert into loop_task_runs(task_id,quality_cycle,attempt_number,status) values ($1,4,1,'succeeded')", [taskId]);
    await assert.rejects(
      () => client.query(readFileSync(resolve(artifact, "preflight.sql"), "utf8")),
      /quality_cycle.*1\.\.3/i,
    );
    await client.query("rollback");
    assert.equal((await client.query("select to_regclass('public.uq_loop_task_runs_task_cycle_role') index_name")).rows[0].index_name, null);
    assert.equal((await client.query("select count(*)::int n from information_schema.columns where table_name='loop_task_runs' and column_name='server_session_id'")).rows[0].n, 0);
  });
});

test("phase 4 preflight rejects duplicate compatibility cycle/role identities before DDL", async () => {
  await withPhase3MigrationDatabase(async (client, artifact) => {
    const taskId = await createCompatibilityTask(client, "Compatibility duplicate runs");
    await client.query(`insert into loop_task_runs(task_id,quality_cycle,attempt_number,status)
      values ($1,1,1,'succeeded'),($1,1,2,'succeeded')`, [taskId]);
    await assert.rejects(
      () => client.query(readFileSync(resolve(artifact, "preflight.sql"), "utf8")),
      /technical retries.*uniqueness/i,
    );
    await client.query("rollback");
    assert.equal((await client.query("select to_regclass('public.uq_loop_task_runs_task_cycle_role') index_name")).rows[0].index_name, null);
    assert.equal((await client.query("select count(*)::int n from information_schema.columns where table_name='loop_task_runs' and column_name='server_session_id'")).rows[0].n, 0);
  });
});

test("phase 4 verify accepts legitimate rejected decisions for failed and cancelled review runs", async () => {
  await withPhase3MigrationDatabase(async (client, artifact) => {
    await client.query(readFileSync(resolve(artifact, "preflight.sql"), "utf8"));
    await client.query(readFileSync(resolve(artifact, "forward.sql"), "utf8"));
    const repositoryId = (await client.query(`insert into review_repositories
      (key,canonical_root,git_common_dir,object_format,enabled)
      values ('verify-terminal-review',$1,$2,'sha1',true) returning id`, [repoRoot, resolve(repoRoot, ".git")])).rows[0].id;

    for (const runStatus of ["failed", "cancelled"]) {
      const taskId = await createCompatibilityTask(client, `Legitimate ${runStatus} review`);
      const implementationId = (await client.query(`insert into loop_task_runs
        (task_id,run_role,quality_cycle,attempt_number,status,server_session_id,artifact_sha,repository_id,base_sha,started_at,finished_at)
        values ($1,'implementation',1,1,'succeeded',$2,$3,$4,$5,now()-interval '2 minutes',now()-interval '1 minute') returning id`,
      [taskId, `implementer-${runStatus}`, SHA1, repositoryId, SHA2])).rows[0].id;
      const reviewRunId = (await client.query(`insert into loop_task_runs
        (task_id,run_role,quality_cycle,attempt_number,status,target_run_id,target_sha,repository_id,base_sha,started_at,finished_at,error)
        values ($1,'review',1,2,$2,$3,$4,$5,$6,now()-interval '1 minute',now(),$7) returning id`,
      [taskId, runStatus, implementationId, SHA1, repositoryId, SHA2, `reviewer_${runStatus}`])).rows[0].id;
      await client.query(`insert into loop_task_reviews
        (task_id,task_run_id,review_run_id,quality_cycle,reviewed_sha,status,reviewer,feedback,decided_at,reviewer_session_id,decision_id)
        values ($1,$2,$3,1,$4,'rejected','strong-isolation-reviewer',$5,now(),$6,gen_random_uuid())`,
      [taskId, implementationId, reviewRunId, SHA1, `reviewer_${runStatus}`, `failed:${reviewRunId}`]);
    }

    await client.query(readFileSync(resolve(artifact, "verify.sql"), "utf8"));
    const decisions = await client.query(`select d.status,rr.status run_status
      from loop_task_reviews d join loop_task_runs rr on rr.id=d.review_run_id order by rr.status`);
    assert.deepEqual(decisions.rows.map((row) => ({ ...row })), [
      { status: "rejected", run_status: "cancelled" },
      { status: "rejected", run_status: "failed" },
    ]);
  });
});

test("adversarial contract: controlled fresh-review identity cannot be patched or incremented", async () => {
  const controlled = {
    dispatch_session_id: randomUUID(), dispatch_session_key: "spoof", runtime_contract: "spoof",
    source_loop_id: randomUUID(), loop_task_id: randomUUID(), task_run_id: randomUUID(), run_role: "review",
    quality_cycle: 3, target_run_id: randomUUID(), target_sha: SHA2, execution_attempt_id: randomUUID(),
    plan_revision_id: randomUUID(), plan_hash: "spoof",
  };
  for (const field of ["payload_patch", "payload_increment"]) {
    const loopId = await createStartedLoop();
    try {
      const work = await currentWork(loopId);
      await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(work.id, {
        status: "in_progress", execution_attempt_id: work.payload.execution_attempt_id, [field]: controlled,
      }), /fresh_review_controlled_payload_mutation/);
      const unchanged = await currentWork(loopId);
      assert.deepEqual([unchanged.status, unchanged.run_status], ["ready", "queued"]);
    } finally { await retire(loopId); }
  }
});

test("adversarial contract: implementation completion requires a real repository commit", async () => {
  const loopId = await createStartedLoop();
  try {
    const work = await currentWork(loopId);
    await dispatch(work.id);
    await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(work.id, {
      status: "done", execution_attempt_id: work.payload.execution_attempt_id,
      output: { head_sha: SHA1 },
    }), /implementation_repository_path_required/);
    const unchanged = await currentWork(loopId);
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.task_status], ["in_progress", "queued", "in_progress"]);
  } finally { await retire(loopId); }
});

test("cycle 1 rejects an unrelated commit from the registered git-common-dir before DB mutation", async () => {
  const loopId = await createStartedLoop();
  try {
    const work = await currentWork(loopId);
    await dispatch(work.id);
    await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(work.id, {
      status: "done", execution_attempt_id: work.payload.execution_attempt_id,
      output: { head_sha: UNRELATED_SHA, repository_path: cycleWorktrees.get(UNRELATED_SHA) },
    }), /implementation_not_descendant_of_registered_base/);
    const unchanged = await currentWork(loopId);
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.task_status], ["in_progress", "queued", "in_progress"]);
    assert.equal((await pool.query("select artifact_sha from loop_task_runs where id=$1", [work.run_id])).rows[0].artifact_sha, null);
    assert.equal((await pool.query("select count(*)::int n from loop_task_reviews where task_id=$1", [work.task_id])).rows[0].n, 0);
  } finally { await retire(loopId); }
});

test("phase 4 forward/verify/guarded rollback rehearse in disposable Postgres", async () => {
  const adminUrl = assertTestAdminDatabaseUrl(process.env.MISSION_CONTROL_TEST_ADMIN_URL).toString();
  const name = generateMissionControlTestDatabaseName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${quotePostgresIdentifier(name)}`);
    const client = new pg.Client({ connectionString: databaseUrlForName(adminUrl, name) });
    await client.connect();
    try {
      const artifact = resolve(repoRoot, "ops/migrations/20260729_project_loops_v2_phase4");
      await client.query(readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8"));
      await client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8"));

      const historicalLoop = (await client.query("insert into loops(name,status) values ('Phase 3 historical review','completed') returning id")).rows[0].id;
      const historicalRevision = (await client.query("insert into loop_plan_revisions(loop_id,revision_number,status) values ($1,1,'draft') returning id", [historicalLoop])).rows[0].id;
      const historicalStage = (await client.query("insert into loop_stages(plan_revision_id,key,title,status) values ($1,'stage','Stage','completed') returning id", [historicalRevision])).rows[0].id;
      const historicalTask = (await client.query("insert into loop_tasks(stage_id,key,title,status) values ($1,'task','Task','completed') returning id", [historicalStage])).rows[0].id;
      const historicalRun = (await client.query(`insert into loop_task_runs(task_id,run_role,quality_cycle,attempt_number,status,started_at,finished_at,output)
        values ($1,'implementation',1,1,'succeeded',now()-interval '1 minute',now(),jsonb_build_object('head_sha',$2::text)) returning id`,
      [historicalTask, SHA1])).rows[0].id;
      const historicalReview = (await client.query(`insert into loop_task_reviews(task_id,task_run_id,status,reviewer,feedback,decided_at)
        values ($1,$2,'approved','phase3-reviewer','historical approval',now()) returning id`, [historicalTask, historicalRun])).rows[0].id;
      await client.query("update loop_plan_revisions set status='approved',content_hash=$2,plan_snapshot='{}'::jsonb,approved_by='owner',approved_at=now() where id=$1", [historicalRevision, "a".repeat(64)]);
      await client.query("update loops set workflow_version=2,mode='dag',current_plan_revision_id=$2 where id=$1", [historicalLoop, historicalRevision]);

      await client.query(readFileSync(resolve(artifact, "preflight.sql"), "utf8"));
      await client.query(readFileSync(resolve(artifact, "forward.sql"), "utf8"));
      const rehearsalIdentity = await gitArtifact.inspectRepositoryRegistration(REPOSITORY_PATH);
      await client.query(`insert into review_repositories(key,canonical_root,git_common_dir,object_format,enabled)
        values ('phase4-rehearsal',$1,$2,$3,true)`,
      [rehearsalIdentity.canonicalRoot, rehearsalIdentity.gitCommonDir, rehearsalIdentity.objectFormat]);
      await client.query(readFileSync(resolve(artifact, "verify.sql"), "utf8"));
      const columns = await client.query("select count(*)::int n from information_schema.columns where table_name='loop_task_runs' and column_name=any($1)", [["server_session_id", "artifact_sha", "target_run_id", "target_sha"]]);
      assert.equal(columns.rows[0].n, 4);
      const preserved = (await client.query("select task_run_id,status,review_run_id,quality_cycle,reviewed_sha,findings from loop_task_reviews where id=$1", [historicalReview])).rows[0];
      assert.deepEqual({ ...preserved }, { task_run_id: historicalRun, status: "approved", review_run_id: null,
        quality_cycle: null, reviewed_sha: SHA1, findings: [] });
      await assert.rejects(client.query("update loop_task_reviews set feedback='mutated' where id=$1", [historicalReview]), /immutable/i);

      await client.query(readFileSync(resolve(artifact, "rollback.sql"), "utf8"));
      const rolledBackColumns = await client.query("select count(*)::int n from information_schema.columns where table_name='loop_task_reviews' and column_name=any($1)", [["review_run_id", "quality_cycle", "reviewed_sha", "reviewer_session_id", "findings", "decision_id"]]);
      assert.equal(rolledBackColumns.rows[0].n, 0);
      const rolledBackReview = (await client.query("select task_run_id,status,reviewer,feedback from loop_task_reviews where id=$1", [historicalReview])).rows[0];
      assert.deepEqual({ ...rolledBackReview }, { task_run_id: historicalRun, status: "approved", reviewer: "phase3-reviewer", feedback: "historical approval" });
    } finally { await client.end(); }
  } finally {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [name]);
    await admin.query(`drop database if exists ${quotePostgresIdentifier(name)}`);
    await admin.end();
  }
});

test("isolated dispatch verifies the DB contract and never launches a mismatched package", async () => {
  const loopId = await createStartedLoop();
  try {
    await finishImplementation(loopId, SHA1);
    const review = await currentWork(loopId);
    await pool.query("update work_items set payload=jsonb_set(payload,'{target_sha}',to_jsonb($2::text)) where id=$1", [review.id, SHA2]);
    let launches = 0;
    await assert.rejects(
      reviewerDispatch.dispatchReviewer(review.id, {
        withTransaction: postgresTransaction,
        launch: async () => { launches += 1; return 1001; },
      }),
      /isolated_review_identity_conflict/,
    );
    assert.equal(launches, 0);
    const unchanged = await currentWork(loopId);
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.task_status], ["ready", "queued", "review_pending"]);
    assert.equal((await pool.query("select count(*)::int n from reviewer_executions where work_item_id=$1", [review.id])).rows[0].n, 0);
  } finally { await retire(loopId); }
});

test("concurrent isolated dispatch and completion consume exactly one random capability", async () => {
  const loopId = await createStartedLoop();
  try {
    const { sessionId: implementerSession } = await finishImplementation(loopId, SHA1);
    const review = await currentWork(loopId);
    const launches = [];
    const launch = async (executionId, token) => {
      launches.push({ executionId, token });
      return 2000 + launches.length;
    };
    const dispatches = await Promise.allSettled([
      reviewerDispatch.dispatchReviewer(review.id, { withTransaction: postgresTransaction, launch }),
      reviewerDispatch.dispatchReviewer(review.id, { withTransaction: postgresTransaction, launch }),
    ]);
    assert.equal(dispatches.filter((entry) => entry.status === "fulfilled").length, 2);
    const dispatchResults = dispatches.map((entry) => entry.value);
    assert.equal(dispatchResults.filter((entry) => entry.already_running === true).length, 1);
    assert.equal(new Set(dispatchResults.map((entry) => entry.execution_id)).size, 1);
    assert.equal(launches.length, 1);
    const [{ executionId, token }] = launches;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const execution = (await pool.query("select * from reviewer_executions where id=$1", [executionId])).rows[0];
    assert.equal(Buffer.from(execution.capability_hash).toString("hex"), createHash("sha256").update(token).digest("hex"));
    assert.equal(JSON.stringify(execution).includes(token), false);

    const baseBody = {
      session_id: "20260729_120000_a1b2c3",
      package_sha256: execution.package_sha256,
      execution_attempt_id: execution.execution_attempt_id,
      result: { verdict: "approved", feedback: null, findings: [] },
    };
    assert.equal((await invokeReviewerCompletion(executionId, randomBytes(32).toString("base64url"), baseBody)).status, 401);
    assert.equal((await invokeReviewerCompletion(executionId, token, { ...baseBody, package_sha256: "0".repeat(64) })).status, 409);
    assert.equal((await invokeReviewerCompletion(executionId, token, { ...baseBody, execution_attempt_id: randomUUID() })).status, 409);
    assert.equal((await invokeReviewerCompletion(executionId, token, { ...baseBody, session_id: implementerSession })).status, 400,
      "non-Hermes implementation session identities cannot be supplied as reviewer sessions");
    assert.equal((await invokeReviewerCompletion(executionId, token, { ...baseBody,
      result: { ...baseBody.result, unknown: true } })).status, 400);

    await pool.query("update work_items set status='done',completed_at=now() where id=$1", [review.id]);
    assert.equal((await invokeReviewerCompletion(executionId, token, baseBody)).status, 409,
      "completion must reject a work-item/package state mismatch atomically");
    await pool.query("update work_items set status='in_progress',completed_at=null where id=$1", [review.id]);

    await pool.query("update reviewer_executions set capability_expires_at=now()-interval '1 second' where id=$1", [executionId]);
    assert.equal((await invokeReviewerCompletion(executionId, token, baseBody)).status, 410);
    await pool.query("update reviewer_executions set capability_expires_at=now()+interval '1 minute' where id=$1", [executionId]);

    const left = { ...baseBody, session_id: "20260729_120001_a1b2c3" };
    const right = { ...baseBody, session_id: "20260729_120002_d4e5f6" };
    const completions = await Promise.all([
      invokeReviewerCompletion(executionId, token, left),
      invokeReviewerCompletion(executionId, token, right),
    ]);
    assert.deepEqual(completions.map((response) => response.status).sort(), [200, 409]);
    const winner = completions.find((response) => response.status === 200);
    assert.equal(winner.payload.effect, "loop_task_review_approved");
    const terminal = (await pool.query(`select e.status execution_status,e.capability_consumed_at,e.reviewer_session_id,
      r.status run_status,d.status decision_status,wi.status work_status,t.status task_status,s.status stage_status,l.status loop_status
      from reviewer_executions e join loop_task_runs r on r.id=e.review_run_id join loop_task_reviews d on d.review_run_id=r.id
      join work_items wi on wi.id=e.work_item_id join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id join loops l on l.id=p.loop_id where e.id=$1`, [executionId])).rows[0];
    assert.deepEqual({ ...terminal, capability_consumed_at: Boolean(terminal.capability_consumed_at) }, {
      execution_status: "succeeded", capability_consumed_at: true, reviewer_session_id: terminal.reviewer_session_id,
      run_status: "succeeded", decision_status: "approved", work_status: "done", task_status: "completed",
      stage_status: "completed", loop_status: "in_review",
    });
    const replayBody = terminal.reviewer_session_id === left.session_id ? left : right;
    assert.equal((await invokeReviewerCompletion(executionId, token, replayBody)).status, 409);
    assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1 and event_type='loop.task_review_approved'", [loopId])).rows[0].n, 1);
  } finally { await retire(loopId); }
});

test("stale reviewer reconciliation revokes capability and coherently closes review, work, task, stage and Loop", async () => {
  const loopId = await createStartedLoop();
  try {
    await finishImplementation(loopId, SHA1);
    const review = await currentWork(loopId);
    let capability;
    const dispatched = await reviewerDispatch.dispatchReviewer(review.id, {
      withTransaction: postgresTransaction,
      launch: async (_executionId, token) => { capability = token; return 3001; },
    });
    assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
    await pool.query("update reviewer_executions set heartbeat_at=now()-interval '20 minutes' where id=$1", [dispatched.execution_id]);
    const reconciled = await reviewerReconcileRoute.POST({ headers: { get: () => "Bearer test-key" } });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.payload.reconciled, 1);
    assert.deepEqual(Array.from(reconciled.payload.execution_ids), [dispatched.execution_id]);
    const state = (await pool.query(`select e.status execution_status,e.capability_revoked_at,e.error,
      r.status run_status,d.status decision_status,wi.status work_status,t.status task_status,s.status stage_status,l.status loop_status
      from reviewer_executions e join loop_task_runs r on r.id=e.review_run_id join loop_task_reviews d on d.review_run_id=r.id
      join work_items wi on wi.id=e.work_item_id join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id join loops l on l.id=p.loop_id where e.id=$1`, [dispatched.execution_id])).rows[0];
    assert.deepEqual({ ...state, capability_revoked_at: Boolean(state.capability_revoked_at) }, {
      execution_status: "failed", capability_revoked_at: true, error: "reviewer_execution_stale_timeout",
      run_status: "failed", decision_status: "rejected", work_status: "failed", task_status: "blocked",
      stage_status: "blocked", loop_status: "blocked",
    });
    assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1 and event_type='loop.reviewer_execution_failed'", [loopId])).rows[0].n, 1);
  } finally { await retire(loopId); }
});

test("cycle 1 implementation creates a fresh read-only review and approval completes task", async () => {
  const loopId = await createStartedLoop();
  try {
    const { work, sessionId, review } = await finishImplementation(loopId, SHA1);
    assert.equal(review.run_role, "review");
    assert.equal(review.quality_cycle, 1);
    assert.equal(review.task_status, "review_pending");
    assert.equal(review.payload.runtime_contract, "fresh_review_v1");
    assert.equal(review.payload.target_run_id, work.run_id);
    assert.equal(review.payload.target_sha, SHA1);
    assert.match(review.instruction, /read[- ]only/i);
    assert.match(review.instruction, new RegExp(SHA1));
    const implementation = (await pool.query("select status,artifact_sha,server_session_id from loop_task_runs where id=$1", [work.run_id])).rows[0];
    assert.deepEqual({ ...implementation }, { status: "succeeded", artifact_sha: SHA1, server_session_id: sessionId });
    await finishReview(loopId, { verdict: "approved", sha: SHA1 });
    const state = (await pool.query(`select l.status loop_status,s.status stage_status,t.status task_status,r.status review_status,tr.status decision,tr.reviewed_sha
      from loops l join loop_plan_revisions p on p.id=l.current_plan_revision_id join loop_stages s on s.plan_revision_id=p.id join loop_tasks t on t.stage_id=s.id
      join loop_task_runs r on r.task_id=t.id and r.run_role='review' join loop_task_reviews tr on tr.review_run_id=r.id where l.id=$1`, [loopId])).rows[0];
    assert.deepEqual({ ...state }, { loop_status: "in_review", stage_status: "completed", task_status: "completed", review_status: "succeeded", decision: "approved", reviewed_sha: SHA1 });
  } finally { await retire(loopId); }
});

test("cycle 2 accepts the scheduler dispatch identity, stores it exactly, and creates fresh review work", async () => {
  const loopId = await createStartedLoop();
  try {
    await finishImplementation(loopId, SHA1);
    await finishReview(loopId, { verdict: "changes_requested", sha: SHA1, findings: [{ severity: "major", title: "Tests missing", evidence: "The diff adds no test coverage.", recommendation: "Add the missing tests." }], feedback: "Add the missing tests." });
    let work = await currentWork(loopId);
    assert.equal(work.run_role, "implementation");
    assert.equal(work.quality_cycle, 2);
    assert.equal(work.task_status, "in_progress");
    assert.equal(work.payload.runtime_contract, "fresh_review_v1");
    const schedulerSessionId = schedulerDispatchSessionId(work.id, 2, "6f5ec6f4-f08b-4bc0-a096-345ba74a4d92");
    const bodySessionId = "user-body-session-id-must-not-be-trusted";
    const completed = await finishImplementation(loopId, SHA2, schedulerSessionId, bodySessionId);
    assert.equal(completed.review.run_role, "review");
    assert.equal(completed.review.quality_cycle, 2);
    assert.equal(completed.review.payload.target_sha, SHA2);
    const cycle2Implementation = (await pool.query(
      "select status,artifact_sha,server_session_id from loop_task_runs where id=$1",
      [work.run_id],
    )).rows[0];
    assert.deepEqual({ ...cycle2Implementation }, {
      status: "succeeded", artifact_sha: SHA2, server_session_id: schedulerSessionId,
    });
    assert.notEqual(cycle2Implementation.server_session_id, bodySessionId);
    await finishReview(loopId, { verdict: "approved", sha: SHA2 });
    const history = (await pool.query("select run_role,quality_cycle,status,artifact_sha,target_sha from loop_task_runs where task_id=$1 order by quality_cycle,run_role", [work.task_id])).rows;
    assert.equal(history.length, 4);
    assert.deepEqual(history.map((row) => [row.quality_cycle, row.run_role, row.status]), [[1,"implementation","succeeded"],[1,"review","succeeded"],[2,"implementation","succeeded"],[2,"review","succeeded"]]);
    assert.equal((await pool.query("select status from loops where id=$1", [loopId])).rows[0].status, "in_review");
  } finally { await retire(loopId); }
});

test("cycle 3 changes blocks task and Loop without creating cycle 4", async () => {
  const loopId = await createStartedLoop();
  try {
    for (const [index, sha] of [SHA1, SHA2, SHA3].entries()) {
      await finishImplementation(loopId, sha);
      await finishReview(loopId, { verdict: "changes_requested", sha, findings: [{ severity: "blocker", title: `Blocker ${index + 1}`, evidence: `Useful blocker ${index + 1}`, recommendation: `Fix blocker ${index + 1}` }], feedback: `Fix blocker ${index + 1}` });
    }
    const state = (await pool.query(`select l.status loop_status,t.status task_status,max(r.quality_cycle)::int max_cycle,count(*)::int runs
      from loops l join loop_plan_revisions p on p.id=l.current_plan_revision_id join loop_stages s on s.plan_revision_id=p.id join loop_tasks t on t.stage_id=s.id join loop_task_runs r on r.task_id=t.id
      where l.id=$1 group by l.status,t.status`, [loopId])).rows[0];
    assert.deepEqual({ ...state }, { loop_status: "blocked", task_status: "blocked", max_cycle: 3, runs: 6 });
    assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1 and event_type='loop.quality_cycles_exhausted'", [loopId])).rows[0].n, 1);
  } finally { await retire(loopId); }
});

test("same dispatch session and wrong SHA are rejected atomically; body session_id is ignored", async () => {
  const loopId = await createStartedLoop();
  try {
    const implementer = randomUUID();
    await finishImplementation(loopId, SHA1, implementer);
    const review = await currentWork(loopId);
    await dispatch(review.id, implementer);
    await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(review.id, {
      status: "done", execution_attempt_id: review.payload.execution_attempt_id,
      session_id: randomUUID(), output: { verdict: "approved", reviewed_sha: SHA1, findings: [] },
    }), /fresh_review_dedicated_reviewer_required/);
    let unchanged = await currentWork(loopId);
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.task_status], ["in_progress", "queued", "review_pending"]);
    await dispatch(review.id, randomUUID());
    await assert.rejects(() => agentCompletion.patchAgentWorkItemWithCompletion(review.id, {
      status: "done", execution_attempt_id: review.payload.execution_attempt_id,
      output: { verdict: "approved", reviewed_sha: SHA2, findings: [] },
    }), /fresh_review_dedicated_reviewer_required/);
    unchanged = await currentWork(loopId);
    assert.deepEqual([unchanged.status, unchanged.run_status, unchanged.task_status], ["in_progress", "queued", "review_pending"]);
  } finally { await retire(loopId); }
});

test("duplicate terminal completion is a no-op and DB prevents a second active fresh-review item", async () => {
  const loopId = await createStartedLoop();
  try {
    const { work } = await finishImplementation(loopId, SHA1);
    const eventCount = (await pool.query("select count(*)::int n from loop_events where loop_id=$1", [loopId])).rows[0].n;
    const replay = await agentCompletion.patchAgentWorkItemWithCompletion(work.id, { status: "done", execution_attempt_id: work.payload.execution_attempt_id, output: { head_sha: SHA1 } });
    assert.equal(replay.status, "done");
    assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1", [loopId])).rows[0].n, eventCount);
    await assert.rejects(() => pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1::uuid,'task','loop',$1::text,'duplicate','ready','{}'::jsonb)`, [loopId]),
      (error) => error.code === "23505" && /work_items_loop_active/.test(error.constraint));
  } finally { await retire(loopId); }
});

test("pending review rows cannot be deleted and incoherent direct SQL is rejected", async () => {
  const loopId = await createStartedLoop();
  try {
    const { review } = await finishImplementation(loopId, SHA1);
    const decision = (await pool.query("select id from loop_task_reviews where review_run_id=$1", [review.run_id])).rows[0];
    await assert.rejects(() => pool.query("delete from loop_task_reviews where id=$1", [decision.id]),
      (error) => error.code === "23514" && /pending Loop task review/i.test(error.message));
    await assert.rejects(() => pool.query("update loop_task_runs set target_sha=$2 where id=$1", [review.run_id, SHA2]),
      (error) => error.code === "23514" && /review run target/i.test(error.message));
    await assert.rejects(() => pool.query(`update loop_task_reviews set status='approved',reviewer='spoof',decided_at=now(),decision_id=$2 where id=$1`, [decision.id, randomUUID()]),
      (error) => error.code === "23514" && /review decision/i.test(error.message));
  } finally { await retire(loopId); }
});

test("final V2 review rejects pending/stale cycle and accepts only latest exact approved cycle", async () => {
  const loopId = await createStartedLoop();
  try {
    await finishImplementation(loopId, SHA1);
    let final = await reviewRoute.POST({ json: async () => ({ action: "approve_deliverable", decision_id: randomUUID() }) }, { params: Promise.resolve({ id: loopId }) });
    assert.equal(final.status, 409);
    await finishReview(loopId, { verdict: "changes_requested", sha: SHA1, findings: [{ severity: "major", title: "Rework needed", evidence: "The reviewed artifact is incomplete.", recommendation: "Complete the requested rework." }], feedback: "Do rework" });
    await finishImplementation(loopId, SHA2);
    final = await reviewRoute.POST({ json: async () => ({ action: "approve_deliverable", decision_id: randomUUID() }) }, { params: Promise.resolve({ id: loopId }) });
    assert.equal(final.status, 409);
    await finishReview(loopId, { verdict: "approved", sha: SHA2 });
    final = await reviewRoute.POST({ json: async () => ({ action: "approve_deliverable", decision_id: randomUUID() }) }, { params: Promise.resolve({ id: loopId }) });
    assert.equal(final.status, 200);
    assert.equal(final.payload.status, "completed");
  } finally { await retire(loopId); }
});

test("notifier derives Loop identity from work_items.loop_id, validates agent ownership, and requeue rejects fresh review", () => {
  const notifier = readFileSync(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), "utf8");
  const requeue = readFileSync(resolve(repoRoot, "src/app/api/work-items/[id]/requeue/route.ts"), "utf8");
  const reviewUi = readFileSync(resolve(repoRoot, "src/components/loops/LoopReviewActions.tsx"), "utf8");
  const detail = readFileSync(resolve(repoRoot, "src/components/loops/LoopDetail.tsx"), "utf8");
  assert.match(notifier, /item\.loop_id/);
  assert.match(notifier, /notify_agent_identity_mismatch/);
  assert.match(notifier, /source_loop_id_mismatch/);
  assert.match(notifier, /dispatch_session_id/);
  assert.match(requeue, /fresh_review_v1[\s\S]*409/);
  assert.match(reviewUi, /workflowVersion\s*===\s*1[\s\S]*request_changes/);
  assert.match(detail, /Ciclo\s*\{.*qualityCycle.*\}\/3/s);
  assert.match(detail, /artifactSha/);
  assert.match(detail, /findingsCount/);
});
