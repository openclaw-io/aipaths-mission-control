import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function transpileModule(path, mocks, globals = {}) {
  const source = readFileSync(path, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier in mocks) return mocks[specifier];
      throw new Error(`Unexpected import ${specifier} from ${path}`);
    },
    console,
    structuredClone,
    ...globals,
  }, { filename: path });
  return cjsModule.exports;
}

function loadProjection() {
  return transpileModule(resolve(repoRoot, "src/lib/loops/read-model-v2-shadow.ts"), {});
}

function loadReadModel({ query, local = true, primary = null, primaryByLoop = new Map(), supabaseAdmin = {} }) {
  return transpileModule(resolve(repoRoot, "src/lib/loops/read-model.ts"), {
    "@/lib/auth/local": { isLocalAuthDisabled: () => local },
    "@/lib/db/mission-control": { normalizeRows: (rows) => rows },
    "@/lib/db/postgres": {
      query,
      withTransaction: async (fn) => fn({ query }),
    },
    "@/lib/supabase/admin": { supabaseAdmin },
    "@/lib/loops/lifecycle": {
      getLoopStatusForPrimaryExecution: () => null,
      getPrimaryExecutionWorkItem: async () => primary,
      listPrimaryExecutionWorkItems: async () => primaryByLoop,
    },
    "@/lib/loops/lifecycle-local": {
      getPrimaryExecutionWorkItemLocal: async () => primary,
      listPrimaryExecutionWorkItemsLocal: async () => primaryByLoop,
    },
    "@/lib/loops/read-model-v2-shadow": loadProjection(),
  }, { Date, Map, Set });
}

const baseLoop = {
  id: "loop-v2",
  name: "V2 project",
  description: "Normalized project",
  summary: "Normalized project",
  status: "active",
  priority: "high",
  owner_agent: "builder",
  deferred_until: null,
  target_outcome: "Ship",
  acceptance_criteria: [],
  plan: [{ id: "legacy", title: "Wrong legacy progress", status: "done" }],
  clarification_questions: [],
  approval_scope: {},
  notes: null,
  metadata: {},
  updated_at: "2026-01-02T00:00:00Z",
  workflow_version: 2,
  mode: "dag",
  current_plan_revision_id: "rev-2",
};

