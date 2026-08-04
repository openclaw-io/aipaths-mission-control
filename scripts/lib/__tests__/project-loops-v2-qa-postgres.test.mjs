import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 12 });
const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const PLAN_HASH = "c".repeat(64);
const TEST_HMAC_KEY = "7f".repeat(32);
const POLICY = { required: true, target_url: "http://127.0.0.1:3001/loops",
  viewports: [{ name: "desktop", width: 1440, height: 900 }], flows: ["Open Loop detail"] };
const MULTI_POLICY = { required: true, target_url: "http://127.0.0.1:3001/loops",
  viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }],
  flows: ["Open Loop detail", "Close Loop detail"] };
const NO_QA = { required: false, target_url: null, viewports: [], flows: [] };
const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };

function transpile(path, requires = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: path,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, { module: cjs, exports: cjs.exports,
    require(specifier) { if (specifier in requires) return requires[specifier]; throw new Error(`Unexpected import ${specifier} from ${path}`); },
    Buffer, Date, JSON, Object, Array, Set, Map, String, Number, RegExp, URL, Error, Promise, console,
    process: { env: { AGENT_API_KEY: "qa-test-key", QA_AUTHORITY_HMAC_KEY: TEST_HMAC_KEY } }, ...globals,
  }, { filename: path });
  return cjs.exports;
}
async function tx(run) {
  const client = await pool.connect();
  try { await client.query("begin"); const value = await run(client); await client.query("commit"); return value; }
  catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
const qaPolicy = transpile(resolve(repoRoot, "src/lib/loops/qa-policy.ts"));
const qaResult = transpile(resolve(repoRoot, "src/lib/qa/result.ts"), {
  "node:crypto": { createHash }, "@/lib/loops/qa-policy": qaPolicy,
});
const qaAuthority = transpile(resolve(repoRoot, "src/lib/qa/authority.ts"), {
  "node:crypto": { createHmac }, "@/lib/qa/result": qaResult,
});
const qaExecution = transpile(resolve(repoRoot, "src/lib/qa/execution.ts"), { "node:crypto": { randomUUID } });
const reviewCompletion = transpile(resolve(repoRoot, "src/lib/reviewer/review-completion.ts"), {
  "node:crypto": { randomUUID }, "@/lib/loops/qa-policy": qaPolicy, "@/lib/qa/result": qaResult,
});
async function appTx(run) {
  return tx(async (client) => {
    await client.query("set local role aipaths_mc_app");
    return run(client);
  });
}
const db = { query: (sql, params) => appTx((client) => client.query(sql, params)), withTransaction: appTx };
const claimRoute = transpile(resolve(repoRoot, "src/app/api/qa/claim/route.ts"), {
  "node:crypto": { createHash, randomUUID, randomBytes: (await import("node:crypto")).randomBytes },
  "next/server": nextServer, "@/lib/db/postgres": db, "@/lib/loops/qa-policy": qaPolicy,
  "@/lib/qa/authority": qaAuthority, "@/lib/qa/result": qaResult,
});
const completeRoute = transpile(resolve(repoRoot, "src/app/api/qa/executions/[id]/complete/route.ts"), {
  "node:crypto": { createHash, timingSafeEqual }, "next/server": nextServer, "@/lib/db/postgres": db,
  "@/lib/qa/execution": qaExecution, "@/lib/qa/result": qaResult, "@/lib/loops/qa-policy": qaPolicy,
});
const heartbeatRoute = transpile(resolve(repoRoot, "src/app/api/qa/executions/[id]/heartbeat/route.ts"), {
  "node:crypto": { createHash, timingSafeEqual }, "next/server": nextServer, "@/lib/db/postgres": db,
  "@/lib/qa/execution": qaExecution,
});
const reconcileRoute = transpile(resolve(repoRoot, "src/app/api/qa/reconcile/route.ts"), {
  "next/server": nextServer, "@/lib/db/postgres": db, "@/lib/qa/execution": qaExecution,
});
const reviewRoute = transpile(resolve(repoRoot, "src/app/api/loops/[id]/review/route.ts"), {
  "node:crypto": { randomUUID }, "next/server": nextServer,
  "@/lib/auth/local": { isLocalAuthDisabled: () => true, getLocalMissionControlUser: () => ({ email: "qa-owner@example.test" }) },
  "@/lib/db/postgres": db, "@/lib/supabase/server": { createClient: async () => { throw new Error("cloud forbidden"); } },
  "@/lib/loops/execution-instruction": { buildLoopReworkInstruction: () => "unused" },
});
const youtubeLaunchPackage = transpile(resolve(repoRoot, "src/lib/youtube-launch-package.ts"), {
  "node:crypto": { randomUUID },
});
const completionOrchestration = transpile(resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts"), {
  "@/lib/youtube-pipeline": {},
  "@/lib/youtube-launch-package": {
    ...youtubeLaunchPackage,
    validateCommunityLaunchDraftOutput: () => ({ ok: true, errors: [] }),
  },
  "@/lib/youtube-launch-state": {
    validateYouTubeLaunchPreflight: () => ({ ok: true, status: "pass", checkedAt: null, blockers: [], gates: {}, evidence: {}, remediation: null }),
  },
  "@/lib/work-items/external-delivery": {},
  "@/lib/work-items/scheduled-launch-runtime": {},
  "@/lib/work-items/git-artifact": {},
});
const agentCompletion = transpile(resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts"), {
  "@/lib/content/live-verification": {}, "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": db, "@/lib/work-items/completion-orchestration": completionOrchestration,
});

await pool.query("select public.install_qa_authority_hmac_key($1)", [TEST_HMAC_KEY]);

after(async () => pool.end());

