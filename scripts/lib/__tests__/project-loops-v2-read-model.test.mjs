import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/loops/read-model-v2-shadow.ts");

function loadShadowReadModel() {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      throw new Error(`Pure shadow read model must not import ${specifier}`);
    },
    structuredClone,
  }, { filename: sourcePath });
  return cjsModule.exports;
}

test("V1 is projected as one synthetic stage with stable synthetic tasks and partial history", () => {
  const { projectLoopWorkflowShadow } = loadShadowReadModel();
  const input = {
    loop: {
      id: "loop-v1",
      workflow_version: 1,
      mode: "linear",
      current_plan_revision_id: null,
      plan: [
        { id: "discover", title: "Discover", status: "done", notes: "kept" },
        { title: "Ship", status: "pending" },
      ],
    },
    planRevisions: [],
    stages: [],
    tasks: [],
    dependencies: [],
    runs: [],
    reviews: [],
    evidence: [],
  };
  const before = structuredClone(input);

  const projected = projectLoopWorkflowShadow(input);

  assert.equal(projected.source, "v1_synthetic");
  assert.equal(projected.workflowVersion, 1);
  assert.equal(projected.mode, "linear");
  assert.equal(projected.historyCompleteness, "partial");
  assert.equal(projected.planRevision, null);
  assert.deepEqual(JSON.parse(JSON.stringify(projected.stages)), [{
    id: "synthetic:loop-v1:stage",
    key: "legacy-plan",
    title: "Legacy plan",
    description: null,
    position: 0,
    status: "in_progress",
    synthetic: true,
    tasks: [
      {
        id: "synthetic:loop-v1:task:discover",
        key: "discover",
        title: "Discover",
        description: "kept",
        position: 0,
        status: "completed",
        synthetic: true,
        dependencies: [],
        runCount: 0,
        runStatuses: [],
        reviewCount: 0,
        reviewStatuses: [],
        evidenceCount: 0,
        evidenceKinds: [],
      },
      {
        id: "synthetic:loop-v1:task:1",
        key: "1",
        title: "Ship",
        description: null,
        position: 1,
        status: "pending",
        synthetic: true,
        dependencies: ["synthetic:loop-v1:task:discover"],
        runCount: 0,
        runStatuses: [],
        reviewCount: 0,
        reviewStatuses: [],
        evidenceCount: 0,
        evidenceKinds: [],
      },
    ],
  }]);
  assert.deepEqual(input, before, "projection must not mutate its inputs");
});

