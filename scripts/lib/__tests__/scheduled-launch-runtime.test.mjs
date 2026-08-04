import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/work-items/scheduled-launch-runtime.ts");

function loadModule() {
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, {
    module: cjs, exports: cjs.exports,
    require(specifier) { throw new Error(`Unexpected import ${specifier}`); },
    Date, Number, String, Object, Array, JSON, RegExp, Set, Math,
  }, { filename: sourcePath });
  return cjs.exports;
}

const runtime = loadModule();

test("Scheduled Launch transient failures persist the exact 1/5/15 retry sequence then dead-letter", () => {
  const now = "2026-08-04T12:00:00.000Z";
  let payload = {
    runtime_retry_contract: "scheduled_launch_v2_retry_v1",
    retry_policy: {
      retryable_delays_minutes: [1, 5, 15],
      retryable_failure_classes: ["runtime_unavailable", "provider_timeout", "transient_network"],
    },
  };

  for (const [attempt, delay] of [[1, 1], [2, 5], [3, 15]]) {
    const transition = runtime.nextScheduledLaunchRetryTransition(payload, {
      now,
      failureClass: "runtime_unavailable",
      error: `failure-${attempt}`,
    });
    assert.equal(transition.retryable, true);
    assert.equal(transition.attempt, attempt);
    assert.equal(transition.delayMinutes, delay);
    assert.equal(transition.status, "ready");
    assert.equal(transition.scheduledFor, new Date(Date.parse(now) + delay * 60_000).toISOString());
    assert.equal(transition.payload.runtime_retry_state.attempt, attempt);
    assert.equal(transition.payload.dispatch_state, "retry_scheduled");
    payload = transition.payload;
  }

  const exhausted = runtime.nextScheduledLaunchRetryTransition(payload, {
    now,
    failureClass: "runtime_unavailable",
    error: "failure-4",
  });
  assert.equal(exhausted.retryable, false);
  assert.equal(exhausted.attempt, 4);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.scheduledFor, null);
  assert.equal(exhausted.payload.dispatch_state, "dead_lettered");
  assert.equal(exhausted.payload.dead_letter_reason, "scheduled_launch_retries_exhausted");
});

test("Scheduled Launch gate failures are nonretryable blocked dead letters with remediation", () => {
  const transition = runtime.buildScheduledLaunchGateBlockedTransition({
    launch_state_contract: "scheduled_launch_v2",
  }, {
    now: "2026-08-04T12:00:00.000Z",
    failures: ["preflight_not_passed"],
    remediation: "Fix approvals, rerun preflight, then requeue.",
  });
  assert.equal(transition.status, "blocked");
  assert.equal(transition.payload.dispatch_state, "blocked_launch_gate");
  assert.equal(transition.payload.dispatch_failure_class, "nonretryable_gate");
  assert.equal(transition.payload.dead_letter_reason, "preflight_not_passed");
  assert.match(transition.payload.remediation, /rerun preflight/i);
});