async function fixture({ policy = POLICY, cycle = 1 } = {}) {
  return tx(async (client) => {
    const suffix = randomUUID();
    const sessionSuffix = suffix.replaceAll("-", "").slice(0, 6);
    const implementerSession = `20260730_100000_${sessionSuffix}`;
    const reviewerSession = `20260730_110000_${sessionSuffix}`;
    const repositoryId = (await client.query(`insert into review_repositories(key,canonical_root,git_common_dir,object_format)
      values ($1,$2,$3,'sha1') returning id`, [`qa-${suffix}`, `/Users/joaco/openclaw/qa-${suffix}`, `/Users/joaco/openclaw/.git-qa-${suffix}`])).rows[0].id;
    const loopId = (await client.query(`insert into loops(name,status,priority,owner_agent)
      values ($1,'in_progress','medium','systems') returning id`, [`QA ${suffix}`])).rows[0].id;
    const revisionId = (await client.query(`insert into loop_plan_revisions(loop_id,revision_number,status)
      values ($1,1,'draft') returning id`, [loopId])).rows[0].id;
    await client.query(`update loops set workflow_version=2,mode='dag',current_plan_revision_id=$2,
      approval_scope=$3 where id=$1`, [loopId, revisionId, {
        approved: true, can_execute_unattended: true, approved_plan_revision_id: revisionId, approved_plan_hash: PLAN_HASH,
      }]);
    const stageId = (await client.query("insert into loop_stages(plan_revision_id,key,title,status) values ($1,'build','Build','in_progress') returning id", [revisionId])).rows[0].id;
    const metadata = policy === null ? {} : { qa_policy: policy };
    const taskId = (await client.query("insert into loop_tasks(stage_id,key,title,status,metadata) values ($1,'task','Task','review_pending',$2) returning id", [stageId, metadata])).rows[0].id;
    await client.query(`update loop_plan_revisions set status='approved',content_hash=$2,plan_snapshot='{}',approved_by='owner',approved_at=now()
      where id=$1`, [revisionId, PLAN_HASH]);
    const implAttempt = randomUUID();
    const implWork = (await client.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1,'task','loop',$2,'Implementation','done',$3) returning id`, [loopId, taskId, {
        runtime_contract: "fresh_review_v1", run_role: "implementation", execution_attempt_id: implAttempt,
        plan_revision_id: revisionId, plan_hash: PLAN_HASH,
      }])).rows[0].id;
    const implRun = (await client.query(`insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,
      server_session_id,artifact_sha,repository_id,base_sha,started_at,finished_at,output)
      values ($1,$2,$3,'implementation',$4,1,'succeeded',$5,$6,$7,$8,now()-interval '2 minutes',now()-interval '1 minute','{}') returning id`,
    [taskId, implWork, implAttempt, cycle, implementerSession, SHA, repositoryId, BASE_SHA])).rows[0].id;
    const reviewAttempt = randomUUID();
    const reviewWork = (await client.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
      values ($1,'task','loop',$2,'Review','in_progress',$3) returning id`, [loopId, taskId, {
        runtime_contract: "fresh_review_v1", run_role: "review", execution_attempt_id: reviewAttempt,
        target_run_id: implRun, target_sha: SHA, plan_revision_id: revisionId, plan_hash: PLAN_HASH,
      }])).rows[0].id;
    const reviewRun = (await client.query(`insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,
      target_run_id,target_sha,repository_id,base_sha,started_at,output)
      values ($1,$2,$3,'review',$4,2,'running',$5,$6,$7,$8,now(),'{}') returning id`,
    [taskId, reviewWork, reviewAttempt, cycle, implRun, SHA, repositoryId, BASE_SHA])).rows[0].id;
    await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution'),($1,$3,'task_execution')", [loopId, implWork, reviewWork]);
    await client.query(`insert into loop_task_reviews(task_id,task_run_id,review_run_id,quality_cycle,reviewed_sha,status)
      values ($1,$2,$3,$4,$5,'pending')`, [taskId, implRun, reviewRun, cycle, SHA]);
    return { suffix, implementerSession, reviewerSession, repositoryId, loopId, revisionId, stageId, taskId, implRun, reviewRun, reviewWork, cycle, policy };
  });
}
async function approve(f) {
  return tx((client) => reviewCompletion.applyReviewerResult(client, {
    id: randomUUID(), review_run_id: f.reviewRun, work_item_id: f.reviewWork, execution_attempt_id: randomUUID(),
    repository_id: f.repositoryId, base_sha: BASE_SHA, target_sha: SHA, package_sha256: "d".repeat(64),
    status: "running", work_status: "in_progress", task_id: f.taskId, task_status: "review_pending", task_title: "Task",
    stage_id: f.stageId, plan_revision_id: f.revisionId, plan_hash: PLAN_HASH, revision_status: "approved",
    current_plan_revision_id: f.revisionId, loop_id: f.loopId, loop_status: "in_progress", quality_cycle: f.cycle,
    implementation_run_id: f.implRun, implementer_session_id: f.implementerSession, priority: "medium", owner_agent: "systems",
    task_metadata: f.policy === null ? {} : { qa_policy: f.policy },
  }, { verdict: "approved", feedback: null, findings: [] }, f.reviewerSession));
}
async function qaWork(f) {
  return (await pool.query(`select wi.*,r.id qa_run_id,r.execution_attempt_id,r.target_sha from work_items wi
    join loop_task_runs r on r.work_item_id=wi.id where r.task_id=$1 and r.run_role='qa'`, [f.taskId])).rows[0];
}
function agentRequest(body) { return { headers: { get: (name) => name === "authorization" ? "Bearer qa-test-key" : null }, json: async () => body }; }
async function claim(work) {
  return claimRoute.POST(agentRequest({ work_item_id: work.id, execution_attempt_id: work.execution_attempt_id,
    target_sha: work.target_sha, policy_hash: work.payload.policy_hash }));
}
function result(verdict) {
  if (verdict === "infrastructure_failure") return { verdict, tested_sha: SHA, viewport_checks: [], flow_checks: [], evidence: [], findings: [], error: "browser_runner_unavailable" };
  const changes = verdict === "changes";
  return { verdict, tested_sha: SHA,
    viewport_checks: [{ viewport: "desktop", status: changes ? "fail" : "pass", details: changes ? "Header overlaps" : null }],
    flow_checks: [{ flow: "Open Loop detail", status: "pass", details: null }], evidence: [],
    findings: changes ? [{ title: "Header overlap", evidence: "Desktop check failed", recommendation: "Fix header" }] : [], error: null };
}
function canonicalBytes(value) { return Buffer.byteLength(qaResult.canonicalJson(value),"utf8"); }
function replaceCharacters(strings, needle, replacement, count) {
  const values=[...strings];
  for(let i=0;i<values.length&&count>0;i++) {
    const available=values[i].split(needle).length-1; const replacing=Math.min(available,count);
    if(replacing>0) {
      let replaced=0;
      values[i]=values[i].replaceAll(needle,() => replaced++<replacing ? replacement : needle);
      count-=replacing;
    }
  }
  assert.equal(count,0,"padding fixture had insufficient replaceable characters");
  return values;
}
function policyAtCanonicalBytes(target) {
  const control="\u0001";
  let policy={ required:true,
    target_url:`http://localhost/${"\\".repeat(2048-"http://localhost/".length)}`,
    viewports:Array.from({length:8},(_,i)=>({name:`${String.fromCharCode(65+i)}${control.repeat(78)}z`,width:320,height:320})),
    flows:Array.from({length:20},(_,i)=>`${String.fromCharCode(65+i)}${control.repeat(498)}z`),
  };
  let difference=canonicalBytes(policy)-target;
  assert.ok(difference>=0,`policy max ${canonicalBytes(policy)} must reach ${target}`);
  const controls=Math.floor(difference/5);
  const strings=replaceCharacters([...policy.viewports.map((v)=>v.name),...policy.flows],control,"a",controls);
  policy={...policy,
    viewports:policy.viewports.map((viewport,i)=>({...viewport,name:strings[i]})),
    flows:strings.slice(policy.viewports.length),
  };
  difference=canonicalBytes(policy)-target;
  policy={...policy,target_url:replaceCharacters([policy.target_url],"\\","a",difference)[0]};
  assert.equal(canonicalBytes(policy),target);
  return policy;
}
function resultAtCanonicalBytes(target) {
  const control="\u0001";
  let candidate={...result("changes"),
    viewport_checks:[{viewport:"desktop",status:"fail",details:`x${control.repeat(2046)}z`}],
    findings:Array.from({length:50},(_,i)=>({
      title:`${String.fromCharCode(65+i)}${control.repeat(498)}z`,
      evidence:`${String.fromCharCode(65+i)}${control.repeat(2046)}z`,
      recommendation:`${String.fromCharCode(65+i)}${control.repeat(2046)}z`,
    })),
  };
  const difference=canonicalBytes(candidate)-target;
  assert.ok(difference>=0,`result max ${canonicalBytes(candidate)} must reach ${target}`);
  let backslashes=0;
  while(backslashes<5&&(difference-4*backslashes<0||(difference-4*backslashes)%5!==0)) backslashes++;
  assert.ok(backslashes<5,"result padding delta must be representable by escaped and plain replacements");
  const plain=(difference-4*backslashes)/5;
  let fields=candidate.findings.flatMap((finding)=>[finding.title,finding.evidence,finding.recommendation]);
  fields=replaceCharacters(fields,control,"a",plain);
  fields=replaceCharacters(fields,control,"\\",backslashes);
  candidate={...candidate,findings:candidate.findings.map((finding,i)=>({
    title:fields[i*3],evidence:fields[i*3+1],recommendation:fields[i*3+2],
  }))};
  assert.equal(canonicalBytes(candidate),target);
  return candidate;
}
async function assertPolicyParity(label,policy,expected) {
  const tsValid=qaPolicy.parsePersistedQaPolicy(policy)!==null;
  const sqlValid=(await pool.query("select qa_policy_is_valid($1::jsonb) valid",[policy])).rows[0].valid;
  assert.equal(tsValid,sqlValid,`${label}: SQL/TS policy disagreement`);
  assert.equal(tsValid,expected,`${label}: unexpected policy validity`);
}
async function assertResultParity(label,candidate,policy,expected) {
  let tsValid=true;
  try { qaResult.parseQaResult(JSON.stringify(candidate),policy,SHA); } catch { tsValid=false; }
  const sqlValid=(await pool.query("select qa_result_is_valid($1::jsonb,$2,$3::jsonb) valid",[candidate,SHA,policy])).rows[0].valid;
  assert.equal(tsValid,sqlValid,`${label}: SQL/TS result disagreement`);
  assert.equal(tsValid,expected,`${label}: unexpected result validity`);
}
async function complete(claimed, verdict, session = claimed.payload.qa_session_id, overrides = {}) {
  const qa = result(verdict); const resultHash = qaResult.hashQaResult(qa);
  return completeRoute.POST({ headers: { get: () => `QaCapability ${claimed.payload.capability}` }, json: async () => ({
    session_id: session, execution_attempt_id: claimed.payload.execution_attempt_id, target_sha: claimed.payload.target_sha,
    policy_hash: claimed.payload.policy_hash, result_hash: resultHash, result: qa, ...overrides,
  }) }, { params: Promise.resolve({ id: claimed.payload.execution_id }) });
}
async function heartbeat(claimed, capability = claimed.payload.capability) {
  return heartbeatRoute.POST({ headers: { get: () => `QaCapability ${capability}` } },
    { params: Promise.resolve({ id: claimed.payload.execution_id }) });
}