function workflowRows({ malformedDependency = false } = {}) {
  return {
    revision: { id: "rev-2", loop_id: "loop-v2", revision_number: 2, status: "approved", summary: "Current", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    stages: [
      { id: "stage-design", plan_revision_id: "rev-2", key: "design", title: "Design", description: null, position: 0, status: "completed" },
      { id: "stage-build", plan_revision_id: "rev-2", key: "build", title: "Build", description: null, position: 1, status: "in_progress" },
    ],
    tasks: [
      { id: "task-design", stage_id: "stage-design", key: "design", title: "Design API", description: null, position: 0, status: "completed" },
      { id: "task-build", stage_id: "stage-build", key: "build", title: "Build UI", description: null, position: 0, status: "in_progress" },
    ],
    dependencies: [{ task_id: "task-build", depends_on_task_id: malformedDependency ? "task-outside" : "task-design", dependency_type: "hard" }],
    runs: [{ id: "run-1", task_id: "task-build", attempt_number: 1, status: "running", started_at: "2026-01-02T01:00:00Z", finished_at: null, error: null, output: {}, created_at: "2026-01-02T01:00:00Z" }],
    reviews: [{ id: "review-1", task_id: "task-build", task_run_id: "run-1", task_run_owned: true, status: "pending", reviewer: null, feedback: null, decided_at: null, created_at: "2026-01-02T01:01:00Z" }],
    evidence: [{ id: "evidence-1", task_id: "task-build", task_run_id: "run-1", task_run_owned: true, kind: "artifact", uri: "file://artifact", content: null, metadata: {}, created_at: "2026-01-02T01:02:00Z" }],
    runCounts: [{ task_id: "task-build", count: "1" }],
    reviewCounts: [{ task_id: "task-build", count: "1" }],
    evidenceCounts: [{ task_id: "task-build", count: "1" }],
  };
}

function detailQuery(rows, calls) {
  return async (sql, params = []) => {
    calls.push({ sql, params });
    if (/set transaction isolation level repeatable read/i.test(sql)) return { rows: [] };
    if (/from loops[\s\S]*where id = \$1/i.test(sql)) return { rows: [{ ...baseLoop, row_version: 7 }] };
    if (/from loop_plan_revisions/i.test(sql)) return { rows: [rows.revision] };
    if (/from loop_stages/i.test(sql) && !/join loop_stages/i.test(sql)) return { rows: rows.stages };
    if (/from loop_tasks/i.test(sql) && /join loop_stages/i.test(sql)) return { rows: rows.tasks };
    if (/from loop_task_dependencies/i.test(sql)) return { rows: rows.dependencies };
    if (/count\(\*\)/i.test(sql) && /from loop_task_runs/i.test(sql)) return { rows: rows.runCounts };
    if (/count\(\*\)/i.test(sql) && /from loop_task_reviews/i.test(sql)) return { rows: rows.reviewCounts };
    if (/count\(\*\)/i.test(sql) && /from loop_evidence/i.test(sql)) return { rows: rows.evidenceCounts };
    if (/from loop_task_runs/i.test(sql)) return { rows: rows.runs };
    if (/from loop_task_reviews/i.test(sql)) return { rows: rows.reviews };
    if (/from loop_evidence/i.test(sql)) return { rows: rows.evidence };
    if (/from loop_work_items/i.test(sql)) return { rows: [] };
    if (/from loop_events/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
}

test("getLoopDetail local builds a V2 workflow from revision-scoped read-only queries", async () => {
  const calls = [];
  const rows = workflowRows();
  const { getLoopDetail } = loadReadModel({ query: detailQuery(rows, calls) });

  const detail = await getLoopDetail("loop-v2");

  assert.equal(detail.workflowVersion, 2);
  assert.equal(detail.mode, "dag");
  assert.equal(detail.workflow.source, "v2_normalized");
  assert.deepEqual(Array.from(detail.workflow.stages, (stage) => stage.id), ["stage-design", "stage-build"]);
  assert.deepEqual(Array.from(detail.workflow.stages[1].tasks[0].dependencies), ["task-design"]);
  assert.equal(detail.workflow.stages[1].tasks[0].runCount, 1);
  assert.deepEqual(Array.from(detail.workflow.stages[1].tasks[0].runStatuses), ["running"]);
  assert.equal(detail.workflow.stages[1].tasks[0].reviewCount, 1);
  assert.deepEqual(Array.from(detail.workflow.stages[1].tasks[0].reviewStatuses), ["pending"]);
  assert.equal(detail.workflow.stages[1].tasks[0].evidenceCount, 1);

  const revisionCall = calls.find(({ sql }) => /from loop_plan_revisions/i.test(sql));
  assert.deepEqual(Array.from(revisionCall.params), ["rev-2", "loop-v2"]);
  const stageCall = calls.find(({ sql }) => /from loop_stages/i.test(sql) && !/join loop_stages/i.test(sql));
  assert.deepEqual(Array.from(stageCall.params), ["rev-2"]);
  const taskCall = calls.find(({ sql }) => /from loop_tasks/i.test(sql) && /join loop_stages/i.test(sql));
  assert.deepEqual(Array.from(taskCall.params), ["rev-2"]);
  for (const table of ["loop_task_dependencies", "loop_task_runs", "loop_task_reviews", "loop_evidence"]) {
    const call = calls.find(({ sql }) => new RegExp(`from ${table}`, "i").test(sql));
    assert.ok(call, `${table} must be loaded`);
    assert.deepEqual(Array.from(call.params[0]).sort(), ["task-build", "task-design"]);
  }
  assert.doesNotMatch(calls.map(({ sql }) => sql).join("\n"), /\b(?:insert|update|delete)\b/i);
  assert.match(calls[0].sql, /repeatable read/i);
  assert.match(calls.at(-1).sql, /row_version/i);
});

test("V2 detail DTO and SQL do not leak unused history payloads and history reads are bounded", async () => {
  const calls = [];
  const rows = workflowRows();
  rows.runs[0] = { ...rows.runs[0], error: "SECRET_ERROR", output: { secret: "SECRET_OUTPUT" } };
  rows.reviews[0] = { ...rows.reviews[0], feedback: "SECRET_FEEDBACK" };
  rows.evidence[0] = { ...rows.evidence[0], uri: "SECRET_URI", content: "SECRET_CONTENT", metadata: { secret: true } };
  const { getLoopDetail } = loadReadModel({ query: detailQuery(rows, calls) });

  const detail = await getLoopDetail("loop-v2");
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /SECRET_|"(?:output|error|feedback|content|uri|metadata)"/i);
  for (const table of ["loop_task_runs", "loop_task_reviews"]) {
    const sql = calls.find((call) => new RegExp(`from ${table}`, "i").test(call.sql))?.sql || "";
    assert.match(sql, /task_id\s*=\s*any\(\$1::uuid\[\]\)/i, `${table} quality history must be scoped to current tasks`);
    assert.doesNotMatch(sql, /limit\s+\$\d+/i, `${table} quality state must not depend on a global history limit`);
    assert.doesNotMatch(sql, /\b(?:output|error|feedback|content|uri|metadata|server_session_id|repository)\b/i);
  }
  const evidenceSql = calls.find((call) => /from loop_evidence/i.test(call.sql))?.sql || "";
  assert.match(evidenceSql, /limit\s+\$\d+/i);
  assert.doesNotMatch(evidenceSql, /\b(?:output|error|feedback|content|uri|metadata|server_session_id|repository)\b/i);
});

test("V2 bounded detail keeps old run references valid and exposes exact per-task counts", async () => {
  const calls = [];
  const rows = workflowRows();
  rows.runs = Array.from({ length: 100 }, (_, index) => ({
    id: `run-new-${index}`,
    task_id: "task-build",
    status: "completed",
  }));
  rows.evidence = [{
    id: "evidence-for-old-run",
    task_id: "task-build",
    task_run_id: "run-old-outside-window",
    task_run_owned: true,
    kind: "artifact",
  }];
  rows.runCounts = [{ task_id: "task-build", count: "101" }];
  rows.reviewCounts = [{ task_id: "task-build", count: "1" }];
  rows.evidenceCounts = [{ task_id: "task-build", count: "237" }];
  const { getLoopDetail } = loadReadModel({ query: detailQuery(rows, calls) });

  const detail = await getLoopDetail("loop-v2");
  const task = detail.workflow.stages[1].tasks[0];
  assert.equal(task.runCount, 101);
  assert.equal(task.runStatuses.length, 100, "detailed run history remains bounded");
  assert.equal(task.reviewCount, 1);
  assert.equal(task.evidenceCount, 237);
  assert.deepEqual(Array.from(task.evidenceKinds), ["artifact"]);

  const evidenceSql = calls.find(({ sql }) => /from loop_evidence/i.test(sql) && !/count\(\*\)/i.test(sql)).sql;
  assert.match(evidenceSql, /join\s+loop_task_runs/i, "evidence ownership must be checked in SQL");
  for (const table of ["loop_task_runs", "loop_task_reviews", "loop_evidence"]) {
    const countSql = calls.find(({ sql }) => /count\(\*\)/i.test(sql) && new RegExp(`from ${table}`, "i").test(sql))?.sql || "";
    assert.match(countSql, /group\s+by\s+task_id/i, `${table} needs exact grouped counts`);
  }
});

test("V2 bounded detail fails closed when DB ownership validation rejects a run reference", async () => {
  const calls = [];
  const rows = workflowRows();
  rows.evidence = [{
    id: "cross-task-evidence",
    task_id: "task-build",
    task_run_id: "run-from-another-task",
    task_run_owned: false,
    kind: "artifact",
  }];
  const { getLoopDetail } = loadReadModel({ query: detailQuery(rows, calls) });

  await assert.rejects(() => getLoopDetail("loop-v2"), /task run does not belong to task/i);
});

test("V2 detail rejects a snapshot whose row version or current revision changes at final validation", async () => {
  const calls = [];
  const rows = workflowRows();
  let loopReads = 0;
  const baseQuery = detailQuery(rows, calls);
  const query = async (sql, params = []) => {
    if (/from loops[\s\S]*where id = \$1/i.test(sql)) {
      loopReads += 1;
      calls.push({ sql, params });
      return { rows: [{ ...baseLoop, row_version: loopReads === 1 ? 7 : 8 }] };
    }
    return baseQuery(sql, params);
  };
  const { getLoopDetail } = loadReadModel({ query });
  await assert.rejects(() => getLoopDetail("loop-v2"), /snapshot.*changed|inconsistent/i);
});

test("cloud V2 detail fails closed explicitly instead of returning a legacy plan", async () => {
  const loopBuilder = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: { ...baseLoop, row_version: 7 }, error: null }; },
  };
  const supabaseAdmin = { from(table) {
    assert.equal(table, "loops", "cloud V2 must fail before querying detail adjunct tables");
    return loopBuilder;
  } };
  const { getLoopDetail } = loadReadModel({
    query: async () => { throw new Error("local query must not run"); },
    local: false,
    supabaseAdmin,
  });
  await assert.rejects(() => getLoopDetail("loop-v2"), /V2.*cloud.*unavailable|fail.*closed/i);
});

