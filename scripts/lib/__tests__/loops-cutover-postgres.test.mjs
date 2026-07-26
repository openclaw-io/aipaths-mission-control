import assert from "node:assert/strict";
import test from "node:test";
import { runLoopsCutoverRehearsal } from "../../rehearse-loops-cutover.mjs";
import { splitTopLevelSql } from "../sql-editor-harness.mjs";

const unavailableCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "28P01", "42501"]);

function skipUnavailable(t, error) {
  if (!unavailableCodes.has(error?.code)) return false;
  t.skip(`PostgreSQL scratch unavailable: ${error.code}`);
  return true;
}

test("SQL Editor splitter preserves top-level DO/function dollar-quoted bodies", () => {
  const sql = `-- leading ; comment
DO $outer$ BEGIN PERFORM ';'; PERFORM $$nested text$$; END $outer$;
CREATE FUNCTION public.example() RETURNS text LANGUAGE sql AS $fn$ SELECT ';'::text; $fn$;
SELECT 'it''s;still one', "semi;colon";`;
  const statements = splitTopLevelSql(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /END \$outer\$;$/);
  assert.match(statements[1], /\$fn\$;$/);
  assert.match(statements[2], /still one/);
});

test("forward, postflight, CHECK/value transforms, and exact rollback execute on PostgreSQL scratch", async (t) => {
  try {
    const result = await runLoopsCutoverRehearsal();
    assert.deepEqual(
      { forward: result.forward, postflight: result.postflight, rollback: result.rollback, exactSchemaAndData: result.exactSchemaAndData },
      { forward: "passed", postflight: "passed", rollback: "passed", exactSchemaAndData: true },
    );
    assert.deepEqual(result.scenarios, ["cloud-shape", "local-shape"]);
    assert.deepEqual(result.sourceIdTypes, { "cloud-shape": "uuid", "local-shape": "text" });
    assert.equal(result.optionalDestinationCollision, "rejected");
    assert.equal(result.adversarialReviewerCases, "rejected-with-exact-fingerprints");
  } catch (error) {
    if (skipUnavailable(t, error)) return;
    throw error;
  }
});

test("SQL Editor autocommit forward and rollback recover an injected post-rename failure exactly", async (t) => {
  try {
    const result = await runLoopsCutoverRehearsal({ executionMode: "sql-editor", injectFailureAfterRename: true });
    assert.deepEqual(
      {
        executionMode: result.executionMode,
        injectedFailure: result.injectedFailure,
        rollback: result.rollback,
        exactSchemaAndData: result.exactSchemaAndData,
        helperObjectsRemaining: result.helperObjectsRemaining,
      },
      {
        executionMode: "sql-editor",
        injectedFailure: "after-rename",
        rollback: "passed",
        exactSchemaAndData: true,
        helperObjectsRemaining: 0,
      },
    );
  } catch (error) {
    if (skipUnavailable(t, error)) return;
    throw error;
  }
});

test("SQL Editor recovers exactly after every mutating forward statement", async (t) => {
  try {
    const result = await runLoopsCutoverRehearsal({ executionMode: "sql-editor", injectFailureAfterEveryMutation: true });
    assert.equal(result.injectedFailure, "after-every-recoverable-mutation");
    assert.equal(result.rollback, "passed");
    assert.equal(result.exactSchemaAndData, true);
    assert.equal(result.helperObjectsRemaining, 0);
    assert.deepEqual(result.checkpoints, [
      "metadata-created",
      "source-checks-widened",
      "rewrite-helper-created",
      "work-items-payload-rewritten",
      "project-events-payload-rewritten",
      "projects-metadata-rewritten",
      "terminal-orphans-marked",
      "work-item-values-rewritten",
      "source-checks-finalized",
      "project-event-values-rewritten",
      "namespace-renamed",
      "object-names-renamed",
      "primary-execution-index-ensured",
      "helpers-cleaned",
    ]);
    assert.equal(result.checkpointCount, result.checkpoints.length);
  } catch (error) {
    if (skipUnavailable(t, error)) return;
    throw error;
  }
});
