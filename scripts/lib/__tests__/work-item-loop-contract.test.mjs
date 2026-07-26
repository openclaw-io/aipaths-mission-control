import assert from "node:assert/strict";
import test from "node:test";

import {
  getLoopStatusForPrimaryExecution,
  rewriteLegacyLoopPayload,
  rewriteLegacyLoopValue,
} from "../work-item-loop-contract.mjs";

test("controlled work-item payload keys are rewritten without touching user content", () => {
  const input = {
    source_project_id: "loop-1",
    source_project_title: "Launch academy",
    materialized_from_project: true,
    project_status_at_materialization: "queued",
    superseded_for_project_id: "loop-0",
    nested: { source_project_id: "must-not-change" },
    note: "user-authored project wording must remain intact",
  };

  assert.deepEqual(rewriteLegacyLoopPayload(input), {
    source_loop_id: "loop-1",
    source_loop_title: "Launch academy",
    materialized_from_loop: true,
    loop_status_at_materialization: "queued",
    superseded_for_loop_id: "loop-0",
    nested: { source_project_id: "must-not-change" },
    note: "user-authored project wording must remain intact",
  });
  assert.deepEqual(input, {
    source_project_id: "loop-1",
    source_project_title: "Launch academy",
    materialized_from_project: true,
    project_status_at_materialization: "queued",
    superseded_for_project_id: "loop-0",
    nested: { source_project_id: "must-not-change" },
    note: "user-authored project wording must remain intact",
  });
});

test("controlled persisted values are rewritten exactly", () => {
  assert.equal(rewriteLegacyLoopValue("source_type", "project"), "loop");
  assert.equal(rewriteLegacyLoopValue("event_type", "project.lifecycle_reconciled"), "loop.lifecycle_reconciled");
  assert.equal(rewriteLegacyLoopValue("actor", "project-planner"), "loop-planner");
  assert.equal(rewriteLegacyLoopValue("actor", "project-execution-materializer"), "loop-execution-materializer");
  assert.equal(rewriteLegacyLoopValue("note", "project-planner"), "project-planner");
});

test("Loop lifecycle preserves primary-execution reconciliation behavior", () => {
  assert.equal(getLoopStatusForPrimaryExecution("queued", "ready"), "in_progress");
  assert.equal(getLoopStatusForPrimaryExecution("approved", "in_progress"), "in_progress");
  assert.equal(getLoopStatusForPrimaryExecution("in_progress", "done"), "in_review");
  assert.equal(getLoopStatusForPrimaryExecution("in_review", "done"), null);
  assert.equal(getLoopStatusForPrimaryExecution("completed", "done"), null);
  assert.equal(getLoopStatusForPrimaryExecution("in_progress", "failed"), null);
  assert.equal(getLoopStatusForPrimaryExecution("queued", null), null);
});