async function expectAppDenied(sql, params = [], pattern = /permission denied|not allowed/i) {
  await assert.rejects(appTx((client) => client.query(sql, params)), pattern);
}

async function signedEnvelope(work, capability) {
  const row = (await pool.query(`select r.id qa_run_id,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,
      r.quality_cycle,r.repository_id,r.base_sha,wi.payload,p.id plan_revision_id,p.content_hash plan_hash,l.id loop_id,
      impl.server_session_id implementer_session_id,d.reviewer_session_id
    from loop_task_runs r join work_items wi on wi.id=r.work_item_id join loop_tasks t on t.id=r.task_id
    join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id join loops l on l.id=p.loop_id
    join loop_task_runs impl on impl.id=r.target_run_id join loop_task_reviews d on d.task_id=r.task_id
      and d.task_run_id=r.target_run_id and d.quality_cycle=r.quality_cycle and d.status='approved'
    where r.id=$1`, [work.qa_run_id])).rows[0];
  const claimedAt = new Date();
  const envelope = {
    version:"qa_claim_v1",execution_id:randomUUID(),qa_run_id:row.qa_run_id,task_id:row.task_id,work_item_id:row.work_item_id,
    execution_attempt_id:row.execution_attempt_id,target_run_id:row.target_run_id,target_sha:row.target_sha,
    policy_hash:row.payload.policy_hash,quality_cycle:row.quality_cycle,plan_revision_id:row.plan_revision_id,
    plan_hash:row.plan_hash,loop_id:row.loop_id,repository_id:row.repository_id,base_sha:row.base_sha,
    implementer_session_id:row.implementer_session_id,reviewer_session_id:row.reviewer_session_id,
    capability_hash:createHash("sha256").update(capability).digest("hex"),
    capability_expires_at:new Date(claimedAt.getTime()+30*60_000).toISOString(),
    qa_session_id:`${claimedAt.toISOString().slice(0,10).replaceAll("-","")}_${claimedAt.toISOString().slice(11,19).replaceAll(":","")}_${randomUUID().replaceAll("-","").slice(0,6)}`,
    claimed_at:claimedAt.toISOString(),
  };
  return { envelope, signature:qaAuthority.signQaClaimEnvelope(envelope) };
}

async function authorityState(executionId) {
  return (await pool.query(`select e.status execution_status,e.capability_consumed_at,e.result_hash,
    r.status run_status,wi.status work_status,t.status task_status,
    (select count(*)::int from loop_events where loop_id=p.loop_id) event_count
    from qa_executions e join loop_task_runs r on r.id=e.qa_run_id join work_items wi on wi.id=e.work_item_id
    join loop_tasks t on t.id=e.task_id join loop_stages s on s.id=t.stage_id
    join loop_plan_revisions p on p.id=s.plan_revision_id where e.id=$1`, [executionId])).rows[0];
}

async function invokeFinalReview(loopId) {
  return reviewRoute.POST({ json: async () => ({ action: "approve_deliverable", decision_id: randomUUID() }) },
    { params: Promise.resolve({ id: loopId }) });
}

async function addLatestApprovedImplementation(f, cycle, artifactSha) {
  const attempt = randomUUID();
  const implementationWork = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
    values ($1,'task','loop',$2,'Latest implementation','done',$3) returning id`, [f.loopId,f.taskId,{
      runtime_contract:"fresh_review_v1",run_role:"implementation",execution_attempt_id:attempt,
      plan_revision_id:f.revisionId,plan_hash:PLAN_HASH,
    }])).rows[0].id;
  const implementationRun = (await pool.query(`insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,
    attempt_number,status,server_session_id,artifact_sha,repository_id,base_sha,started_at,finished_at,output)
    values ($1,$2,$3,'implementation',$4,100,'succeeded',$5,$6,$7,$8,now(),now(),'{}') returning id`,
  [f.taskId,implementationWork,attempt,cycle,`20260730_160000_${f.suffix.replaceAll("-","").slice(0,6)}`,artifactSha,f.repositoryId,SHA])).rows[0].id;
  const reviewAttempt = randomUUID();
  const reviewWork = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
    values ($1,'task','loop',$2,'Latest review','done',$3) returning id`, [f.loopId,f.taskId,{
      runtime_contract:"fresh_review_v1",run_role:"review",execution_attempt_id:reviewAttempt,
      plan_revision_id:f.revisionId,plan_hash:PLAN_HASH,target_run_id:implementationRun,target_sha:artifactSha,
    }])).rows[0].id;
  const reviewerSession = `20260730_170000_${f.suffix.replaceAll("-","").slice(0,6)}`;
  const reviewRun = (await pool.query(`insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,
    attempt_number,status,target_run_id,target_sha,repository_id,base_sha,server_session_id,started_at,finished_at,output)
    values ($1,$2,$3,'review',$4,101,'succeeded',$5,$6,$7,$8,$9,now(),now(),'{}') returning id`,
  [f.taskId,reviewWork,reviewAttempt,cycle,implementationRun,artifactSha,f.repositoryId,SHA,reviewerSession])).rows[0].id;
  await pool.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution'),($1,$3,'task_execution')", [f.loopId,implementationWork,reviewWork]);
  await pool.query(`insert into loop_task_reviews(task_id,task_run_id,review_run_id,quality_cycle,reviewed_sha,status,
    reviewer_session_id,decision_id,decided_at,reviewer) values ($1,$2,$3,$4,$5,'approved',$6,gen_random_uuid(),now(),'qa-test')`,
  [f.taskId,implementationRun,reviewRun,cycle,artifactSha,reviewerSession]);
  return { implementationRun, implementationWork, artifactSha, cycle };
}

