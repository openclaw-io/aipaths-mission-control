import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA = "a".repeat(40);
const POLICY = {
  required: true,
  target_url: "http://127.0.0.1:3001/loops",
  viewports: [{ name: "desktop", width: 1440, height: 900 }],
  flows: ["Open the Loop detail"],
};
const RESULT = {
  verdict: "pass",
  tested_sha: SHA,
  viewport_checks: [{ viewport: "desktop", status: "pass", details: null }],
  flow_checks: [{ flow: "Open the Loop detail", status: "pass", details: null }],
  evidence: [{
    kind: "screenshot", storage_ref: "qa/exec/desktop.png", sha256: "b".repeat(64), bytes: 1234,
    media_type: "image/png", viewport: "desktop", flow: null,
  }],
  findings: [],
  error: null,
};

function transpile(sourcePath, requires = {}) {
  const source = readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, {
    module: cjs, exports: cjs.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected import ${specifier}`);
    },
    Buffer, Date, JSON, Object, Array, Set, Map, String, Number, RegExp, URL, Error,
  }, { filename: sourcePath });
  return cjs.exports;
}

test("Phase 5B migration and local operational artifacts declare the QA authority", () => {
  const migration = resolve(repoRoot, "supabase/migrations/035_project_loops_v2_visual_qa.sql");
  const artifact = resolve(repoRoot, "ops/migrations/20260730_project_loops_v2_phase5b");
  const sources = [readFileSync(migration, "utf8"), readFileSync(resolve(repoRoot, "ops/local-postgres/schema.sql"), "utf8")];
  for (const name of ["preflight.sql", "forward.sql", "verify.sql", "rollback.sql", "README.md"]) {
    assert.ok(readFileSync(resolve(artifact, name), "utf8").length > 0, name);
  }
  for (const source of sources) {
    assert.match(source, /qa_pending/);
    assert.match(source, /run_role IN \('implementation', 'review', 'qa'\)/);
    assert.match(source, /CREATE TABLE(?: IF NOT EXISTS)? public\.qa_executions/i);
    assert.match(source, /policy_hash/);
    assert.match(source, /result_hash/);
    assert.match(source, /visual_qa_v1/);
    assert.match(source, /QA run .*integrity mismatch/);
    assert.match(source, /Terminal QA execution is immutable/);
  }
  assert.match(readFileSync(resolve(artifact, "verify.sql"), "utf8"), /TRANSACTION READ ONLY/i);
  assert.match(readFileSync(resolve(artifact, "rollback.sql"), "utf8"), /RAISE EXCEPTION/i);
  for (const source of [
    readFileSync(resolve(artifact, "preflight.sql"), "utf8"),
    readFileSync(resolve(artifact, "forward.sql"), "utf8"),
    readFileSync(resolve(artifact, "verify.sql"), "utf8"),
  ]) {
    assert.match(source, /pg_auth_members/);
    assert.match(source, /member\s+IN\s*\([\s\S]*aipaths_mc_app[\s\S]*aipaths_mc_qa_owner[\s\S]*\)/i);
    assert.match(source, /roleid\s+IN\s*\([\s\S]*aipaths_mc_app[\s\S]*aipaths_mc_qa_owner[\s\S]*\)/i);
  }
  assert.match(readFileSync(resolve(artifact, "forward.sql"), "utf8"), /REVOKE CREATE ON SCHEMA public FROM PUBLIC,\s*aipaths_mc_app/i);
  assert.match(readFileSync(resolve(artifact, "rollback.sql"), "utf8"), /REVOKE CREATE ON SCHEMA public FROM PUBLIC,\s*aipaths_mc_app/i);
  const runtimeDb = readFileSync(resolve(repoRoot,"src/lib/db/postgres.ts"),"utf8");
  assert.match(runtimeDb,/postgres:\/\/aipaths_mc_app@127\.0\.0\.1:5432\/aipaths_mission_control_local/);
  assert.doesNotMatch(runtimeDb,/postgres:\/\/joaco@/);
  for (const runtimePath of ["src/lib/reviewer/dispatch.ts", "scripts/reviewer-runner.mjs", "scripts/register-review-repository.mjs"]) {
    const runtime = readFileSync(resolve(repoRoot, runtimePath), "utf8");
    assert.match(runtime, /postgres:\/\/aipaths_mc_app@127\.0\.0\.1:5432\/aipaths_mission_control_local/, runtimePath);
    assert.doesNotMatch(runtime, /postgres:\/\/joaco@/, runtimePath);
  }
  for (const plist of ["com.aipaths.mission-control.plist", "com.aipaths.mission-control.local.plist"]) {
    const service = readFileSync(resolve(repoRoot, "ops/macos", plist), "utf8");
    assert.match(service, /postgres:\/\/aipaths_mc_app@127\.0\.0\.1:5432\/aipaths_mission_control_local/);
    assert.doesNotMatch(service, /postgres:\/\/joaco@/);
    assert.doesNotMatch(service, /QA_AUTHORITY_HMAC_KEY/, "checked-in service definitions must not contain the HMAC secret");
  }
  const runbook = readFileSync(resolve(artifact, "README.md"), "utf8");
  assert.match(runbook, /install_qa_authority_hmac_key[\s\S]*QA_AUTHORITY_HMAC_KEY[\s\S]*verify\.sql[\s\S]*scheduler[\s\S]*current_user/i);
});

test("structured QA parser is exact, bounded, canonical, policy-bound and action-free", () => {
  const qa = transpile(resolve(repoRoot, "src/lib/qa/result.ts"), {
    "node:crypto": { createHash },
    "@/lib/loops/qa-policy": transpile(resolve(repoRoot, "src/lib/loops/qa-policy.ts")),
  });
  const parsed = qa.parseQaResult(JSON.stringify(RESULT), POLICY, SHA);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), RESULT);
  assert.match(qa.hashQaResult(parsed), /^[0-9a-f]{64}$/);
  assert.equal(qa.hashQaResult(parsed), qa.hashQaResult(JSON.parse(JSON.stringify(RESULT))));
  assert.equal(qa.hashQaPolicy(POLICY), qa.hashQaPolicy(JSON.parse(JSON.stringify(POLICY))));

  for (const invalid of [
    { ...RESULT, unknown: true },
    { ...RESULT, tested_sha: "c".repeat(40) },
    { ...RESULT, viewport_checks: [] },
    { ...RESULT, flow_checks: [{ ...RESULT.flow_checks[0], flow: "other" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], bytes: "raw bytes are forbidden" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], storage_ref: "https://example.com/network" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], storage_ref: "qa/./desktop.png" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], media_type: "application/x-executable" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], viewport: "tablet" }] },
    { ...RESULT, evidence: [{ ...RESULT.evidence[0], flow: "unknown" }] },
    { ...RESULT, verdict: "changes", findings: [] },
    { ...RESULT, verdict: "infrastructure_failure", error: null },
    { ...RESULT, verdict: "infrastructure_failure", viewport_checks: {}, flow_checks: [], evidence: [], findings: [], error: "browser down" },
    { ...RESULT, verdict: "infrastructure_failure", viewport_checks: [], flow_checks: {}, evidence: [], findings: [], error: "browser down" },
  ]) assert.throws(() => qa.parseQaResult(JSON.stringify(invalid), POLICY, SHA));

  const changes = { ...RESULT, verdict: "changes", viewport_checks: [{ viewport: "desktop", status: "fail", details: "Header overlaps" }],
    findings: [{ title: "Header overlap", evidence: "Desktop screenshot shows overlap", recommendation: "Fix header layout" }] };
  assert.equal(qa.parseQaResult(JSON.stringify(changes), POLICY).verdict, "changes");
  const infra = { ...RESULT, verdict: "infrastructure_failure", viewport_checks: [], flow_checks: [], evidence: [], findings: [], error: "browser_runner_unavailable" };
  assert.equal(qa.parseQaResult(JSON.stringify(infra), POLICY).verdict, "infrastructure_failure");
});

test("QA UTF-8 validation rejects embedded NUL and lone surrogates before persistence", () => {
  const policy = transpile(resolve(repoRoot, "src/lib/loops/qa-policy.ts"));
  const qa = transpile(resolve(repoRoot, "src/lib/qa/result.ts"), {
    "node:crypto": { createHash },
    "@/lib/loops/qa-policy": policy,
  });
  for (const invalid of ["prefix\0suffix", "prefix\ud800suffix", "prefix\udc00suffix"]) {
    assert.equal(policy.utf8ByteLength(invalid), Number.POSITIVE_INFINITY);
    assert.equal(policy.parsePersistedQaPolicy({ ...POLICY, flows: [invalid] }), null);
    assert.throws(() => qa.parseQaResult(JSON.stringify({
      ...RESULT,
      viewport_checks: [{ ...RESULT.viewport_checks[0], details: invalid }],
    }), POLICY, SHA));
  }
  assert.equal(policy.containsInvalidUtf8String({ nested: ["safe", "mid\0string"] }), true);
  assert.equal(policy.containsInvalidUtf8String({ nested: ["safe", "🚀"] }), false);

  const completion = readFileSync(resolve(repoRoot, "src/app/api/qa/executions/[id]/complete/route.ts"), "utf8");
  assert.ok(completion.indexOf("containsInvalidUtf8String(body?.result)") < completion.indexOf("withTransaction(async"),
    "completion must reject invalid result strings before opening a database transaction");
});

test("dedicated QA routes and every generic mutation path fail closed", () => {
  for (const path of [
    "src/app/api/qa/claim/route.ts",
    "src/app/api/qa/executions/[id]/complete/route.ts",
    "src/app/api/qa/executions/[id]/heartbeat/route.ts",
    "src/app/api/qa/reconcile/route.ts",
  ]) assert.ok(readFileSync(resolve(repoRoot, path), "utf8").length > 0, path);

  for (const path of [
    "src/lib/work-items/completion-orchestration.ts",
    "src/app/api/work-items/notify/route.ts",
    "src/app/api/work-items/[id]/requeue/route.ts",
    "src/app/api/work-items/[id]/reschedule/route.ts",
    "src/app/api/agent/work-items/[id]/route.ts",
  ]) {
    const source = readFileSync(resolve(repoRoot, path), "utf8");
    assert.match(source, /visual_qa_v1|isVisualQaLikeWorkItem/);
    if (path.endsWith("work-items/notify/route.ts")) {
      assert.match(source, /isVisualQaLikeWorkItem/);
    } else {
      assert.match(source, /run_role[^\n]{0,120}qa|qa[^\n]{0,120}run_role/);
    }
  }
});