test("getLoopDetail fails closed when the bounded V2 snapshot contains an external dependency", async () => {
  const calls = [];
  const rows = workflowRows({ malformedDependency: true });
  const { getLoopDetail } = loadReadModel({ query: detailQuery(rows, calls) });
  await assert.rejects(() => getLoopDetail("loop-v2"), /outside.*current plan revision|inconsistent/i);
});

test("gallery uses normalized V2 tasks for progress and preserves legacy V1 plan progress", async () => {
  const loops = [
    baseLoop,
    { ...baseLoop, id: "loop-v1", name: "V1", workflow_version: 1, mode: "linear", current_plan_revision_id: null, plan: [{ id: "a", title: "A", status: "done" }, { id: "b", title: "B", status: "pending" }] },
  ];
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/from loops[\s\S]*order by updated_at desc/i.test(sql)) return { rows: loops };
    if (/from loop_work_items/i.test(sql)) return { rows: [] };
    if (/loop_tasks/i.test(sql) && /loop_id/i.test(sql)) return { rows: [
      { loop_id: "loop-v2", revision_id: "rev-2", status: "completed" },
      { loop_id: "loop-v2", revision_id: "rev-2", status: "in_progress" },
      { loop_id: "loop-v2", revision_id: "rev-2", status: "pending" },
    ] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const { listLoopGalleryCards } = loadReadModel({ query });

  const cards = await listLoopGalleryCards();
  const v2 = cards.find((card) => card.id === "loop-v2");
  const v1 = cards.find((card) => card.id === "loop-v1");
  assert.equal(v2.progressLabel, "1/3 tasks");
  assert.equal(v2.progressPercent, 33);
  assert.equal(v1.progressLabel, "1/2 steps");
  assert.equal(v1.progressPercent, 50);
  const progressCall = calls.find(({ sql }) => /from loop_plan_revisions/i.test(sql) && /loop_tasks/i.test(sql));
  assert.deepEqual(Array.from(progressCall.params[0]), ["rev-2"]);
  assert.doesNotMatch(progressCall.sql, /selected_loop\.current_plan_revision_id/i);
});

