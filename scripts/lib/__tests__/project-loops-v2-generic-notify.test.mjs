import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function transpile(sourcePath, requires = {}) {
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, {
    module: cjs,
    exports: cjs.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected import ${specifier}`);
    },
    Date, JSON, Object, Array, String, Number, RegExp, Error,
  }, { filename: sourcePath });
  return cjs.exports;
}

test("generic scheduler notify identity is canonical and timestamp-bound", () => {
  const contract = transpile(resolve(repoRoot, "src/lib/work-items/generic-notify-contract.ts"), {
    "node:crypto": { createHash },
  });
  const row = {
    id: "10000000-0000-4000-8000-000000000001",
    status: "in_progress",
    updated_at: new Date("2026-07-30T10:00:00.000Z"),
    source_type: "loop",
    source_id: "20000000-0000-4000-8000-000000000002",
    owner_agent: "systems",
    target_agent_id: null,
    payload: { runtime_contract: "implementation_v1", run_role: "implementation" },
  };
  const expected = contract.buildGenericNotifyClassificationIdentity(row);
  assert.equal(contract.genericNotifyIdentityMatches(expected, row), true);
  assert.equal(contract.genericNotifyIdentityMatches(expected, {
    ...row,
    updated_at: "2026-07-30 11:00:00.000456+01",
  }), true);
  assert.equal(contract.genericNotifyIdentityMatches(expected, {
    ...row,
    updated_at: new Date("2026-07-30T10:00:01.000Z"),
  }), false);
  assert.equal(contract.isVisualQaLikeWorkItem({ ...row, payload: {
    runtime_contract: "visual_qa_vl",
    run_role: "QA",
    target_run_id: row.id,
    target_sha: "a".repeat(40),
    execution_attempt_id: row.id,
    quality_cycle: 1,
    qa_policy_hash: "b".repeat(64),
  } }), true);
  assert.equal(contract.isVisualQaLikeWorkItem({ ...row, payload: { policy_hash: "b".repeat(64) } }), false);
});

test("generic scheduler notify revalidates the locked current row before wake", () => {
  const route = readFileSync(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), "utf8");
  assert.match(route, /caller === "generic_scheduler_v1"/);
  assert.match(route, /genericNotifyIdentityMatches\(schedulerClassificationIdentity, current\)/);
  assert.match(route, /for update/);
  assert.match(route, /withTransaction[\s\S]*wakeAgent\(/);
});