for (const [label, policy] of [["absent", null], ["required=false", NO_QA]]) {
  test(`${label} QA policy preserves direct review completion`, async () => {
    const f = await fixture({ policy }); const outcome = await approve(f);
    assert.equal(outcome.effect, "loop_task_review_approved");
    assert.equal((await pool.query("select status from loop_tasks where id=$1", [f.taskId])).rows[0].status, "completed");
    assert.equal((await pool.query("select count(*)::int n from loop_task_runs where task_id=$1 and run_role='qa'", [f.taskId])).rows[0].n, 0);
    const finalReview = await invokeFinalReview(f.loopId);
    assert.equal(finalReview.status, 200, JSON.stringify(finalReview.payload));
  });
}

test("required fresh approval creates exactly one bound QA work/run and qa_pending", async () => {
  const f = await fixture(); const outcome = await approve(f); assert.equal(outcome.effect, "loop_task_qa_pending");
  const work = await qaWork(f); assert.ok(work); assert.equal(work.status, "ready"); assert.equal(work.payload.runtime_contract, "visual_qa_v1");
  const state = (await pool.query("select status,(select count(*) from loop_task_runs where task_id=$1 and run_role='qa')::int runs from loop_tasks where id=$1", [f.taskId])).rows[0];
  assert.deepEqual({ ...state }, { status: "qa_pending", runs: 1 });
});

test("concurrent claim has one winner, exact bindings, and no raw token in PostgreSQL", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f);
  const claims = await Promise.all([claim(work), claim(work)]); assert.deepEqual(
    claims.map((r) => r.status).sort(), [201, 409], JSON.stringify(claims.map((r) => r.payload)),
  );
  const winner = claims.find((r) => r.status === 201); assert.match(winner.payload.capability, /^[A-Za-z0-9_-]{43}$/);
  const execution = (await pool.query("select * from qa_executions where id=$1", [winner.payload.execution_id])).rows[0];
  assert.equal(Buffer.from(execution.capability_hash).toString("hex"), createHash("sha256").update(winner.payload.capability).digest("hex"));
  assert.equal(JSON.stringify(execution).includes(winner.payload.capability), false);
  assert.match(winner.payload.qa_session_id, /^\d{8}_\d{6}_[0-9a-f]{6}$/);
  assert.equal(execution.qa_session_id, winner.payload.qa_session_id, "claim must persist its server-generated session identity");
});

test("passwordless LOGIN is the non-superuser application role", async () => {
  const appUrl = new URL(process.env.MISSION_CONTROL_TEST_DATABASE_URL);
  appUrl.username = "aipaths_mc_app"; appUrl.password = "";
  const client = new pg.Client({ connectionString:appUrl.toString() });
  await client.connect();
  try {
    const identity = (await client.query(`select current_user,
      (select rolsuper from pg_roles where rolname=current_user) rolsuper`)).rows[0];
    assert.deepEqual({ ...identity }, { current_user:"aipaths_mc_app", rolsuper:false });
  } finally { await client.end(); }
});

test("tracked Mission Control runtime wrappers never fall back to the operator database role", () => {
  const runtimeSources = [
    ".env.example",
    "scripts/refresh-youtube-metadata-launchd.sh",
    "scripts/sync-youtube-statistics-launchd.sh",
    "ops/macos/com.aipaths.mission-control.local.plist",
    "ops/macos/com.aipaths.mission-control.plist",
    "src/lib/db/postgres.ts",
    "scripts/reviewer-runner.mjs",
    "src/lib/reviewer/dispatch.ts",
    "scripts/register-review-repository.mjs",
  ];
  for (const source of runtimeSources) {
    const text = readFileSync(resolve(repoRoot, source), "utf8");
    assert.doesNotMatch(text, /postgres:\/\/joaco@127\.0\.0\.1:5432\/aipaths_mission_control_local/, source);
    assert.match(text, /aipaths_mc_app|MISSION_CONTROL_DATABASE_URL/, `${source} must use or require the app-role URL`);
  }
});

test("QA roles have zero membership edges and app keeps USAGE without schema CREATE", async () => {
  const state=(await pool.query(`select
    (select count(*)::int from pg_auth_members
      where member in (select oid from pg_roles where rolname in ('aipaths_mc_app','aipaths_mc_qa_owner'))
         or roleid in (select oid from pg_roles where rolname in ('aipaths_mc_app','aipaths_mc_qa_owner'))) membership_edges,
    has_schema_privilege('aipaths_mc_app','public','USAGE') app_usage,
    has_schema_privilege('aipaths_mc_app','public','CREATE') app_create,
    exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
      where n.nspname='public' and acl.grantee=0 and acl.privilege_type='CREATE') public_create`)).rows[0];
  assert.deepEqual({...state},{membership_edges:0,app_usage:true,app_create:false,public_create:false});
});

test("app role cannot read/rotate secrets or directly mutate, truncate, mint, or rebind QA executions", async () => {
  await expectAppDenied("select * from qa_authority_secrets");
  await expectAppDenied("select install_qa_authority_hmac_key($1)", ["11".repeat(32)]);
  assert.equal((await pool.query(`select has_function_privilege('aipaths_mc_app',
    'public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)','EXECUTE') allowed`)).rows[0].allowed, false);

  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  assert.equal(claimed.status,201,JSON.stringify(claimed.payload));
  const id = claimed.payload.execution_id;
  await expectAppDenied("insert into qa_executions(id) values ($1)",[randomUUID()]);
  for (const statement of [
    ["update qa_executions set capability_hash=digest('forged','sha256') where id=$1",[id]],
    ["update qa_executions set capability_expires_at=now()+interval '1 day' where id=$1",[id]],
    ["update qa_executions set qa_session_id='20260730_235959_abcdef' where id=$1",[id]],
    ["update qa_executions set target_sha=$2 where id=$1",[id,"e".repeat(40)]],
    ["update qa_executions set policy_hash=$2 where id=$1",[id,"e".repeat(64)]],
    ["update qa_executions set execution_attempt_id=$2 where id=$1",[id,randomUUID()]],
    ["delete from qa_executions where id=$1",[id]],
    ["truncate table qa_executions",[]],
  ]) await expectAppDenied(statement[0],statement[1]);
  assert.equal((await complete(claimed,"pass")).status,200,"legitimate app-role completion must remain usable");
});