test("gallery V2 progress handles zero tasks and counts skipped/cancelled as terminal from captured revisions", async () => {
  const loops = [
    baseLoop,
    { ...baseLoop, id: "loop-zero", name: "Zero", current_plan_revision_id: "rev-zero" },
  ];
  const query = async (sql) => {
    if (/from loops[\s\S]*order by updated_at desc/i.test(sql)) return { rows: loops };
    if (/from loop_work_items/i.test(sql)) return { rows: [] };
    if (/from loop_plan_revisions/i.test(sql)) return { rows: [
      { loop_id: "loop-v2", revision_id: "rev-2", status: "skipped" },
      { loop_id: "loop-v2", revision_id: "rev-2", status: "cancelled" },
    ] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const { listLoopGalleryCards } = loadReadModel({ query });
  const cards = await listLoopGalleryCards();
  assert.equal(cards.find((card) => card.id === "loop-v2").progressLabel, "2/2 tasks");
  assert.equal(cards.find((card) => card.id === "loop-v2").progressPercent, 100);
  assert.equal(cards.find((card) => card.id === "loop-zero").progressLabel, "0/0 tasks");
  assert.equal(cards.find((card) => card.id === "loop-zero").progressPercent, 0);
});

test("/loops initial render has constant reads and only loads one query-param-selected detail", async () => {
  const pageSource = readFileSync(resolve(repoRoot, "src/app/loops/page.tsx"), "utf8");
  assert.doesNotMatch(pageSource, /loops\.map\([\s\S]*getLoopDetail/i);
  assert.match(pageSource, /searchParams/i);
  assert.match(pageSource, /selectedLoopId[\s\S]*getLoopDetail\(selectedLoopId\)/i);

  let galleryReads = 0;
  let detailReads = 0;
  const pageModule = transpileModule(resolve(repoRoot, "src/app/loops/page.tsx"), {
    "react/jsx-runtime": awaitableJsxRuntime,
    "@/components/loops/LoopsClient": { LoopsClient: () => null },
    "@/lib/loops/read-model": {
      listLoopGalleryCards: async () => {
        galleryReads += 1;
        return Array.from({ length: 500 }, (_, index) => ({ id: `loop-${index}` }));
      },
      getLoopDetail: async (id) => {
        detailReads += 1;
        return { id };
      },
    },
  });

  await pageModule.default({ searchParams: Promise.resolve({}) });
  assert.equal(galleryReads, 1);
  assert.equal(detailReads, 0, "initial detail query count must stay zero regardless of gallery size");
  await pageModule.default({ searchParams: Promise.resolve({ loop: "loop-499" }) });
  assert.equal(galleryReads, 2);
  assert.equal(detailReads, 1, "selected navigation may load exactly one detail");
});

function baseDetail(overrides = {}) {
  return {
    id: "loop-v1",
    title: "Loop",
    summary: "Summary",
    status: "needs_approval",
    priority: "medium",
    ownerAgent: null,
    targetOutcome: null,
    acceptanceCriteria: [],
    plan: [{ id: "legacy", title: "Legacy step", status: "pending" }],
    clarificationQuestions: [],
    approvalScope: {},
    notes: null,
    metadata: {},
    clarificationHistory: [],
    deliverable: null,
    needsMyAttention: true,
    readyToRun: false,
    nextActionLabel: null,
    blockedReason: null,
    deferredUntil: null,
    linkedWorkItems: [],
    recentEvents: [],
    workflowVersion: 1,
    mode: "linear",
    ...overrides,
  };
}

function loadLoopDetail() {
  const placeholder = (label) => {
    function Placeholder() {
      return React.createElement("span", null, label);
    }
    Placeholder.displayName = `Placeholder(${label})`;
    return Placeholder;
  };
  return transpileModule(resolve(repoRoot, "src/components/loops/LoopDetail.tsx"), {
    "react/jsx-runtime": awaitableJsxRuntime,
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "./ApprovalDecisionBox": { ApprovalDecisionBox: placeholder("APPROVAL_ACTION") },
    "./SubmitClarificationBox": { SubmitClarificationBox: placeholder("CLARIFICATION_ACTION") },
    "./LoopReviewActions": { LoopReviewActions: placeholder("REVIEW_ACTION") },
    "./QueuedExecutionHint": { QueuedExecutionHint: placeholder("QUEUED_HINT") },
  }, { React });
}

const awaitableJsxRuntime = await import("react/jsx-runtime");

test("LoopDetail renders the V2 Proyecto hierarchy read-only while V1 keeps its legacy panel/actions", () => {
  const { LoopDetail } = loadLoopDetail();
  const rows = workflowRows();
  const workflow = loadProjection().projectLoopWorkflowShadow({
    loop: { id: "loop-v2", workflow_version: 2, mode: "dag", current_plan_revision_id: "rev-2", plan: [] },
    planRevisions: [rows.revision],
    stages: rows.stages,
    tasks: rows.tasks,
    dependencies: rows.dependencies,
    runs: rows.runs,
    reviews: rows.reviews,
    evidence: rows.evidence,
    runCounts: rows.runCounts,
    reviewCounts: rows.reviewCounts,
    evidenceCounts: rows.evidenceCounts,
  });

  const v2Html = renderToStaticMarkup(React.createElement(LoopDetail, {
    loop: baseDetail({ id: "loop-v2", status: "in_progress", workflowVersion: 2, mode: "dag", workflow }),
    onClose() {},
  }));
  assert.match(v2Html, />Proyecto</);
  assert.match(v2Html, /Design API/);
  assert.match(v2Html, /Build UI/);
  assert.match(v2Html, /Depende de:[\s\S]*Design API/);
  assert.match(v2Html, /1 intento/);
  assert.match(v2Html, /1 evidencia/);
  assert.doesNotMatch(v2Html, /Compact Plan|APPROVAL_ACTION|CLARIFICATION_ACTION|REVIEW_ACTION/);

  const v1Html = renderToStaticMarkup(React.createElement(LoopDetail, {
    loop: baseDetail(),
    onClose() {},
  }));
  assert.match(v1Html, /Compact Plan/);
  assert.match(v1Html, /Legacy step/);
  assert.match(v1Html, /APPROVAL_ACTION/);
  assert.doesNotMatch(v1Html, />Proyecto</);
});

test("LoopCard shows the real-task label only for V2 cards", () => {
  const { LoopCard } = transpileModule(resolve(repoRoot, "src/components/loops/LoopCard.tsx"), {
    "react/jsx-runtime": awaitableJsxRuntime,
    "./QueuedExecutionHint": {
      QueuedExecutionHint: function QueuedExecutionHint() {
        return React.createElement("span", null, "QUEUED_HINT");
      },
    },
  }, { React });
  const card = {
    id: "loop-v2",
    title: "V2",
    summary: "Summary",
    status: "active",
    priority: "medium",
    progressLabel: "1/3 tasks",
    progressPercent: 33,
    needsMyAttention: false,
    readyToRun: false,
    blocked: false,
    queued: false,
    running: true,
    dispatchState: null,
    nextActionLabel: null,
    ownerAgent: null,
    deferredUntil: null,
    updatedAt: "2026-01-01T00:00:00Z",
    linkedWorkItemsCount: 0,
  };
  const v2Html = renderToStaticMarkup(React.createElement(LoopCard, { loop: card, onOpen() {} }));
  assert.match(v2Html, /1\/3 tasks/);

  const v1Html = renderToStaticMarkup(React.createElement(LoopCard, {
    loop: { ...card, id: "loop-v1", progressLabel: "1/2 steps", progressPercent: 50 },
    onOpen() {},
  }));
  assert.doesNotMatch(v1Html, /1\/2 steps/);
});

test("V2 UI/read model source remains read-only and local-only", () => {
  const readModel = readFileSync(resolve(repoRoot, "src/lib/loops/read-model.ts"), "utf8");
  const detail = readFileSync(resolve(repoRoot, "src/components/loops/LoopDetail.tsx"), "utf8");
  assert.match(readModel, /isLocalAuthDisabled\(\)[\s\S]*buildLoopWorkflowShadow/);
  assert.doesNotMatch(`${readModel}\n${detail}`, /\.(?:insert|update|delete)\s*\(/i);
  assert.doesNotMatch(detail, /fetch\s*\(|router\.push|router\.replace/);
});