test("V2 renders only the current real revision and attaches normalized history without writes", () => {
  const { projectLoopWorkflowShadow } = loadShadowReadModel();
  const input = {
    loop: {
      id: "loop-v2",
      workflow_version: 2,
      mode: "dag",
      current_plan_revision_id: "rev-2",
      plan: [{ id: "legacy", title: "must be ignored" }],
    },
    planRevisions: [
      { id: "rev-1", loop_id: "loop-v2", revision_number: 1, status: "superseded", summary: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: "rev-2", loop_id: "loop-v2", revision_number: 2, status: "approved", summary: "Current", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ],
    stages: [
      { id: "stage-old", plan_revision_id: "rev-1", key: "old", title: "Old", description: null, position: 0, status: "completed" },
      { id: "stage-2", plan_revision_id: "rev-2", key: "build", title: "Build", description: "Real", position: 1, status: "in_progress" },
      { id: "stage-1", plan_revision_id: "rev-2", key: "design", title: "Design", description: null, position: 0, status: "completed" },
    ],
    tasks: [
      { id: "task-build", stage_id: "stage-2", key: "build", title: "Build", description: null, position: 0, status: "in_progress" },
      { id: "task-design", stage_id: "stage-1", key: "design", title: "Design", description: null, position: 0, status: "completed" },
      { id: "task-old", stage_id: "stage-old", key: "old", title: "Old", description: null, position: 0, status: "completed" },
    ],
    dependencies: [{ task_id: "task-build", depends_on_task_id: "task-design", dependency_type: "hard" }],
    runs: [{ id: "run-1", task_id: "task-build", attempt_number: 1, status: "running", started_at: "2026-01-02T01:00:00Z", finished_at: null, error: null, output: {} }],
    reviews: [{ id: "review-1", task_id: "task-build", task_run_id: "run-1", status: "pending", reviewer: null, feedback: null, decided_at: null, created_at: "2026-01-02T01:01:00Z" }],
    evidence: [{ id: "evidence-1", task_id: "task-build", task_run_id: "run-1", kind: "artifact", uri: "file://artifact", content: null, metadata: {}, created_at: "2026-01-02T01:02:00Z" }],
  };

  const projected = projectLoopWorkflowShadow(input);

  assert.equal(projected.source, "v2_normalized");
  assert.equal(projected.workflowVersion, 2);
  assert.equal(projected.historyCompleteness, "bounded");
  assert.equal(projected.planRevision.id, "rev-2");
  assert.equal(projected.planRevision.revisionNumber, 2);
  assert.deepEqual(Array.from(projected.stages, (stage) => stage.id), ["stage-1", "stage-2"]);
  assert.deepEqual(Array.from(projected.stages[1].tasks[0].dependencies), ["task-design"]);
  assert.equal(projected.stages[1].tasks[0].runCount, 1);
  assert.deepEqual(Array.from(projected.stages[1].tasks[0].runStatuses), ["running"]);
  assert.equal(projected.stages[1].tasks[0].reviewCount, 1);
  assert.deepEqual(Array.from(projected.stages[1].tasks[0].reviewStatuses), ["pending"]);
  assert.equal(projected.stages[1].tasks[0].evidenceCount, 1);
  assert.deepEqual(Array.from(projected.stages[1].tasks[0].evidenceKinds), ["artifact"]);
  assert.equal(projected.stages.some((stage) => stage.id === "stage-old"), false);
});

test("shadow read model rejects inconsistent workflow version, mode, and current revision state", () => {
  const { projectLoopWorkflowShadow } = loadShadowReadModel();
  assert.throws(() => projectLoopWorkflowShadow({
    loop: { id: "loop-v2", workflow_version: 2, mode: "linear", current_plan_revision_id: null, plan: [] },
    planRevisions: [], stages: [], tasks: [], dependencies: [], runs: [], reviews: [], evidence: [],
  }), /current plan revision/i);

  assert.throws(() => projectLoopWorkflowShadow({
    loop: { id: "loop-v1", workflow_version: 1, mode: "dag", current_plan_revision_id: null, plan: [] },
    planRevisions: [], stages: [], tasks: [], dependencies: [], runs: [], reviews: [], evidence: [],
  }), /V1.*linear/i);

  assert.throws(() => projectLoopWorkflowShadow({
    loop: { id: "loop-v1", workflow_version: 1, mode: "linear", current_plan_revision_id: "rev-1", plan: [] },
    planRevisions: [], stages: [], tasks: [], dependencies: [], runs: [], reviews: [], evidence: [],
  }), /V1.*current plan revision/i);

  assert.throws(() => projectLoopWorkflowShadow({
    loop: { id: "loop-v2", workflow_version: 2, mode: "invalid", current_plan_revision_id: "rev-1", plan: [] },
    planRevisions: [{ id: "rev-1", loop_id: "loop-v2", revision_number: 1, status: "approved", summary: null, created_at: "x", updated_at: "x" }],
    stages: [], tasks: [], dependencies: [], runs: [], reviews: [], evidence: [],
  }), /mode/i);
});

test("shadow read model rejects cross-revision dependencies rather than hiding them", () => {
  const { projectLoopWorkflowShadow } = loadShadowReadModel();
  const malformed = {
    loop: { id: "loop-v2", workflow_version: 2, mode: "dag", current_plan_revision_id: "rev-1", plan: [] },
    planRevisions: [{ id: "rev-1", loop_id: "loop-v2", revision_number: 1, status: "approved", summary: null, created_at: "x", updated_at: "x" }],
    stages: [
      { id: "stage-current", plan_revision_id: "rev-1", key: "current", title: "Current", description: null, position: 0, status: "pending" },
      { id: "stage-other", plan_revision_id: "rev-2", key: "other", title: "Other", description: null, position: 0, status: "pending" },
    ],
    tasks: [
      { id: "task-current", stage_id: "stage-current", key: "current", title: "Current", description: null, position: 0, status: "pending" },
      { id: "task-other", stage_id: "stage-other", key: "other", title: "Other", description: null, position: 0, status: "pending" },
    ],
    dependencies: [{ task_id: "task-current", depends_on_task_id: "task-other", dependency_type: "hard" }],
    runs: [], reviews: [], evidence: [],
  };
  assert.throws(() => projectLoopWorkflowShadow(malformed), /dependency.*outside.*current plan revision/i);
  assert.throws(() => projectLoopWorkflowShadow({
    ...malformed,
    dependencies: [{ task_id: "task-other", depends_on_task_id: "task-current", dependency_type: "hard" }],
  }), /dependency.*outside.*current plan revision/i, "either cross-revision edge direction must fail closed");

  assert.throws(() => projectLoopWorkflowShadow({
    ...malformed,
    dependencies: [
      { task_id: "task-current", depends_on_task_id: "task-second", dependency_type: "hard" },
      { task_id: "task-second", depends_on_task_id: "task-current", dependency_type: "hard" },
    ],
    tasks: [
      malformed.tasks[0],
      { id: "task-second", stage_id: "stage-current", key: "second", title: "Second", description: null, position: 1, status: "pending" },
    ],
  }), /dependency graph.*cycle/i, "a malformed current-revision cycle must fail closed");
});

test("shadow projection remains pure while the live read model may consume it", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /@\/lib\/db|supabase|\bfetch\s*\(|\.(?:insert|update|delete)\s*\(/i);
  assert.doesNotMatch(source, /"use client"/);
});