test("app authority rejects forged HMAC and wrong raw capability, then accepts the legitimate signed route claim", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f);
  const capability = "A".repeat(43);
  const { envelope,signature } = await signedEnvelope(work,capability);
  await assert.rejects(appTx((client) => client.query("select claim_visual_qa_execution($1::jsonb,$2,$3)",
    [envelope,"0".repeat(64),capability])),/signature/i);
  await assert.rejects(appTx((client) => client.query("select claim_visual_qa_execution($1::jsonb,$2,$3)",
    [envelope,signature,"B".repeat(43)])),/envelope|capability/i);
  assert.equal((await pool.query("select count(*)::int n from qa_executions where work_item_id=$1",[work.id])).rows[0].n,0);
  const claimed = await claim(work);
  assert.equal(claimed.status,201,JSON.stringify(claimed.payload));
  assert.equal((await complete(claimed,"pass")).status,200);
});

test("expired raw capability cannot backdate infrastructure failure through direct app SQL", async () => {
  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  assert.equal(claimed.status,201,JSON.stringify(claimed.payload));
  const executionId = claimed.payload.execution_id;
  const claimedAt = new Date(Date.now()-2*60*60_000);
  const expiresAt = new Date(Date.now()-60*60_000);
  const finishedAt = new Date(Date.now()-90*60_000).toISOString();
  await pool.query("alter table qa_executions disable trigger qa_executions_integrity");
  try {
    await pool.query("update qa_executions set claimed_at=$2,capability_expires_at=$3 where id=$1",
      [executionId,claimedAt.toISOString(),expiresAt.toISOString()]);
  } finally {
    await pool.query("alter table qa_executions enable trigger qa_executions_integrity");
  }
  await pool.query("update loop_task_runs set status='failed',server_session_id=$2 where id=(select qa_run_id from qa_executions where id=$1)",
    [executionId,claimed.payload.qa_session_id]);
  const qa = result("infrastructure_failure");
  const resultHash = qaResult.hashQaResult(qa);
  const before = await authorityState(executionId);
  await assert.rejects(appTx((client) => client.query(
    "select complete_visual_qa_execution($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
    [executionId,claimed.payload.execution_attempt_id,claimed.payload.target_sha,claimed.payload.policy_hash,
      claimed.payload.qa_session_id,claimed.payload.capability,qa,resultHash,finishedAt])), /expired|capability/i);
  assert.deepEqual({ ...(await authorityState(executionId)) }, { ...before });
});

test("pass completion is single-consumer, session-isolated, exact-hash bound, compact, and terminal immutable", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f); const claimed = await claim(work); assert.equal(claimed.status, 201);
  const completions = await Promise.all([complete(claimed, "pass"), complete(claimed, "pass")]);
  assert.deepEqual(completions.map((r) => r.status).sort(), [200, 409], JSON.stringify(completions.map((r) => r.payload)));
  const row = (await pool.query(`select e.status,e.result_hash,e.capability_consumed_at,e.qa_session_id,r.status run_status,r.output,r.server_session_id,
    wi.status work_status,t.status task_status,l.status loop_status from qa_executions e join loop_task_runs r on r.id=e.qa_run_id
    join work_items wi on wi.id=e.work_item_id join loop_tasks t on t.id=e.task_id join loop_stages s on s.id=t.stage_id
    join loop_plan_revisions p on p.id=s.plan_revision_id join loops l on l.id=p.loop_id where e.id=$1`, [claimed.payload.execution_id])).rows[0];
  assert.equal(row.status, "succeeded"); assert.equal(row.run_status, "succeeded"); assert.equal(row.work_status, "done");
  assert.equal(row.task_status, "completed"); assert.equal(row.loop_status, "in_review"); assert.ok(row.capability_consumed_at);
  assert.notEqual(row.qa_session_id, f.implementerSession); assert.notEqual(row.qa_session_id, f.reviewerSession);
  assert.deepEqual(Object.keys(row.output).sort(), ["qa_execution_id", "result_hash", "tested_sha", "verdict"]);
  assert.equal(row.output.result_hash, row.result_hash); assert.equal(JSON.stringify(row.output).includes("storage_ref"), false);
  await assert.rejects(pool.query("update qa_executions set error='mutate' where id=$1", [claimed.payload.execution_id]), /immutable/i);
  await assert.rejects(pool.query("update loop_task_runs set output='{}' where id=$1", [work.qa_run_id]), /immutable/i);
});

