import assert from "node:assert/strict";
import test from "node:test";
import { runLoopsCutoverRehearsal } from "../../rehearse-loops-cutover.mjs";

test("forward, postflight, CHECK/value transforms, and exact rollback execute on PostgreSQL scratch", async (t) => {
  try {
    const result = await runLoopsCutoverRehearsal();
    assert.deepEqual(
      { forward: result.forward, postflight: result.postflight, rollback: result.rollback, exactSchemaAndData: result.exactSchemaAndData },
      { forward: "passed", postflight: "passed", rollback: "passed", exactSchemaAndData: true },
    );
    assert.deepEqual(result.scenarios, ["cloud-shape", "local-shape"]);
    assert.equal(result.optionalDestinationCollision, "rejected");
  } catch (error) {
    const unavailableCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "28P01", "42501"]);
    if (unavailableCodes.has(error?.code)) {
      t.skip(`PostgreSQL scratch unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
});