test("completion rejects every request binding/session/result authority mismatch without any mutation", async () => {
  const cases = [
    ["wrong attempt", { execution_attempt_id: randomUUID() }, "20260730_121000_a1b2c3", 409],
    ["wrong target SHA", { target_sha: "e".repeat(40) }, "20260730_121001_a1b2c3", 409],
    ["wrong policy hash", { policy_hash: "e".repeat(64) }, "20260730_121002_a1b2c3", 409],
    ["wrong result hash", { result_hash: "e".repeat(64) }, "20260730_121003_a1b2c3", 409],
    ["malformed session", {}, "reviewer-session", 400],
    ["caller-chosen session", {}, "20260730_121004_a1b2c3", 409],
  ];
  for (const [label, overrides, session, expected] of cases) {
    const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
    const before = await authorityState(claimed.payload.execution_id);
    const response = await complete(claimed, "pass", session, overrides);
    assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.payload)}`);
    assert.deepEqual({ ...(await authorityState(claimed.payload.execution_id)) }, { ...before }, label);
  }
  for (const reused of ["implementer", "reviewer"]) {
    const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
    const before = await authorityState(claimed.payload.execution_id);
    const session = reused === "implementer" ? f.implementerSession : f.reviewerSession;
    const response = await complete(claimed, "pass", session);
    assert.equal(response.status, 409, `${reused}: ${JSON.stringify(response.payload)}`);
    assert.deepEqual({ ...(await authorityState(claimed.payload.execution_id)) }, { ...before }, reused);
  }
});

test("server-generated QA session cannot be reused across executions or quality cycles", async () => {
  const first = await fixture(); await approve(first); const firstClaim = await claim(await qaWork(first));
  const second = await fixture({ cycle: 2 }); await approve(second); const secondClaim = await claim(await qaWork(second));
  assert.notEqual(firstClaim.payload.qa_session_id, secondClaim.payload.qa_session_id);
  assert.equal((await complete(secondClaim, "pass", firstClaim.payload.qa_session_id)).status, 409);
  await assert.rejects(pool.query("update qa_executions set qa_session_id=$2 where id=$1",
    [secondClaim.payload.execution_id, firstClaim.payload.qa_session_id]), /unique|duplicate/i);
});

test("direct SQL rejects incoherent QA work identity and a coherent forged work-item GUC transition", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f);
  const bogusAttempt = randomUUID();
  const bogusWork = (await pool.query(`insert into work_items(loop_id,kind,source_type,source_id,title,status,payload)
    values ($1,'task','loop',$2,'Bogus QA','done',$3) returning id`, [f.loopId, f.taskId, {
      ...work.payload, execution_attempt_id: bogusAttempt, policy_hash: "e".repeat(64),
    }])).rows[0];
  await assert.rejects(pool.query(`update loop_task_runs set work_item_id=$2,execution_attempt_id=$3 where id=$1`,
    [work.qa_run_id,bogusWork.id,bogusAttempt]), /QA run .*integrity mismatch/i);
  for (const [column, value] of [["quality_cycle", f.cycle + 1], ["target_sha", "e".repeat(40)], ["target_run_id", f.reviewRun]]) {
    await assert.rejects(pool.query(`update loop_task_runs set ${column}=$2 where id=$1`, [work.qa_run_id, value]), /QA run .*integrity mismatch/i);
  }
  await assert.rejects(tx(async (client) => {
    const capabilityHash = createHash("sha256").update("forged-capability").digest();
    const executionId = randomUUID();
    await client.query(`insert into qa_executions(id,qa_run_id,task_id,work_item_id,execution_attempt_id,target_run_id,target_sha,
      policy_hash,status,capability_hash,capability_expires_at,qa_session_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()+interval '30 minutes','20260730_123000_f0f0f0')`,
    [executionId,work.qa_run_id,f.taskId,work.id,work.execution_attempt_id,f.implRun,SHA,work.payload.policy_hash,capabilityHash]);
    await client.query("update loop_task_runs set status='running',started_at=now() where id=$1", [work.qa_run_id]);
    await client.query("select set_config('app.visual_qa_transition','claim',true)");
    await client.query(`update work_items set status='in_progress',started_at=now(),
      payload=payload||jsonb_build_object('dispatch_state','in_progress','qa_execution_id',$2::text) where id=$1`, [work.id,executionId]);
  }), /dedicated transition authority/i);
  assert.equal((await pool.query("select status from work_items where id=$1", [work.id])).rows[0].status, "ready");
});

test("ordinary SQL cannot forge claim/complete authority without the raw capability after a real claim", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f); const claimed = await claim(work);
  assert.equal(claimed.status, 201);
  const before = await authorityState(claimed.payload.execution_id);
  await assert.rejects(tx(async (client) => {
    await client.query(`update loop_task_runs set status='succeeded',server_session_id=$2,finished_at=now(),
      output=jsonb_build_object('qa_execution_id',$3::text,'result_hash',$4::text,'tested_sha',$5::text,'verdict','pass') where id=$1`,
    [work.qa_run_id,claimed.payload.qa_session_id,claimed.payload.execution_id,"d".repeat(64),SHA]);
    await client.query("select transition_visual_qa_work_item($1,$2,'complete',now(),$3)",
      [work.id,claimed.payload.execution_id,"x".repeat(43)]);
  }), /capability/i);
  await assert.rejects(tx(async (client) => {
    await client.query(`update loop_task_runs set status='succeeded',server_session_id=$2,finished_at=now(),
      output=jsonb_build_object('qa_execution_id',$3::text,'result_hash',$4::text,'tested_sha',$5::text,'verdict','pass') where id=$1`,
    [work.qa_run_id,claimed.payload.qa_session_id,claimed.payload.execution_id,"d".repeat(64),SHA]);
    await client.query(`insert into qa_work_item_transition_authorities
      (backend_pid,transaction_id,work_item_id,execution_id,transition,capability_proof)
      values(pg_backend_pid(),txid_current(),$1,$2,'complete','forged-from-visible-hash')`,
    [work.id,claimed.payload.execution_id]);
    await client.query(`update work_items set status='done',completed_at=now(),updated_at=now(),
      payload=payload||jsonb_build_object('dispatch_state','completed','dispatch_completed_at',now()::text) where id=$1`, [work.id]);
  }), /capability|authority/i);
  assert.deepEqual({ ...(await authorityState(claimed.payload.execution_id)) }, { ...before });
  assert.equal((await complete(claimed,"pass")).status, 200, "the holder of the raw capability remains authorized");
});

test("database result validator rejects partial, malformed, NULL and verdict-incoherent terminal results", async () => {
  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  const malformed = [
    { verdict: "pass", tested_sha: SHA },
    { ...result("pass"), verdict: null },
    { ...result("pass"), viewport_checks: null },
    { ...result("pass"), viewport_checks: [{ viewport: "desktop", status: "fail", details: null }] },
    { ...result("changes"), viewport_checks: [{ viewport: "desktop", status: "pass", details: null }] },
  ];
  for (const candidate of malformed) {
    const valid = (await pool.query("select qa_result_is_valid($1::jsonb,$2,$3::jsonb) valid",
      [candidate,SHA,POLICY])).rows[0].valid;
    assert.equal(valid, false, JSON.stringify(candidate));
  }
  await assert.rejects(tx(async (client) => {
    const candidate = { ...result("pass"), verdict: null };
    await client.query("update loop_task_runs set status='succeeded',server_session_id=$2,finished_at=now() where id=$1",
      [claimed.payload.qa_run_id,claimed.payload.qa_session_id]);
    await client.query("select transition_visual_qa_work_item($1,$2,'complete',now(),$3)",
      [claimed.payload.work_item_id,claimed.payload.execution_id,claimed.payload.capability]);
    await client.query(`update qa_executions set status='succeeded',capability_consumed_at=now(),finished_at=now(),
      result=$2::jsonb,result_hash=qa_jsonb_sha256($2::jsonb) where id=$1`, [claimed.payload.execution_id,candidate]);
  }), /result.*integrity/i);
});

test("database result validator requires unique exact check coverage and mirrors evidence bounds", async () => {
  const completeChecks = {
    ...result("pass"),
    viewport_checks: [
      { viewport: "desktop", status: "pass", details: null },
      { viewport: "mobile", status: "pass", details: null },
    ],
    flow_checks: [
      { flow: "Open Loop detail", status: "pass", details: null },
      { flow: "Close Loop detail", status: "pass", details: null },
    ],
  };
  assert.equal((await pool.query("select qa_result_is_valid($1,$2,$3) valid", [completeChecks,SHA,MULTI_POLICY])).rows[0].valid, true);
  const invalid = [
    { ...completeChecks, viewport_checks: [completeChecks.viewport_checks[0], completeChecks.viewport_checks[0]] },
    { ...completeChecks, flow_checks: [completeChecks.flow_checks[0], completeChecks.flow_checks[0]] },
    { ...completeChecks, viewport_checks: [completeChecks.viewport_checks[0]] },
    { ...completeChecks, flow_checks: [completeChecks.flow_checks[0]] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"../secret.png",sha256:"e".repeat(64),bytes:1,media_type:"image/png",viewport:"desktop",flow:null }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/./desktop.png",sha256:"e".repeat(64),bytes:1,media_type:"image/png",viewport:"desktop",flow:null }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/desktop.png",sha256:"e".repeat(64),bytes:1,media_type:"application/x-executable",viewport:"desktop",flow:null }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/desktop.png",sha256:"e".repeat(64),bytes:1.5,media_type:"image/png",viewport:"desktop",flow:null }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/desktop.png",sha256:"e".repeat(64),bytes:1,media_type:"image/png",viewport:"tablet",flow:null }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/desktop.png",sha256:"e".repeat(64),bytes:1,media_type:"image/png",viewport:"desktop",flow:"Unknown flow" }] },
    { ...completeChecks, evidence: [{ kind:"screenshot",storage_ref:"qa/desktop.png",sha256:"e".repeat(64),bytes:1,media_type:"image/png",viewport:"desktop",flow:null,extra:true }] },
    { ...completeChecks, findings: [{ title:"x".repeat(501),evidence:"e",recommendation:"r" }] },
    { ...completeChecks, viewport_checks: completeChecks.viewport_checks.map((check,index) => index ? check : { ...check, details:"x".repeat(2049) }) },
  ];
  for (const candidate of invalid) {
    assert.equal((await pool.query("select qa_result_is_valid($1,$2,$3) valid", [candidate,SHA,MULTI_POLICY])).rows[0].valid,
      false, JSON.stringify(candidate));
  }
});

test("SQL persisted-policy validator accepts only canonical policies", async () => {
  for (const policy of [NO_QA,POLICY,MULTI_POLICY]) {
    assert.equal((await pool.query("select qa_policy_is_valid($1) valid", [policy])).rows[0].valid, true, JSON.stringify(policy));
  }
  for (const policy of [null,{}, { required:false }, { ...NO_QA, extra:true },
    { ...NO_QA, required:"false" }, { ...NO_QA, target_url:"http://example.test" },
    { ...POLICY, viewports:[POLICY.viewports[0],POLICY.viewports[0]] },
    { ...POLICY, flows:[POLICY.flows[0],POLICY.flows[0]] }]) {
    assert.equal((await pool.query("select qa_policy_is_valid($1) valid", [policy])).rows[0].valid, false, JSON.stringify(policy));
  }
});

test("SQL/TS persisted-policy parity covers UTF-8 bytes, URL grammar, NULL/exact keys, and exact 64KiB canonical boundary", async () => {
  const validUrls=["http://localhost","http://127.0.0.1:1/path?query","https://sub-domain.example.test:65535/a"];
  const invalidUrls=["HTTP://localhost","http://LOCALHOST","http://user@localhost","http://[::1]","http://127.0.0.1:0",
    "http://127.0.0.1:65536","http://127.0.0.1:01","http://01.2.3.4","http://256.1.1.1","http://-bad.example",
    "http://bad-.example","http://localhost/#fragment","http://localhost/\ncontrol"];
  for(const url of validUrls) await assertPolicyParity(`valid URL ${url}`,{...POLICY,target_url:url},true);
  for(const url of invalidUrls) await assertPolicyParity(`invalid URL ${JSON.stringify(url)}`,{...POLICY,target_url:url},false);

  await assertPolicyParity("80-byte astral viewport name",{...POLICY,viewports:[{...POLICY.viewports[0],name:"🚀".repeat(20)}]},true);
  await assertPolicyParity("84-byte astral viewport name",{...POLICY,viewports:[{...POLICY.viewports[0],name:"🚀".repeat(21)}]},false);
  await assertPolicyParity("500-byte astral flow",{...POLICY,flows:["🚀".repeat(125)]},true);
  await assertPolicyParity("504-byte astral flow",{...POLICY,flows:["🚀".repeat(126)]},false);
  await assertPolicyParity("canonical policy exactly 65536 bytes",policyAtCanonicalBytes(64*1024),true);
  await assertPolicyParity("canonical policy exactly 65537 bytes",policyAtCanonicalBytes(64*1024+1),false);

  for(const [label,policy] of [
    ["NULL policy",null],["missing key",{required:false,target_url:null,viewports:[]}],
    ["extra key",{...NO_QA,extra:null}],["NULL required",{...NO_QA,required:null}],
    ["NULL arrays",{...NO_QA,flows:null}],["viewport extra key",{...POLICY,viewports:[{...POLICY.viewports[0],extra:null}]}],
  ]) await assertPolicyParity(label,policy,false);
});

test("SQL/TS result parity covers UTF-8 bytes, NULL/exact keys, and exact 256KiB canonical boundary", async () => {
  await assertResultParity("baseline exact result",result("pass"),POLICY,true);
  const astralValid={...result("pass"),viewport_checks:[{viewport:"desktop",status:"pass",details:"🚀".repeat(512)}]};
  const astralInvalid={...result("pass"),viewport_checks:[{viewport:"desktop",status:"pass",details:"🚀".repeat(513)}]};
  await assertResultParity("2048-byte astral details",astralValid,POLICY,true);
  await assertResultParity("2052-byte astral details",astralInvalid,POLICY,false);
  await assertResultParity("canonical result exactly 262144 bytes",resultAtCanonicalBytes(256*1024),POLICY,true);
  await assertResultParity("canonical result exactly 262145 bytes",resultAtCanonicalBytes(256*1024+1),POLICY,false);

  const missing={...result("pass")}; delete missing.error;
  for(const [label,candidate] of [
    ["NULL result",null],["missing exact key",missing],["extra exact key",{...result("pass"),extra:null}],
    ["NULL verdict",{...result("pass"),verdict:null}],["NULL checks",{...result("pass"),viewport_checks:null}],
    ["NULL evidence",{...result("pass"),evidence:null}],["non-null pass error",{...result("pass"),error:"unexpected"}],
  ]) await assertResultParity(label,candidate,POLICY,false);
});

test("embedded NUL and lone surrogates are rejected deterministically before PostgreSQL jsonb", async () => {
  for (const invalid of ["inside\0text", "inside\ud800text", "inside\udc00text"]) {
    const policy={...POLICY,flows:[invalid]};
    assert.equal(qaPolicy.parsePersistedQaPolicy(policy),null);
    const candidate={...result("pass"),viewport_checks:[{viewport:"desktop",status:"pass",details:invalid}]};
    assert.throws(()=>qaResult.parseQaResult(JSON.stringify(candidate),POLICY,SHA));
  }
  // PostgreSQL jsonb cannot represent U+0000. This intentionally proves the
  // application preflight rejects it without attempting a jsonb parameter cast.
  assert.equal(qaPolicy.containsInvalidUtf8String({policy:{flow:"a\0b"},result:{details:"a\ud800b"}}),true);
});

test("TypeScript and PostgreSQL canonical QA hashes agree for Unicode and supported numeric boundaries", async () => {
  const values = [
    { z: "雪/🚀/é", a: [0, -1, 9007199254740991, -9007199254740991, 0.000001, 100000000000000000000] },
    { nested: { alpha: "\\u0000", omega: "𝄞" }, bool: true, nil: null },
  ];
  for (const value of values) {
    const tsHash = createHash("sha256").update(qaResult.canonicalJson(value)).digest("hex");
    const sqlHash = (await pool.query("select qa_jsonb_sha256($1::jsonb) hash", [JSON.stringify(value)])).rows[0].hash;
    assert.equal(sqlHash, tsHash, JSON.stringify(value));
  }
});

test("final V2 review requires the exact latest-cycle pass and rejects missing, pending, changes, failed and stale-cycle QA", async () => {
  const passed = await fixture(); await approve(passed); const passedClaim = await claim(await qaWork(passed));
  assert.equal((await complete(passedClaim, "pass")).status, 200);
  const passedFinalReview = await invokeFinalReview(passed.loopId);
  assert.equal(passedFinalReview.status, 200, JSON.stringify(passedFinalReview.payload));

  const missing = await fixture({ policy: NO_QA }); await approve(missing);
  await tx(async (client) => {
    await client.query("set local session_replication_role='replica'");
    await client.query("update loop_tasks set metadata=$2 where id=$1", [missing.taskId, { qa_policy: POLICY }]);
  });
  assert.equal((await invokeFinalReview(missing.loopId)).status, 409, "required QA missing");

  const pending = await fixture(); await approve(pending);
  await pool.query("update loop_tasks set status='completed' where id=$1", [pending.taskId]);
  await pool.query("update loop_stages set status='completed' where id=$1", [pending.stageId]);
  await pool.query("update loops set status='in_review' where id=$1", [pending.loopId]);
  assert.equal((await invokeFinalReview(pending.loopId)).status, 409, "required QA pending");

  for (const verdict of ["changes", "infrastructure_failure"]) {
    const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
    assert.equal((await complete(claimed, verdict)).status, 200);
    await pool.query("update loop_tasks set status='completed' where id=$1", [f.taskId]);
    await pool.query("update loop_stages set status='completed' where id=$1", [f.stageId]);
    await pool.query("update loops set status='in_review' where id=$1", [f.loopId]);
    assert.equal((await invokeFinalReview(f.loopId)).status, 409, verdict);
  }

  const stale = await fixture(); await approve(stale); const staleClaim = await claim(await qaWork(stale));
  assert.equal((await complete(staleClaim, "pass")).status, 200);
  await addLatestApprovedImplementation(stale, 2, "f".repeat(40));
  assert.equal((await invokeFinalReview(stale.loopId)).status, 409, "older-cycle pass must not authorize latest cycle");
});

test("final V2 review fails closed for every present malformed QA policy", async () => {
  for (const malformed of [null,{}, { required:false }, { ...NO_QA, extra:true }, { ...NO_QA, required:null },
    { ...NO_QA, required:"false" }, { ...NO_QA, target_url:"http://example.test" }]) {
    const f = await fixture({ policy:NO_QA }); await approve(f);
    await tx(async (client) => {
      await client.query("set local session_replication_role='replica'");
      await client.query("update loop_tasks set metadata=jsonb_build_object('qa_policy',$2::jsonb) where id=$1", [f.taskId,malformed]);
    });
    const response = await invokeFinalReview(f.loopId);
    assert.equal(response.status,409,JSON.stringify({ malformed,response:response.payload }));
  }
});

test("changes creates cycle+1; cycle 3 changes blocks without cycle 4", async () => {
  for (const cycle of [1, 3]) {
    const f = await fixture({ cycle }); await approve(f); const claimed = await claim(await qaWork(f));
    const completed = await complete(claimed, "changes");
    assert.equal(completed.status, 200, JSON.stringify(completed.payload));
    const state = (await pool.query("select status from loop_tasks where id=$1", [f.taskId])).rows[0].status;
    const maxCycle = (await pool.query("select max(quality_cycle)::int n from loop_task_runs where task_id=$1", [f.taskId])).rows[0].n;
    assert.deepEqual([state, maxCycle], cycle === 1 ? ["in_progress", 2] : ["blocked", 3]);
  }
});

test("infrastructure failure consumes authority into failed run/execution and blocks without product findings or cycle increment", async () => {
  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  const completed = await complete(claimed, "infrastructure_failure");
  assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  const state = (await pool.query(`select e.status,e.error,e.result,e.result_hash,e.capability_consumed_at,e.capability_revoked_at,
    r.status run_status,r.error run_error,wi.status work_status,t.status task_status,l.status loop_status,
    (select max(quality_cycle) from loop_task_runs where task_id=e.task_id)::int max_cycle
    from qa_executions e join loop_task_runs r on r.id=e.qa_run_id join work_items wi on wi.id=e.work_item_id
    join loop_tasks t on t.id=e.task_id join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
    join loops l on l.id=p.loop_id where e.id=$1`, [claimed.payload.execution_id])).rows[0];
  assert.deepEqual([state.status,state.run_status,state.work_status,state.task_status,state.loop_status,state.max_cycle], ["failed","failed","failed","blocked","blocked",1]);
  assert.ok(state.capability_consumed_at); assert.equal(state.capability_revoked_at, null); assert.equal(state.error, "browser_runner_unavailable");
  assert.equal(state.result.verdict, "infrastructure_failure"); assert.deepEqual(state.result.findings, []); assert.match(state.result_hash, /^[0-9a-f]{64}$/);
});

test("stale reconcile revokes capability and coherently blocks", async () => {
  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  await pool.query("update qa_executions set heartbeat_at=now()-interval '20 minutes' where id=$1", [claimed.payload.execution_id]);
  const reconciled = await reconcileRoute.POST(agentRequest({})); assert.equal(reconciled.status, 200); assert.equal(reconciled.payload.reconciled, 1);
  const row = (await pool.query("select status,capability_revoked_at,capability_consumed_at from qa_executions where id=$1", [claimed.payload.execution_id])).rows[0];
  assert.equal(row.status, "failed"); assert.ok(row.capability_revoked_at); assert.equal(row.capability_consumed_at, null);
});

test("capability heartbeat is authenticated and wins the stale-reconcile race under the execution lock", async () => {
  const f = await fixture(); await approve(f); const claimed = await claim(await qaWork(f));
  assert.equal((await heartbeat(claimed)).status, 200, "live capability heartbeat");
  await pool.query("update qa_executions set heartbeat_at=now()-interval '20 minutes' where id=$1", [claimed.payload.execution_id]);
  assert.equal((await heartbeat(claimed, "x".repeat(43))).status, 401);
  const [beat, reconciled] = await Promise.all([heartbeat(claimed), reconcileRoute.POST(agentRequest({}))]);
  assert.equal(reconciled.status, 200);
  const state = (await pool.query("select status,heartbeat_at from qa_executions where id=$1", [claimed.payload.execution_id])).rows[0];
  if (beat.status === 200) {
    assert.equal(state.status, "running", "successful heartbeat must prevent stale revocation");
    assert.equal(reconciled.payload.reconciled, 0);
  } else {
    assert.equal(beat.status, 409, JSON.stringify(beat.payload));
    assert.equal(state.status, "failed", "reconcile winner must revoke before a late heartbeat");
    assert.equal(reconciled.payload.reconciled, 1);
  }
});

test("DB guard rejects generic visual QA mutation/delete before mutation while dedicated API remains usable", async () => {
  const f = await fixture(); await approve(f); const work = await qaWork(f);
  await assert.rejects(pool.query("update work_items set status='done' where id=$1", [work.id]), /dedicated transition authority/i);
  await assert.rejects(pool.query("update work_items set scheduled_for=now() where id=$1", [work.id]), /dedicated transition authority|identity is immutable/i);
  await assert.rejects(pool.query("delete from work_items where id=$1", [work.id]), /cannot be deleted/i);
  await assert.rejects(agentCompletion.patchAgentWorkItemWithCompletion(work.id, { status: "done", execution_attempt_id: work.execution_attempt_id }), /dedicated_api_required/);
  const unchanged = (await pool.query("select status from work_items where id=$1", [work.id])).rows[0]; assert.equal(unchanged.status, "ready");
  assert.equal((await claim(work)).status, 201);
});
