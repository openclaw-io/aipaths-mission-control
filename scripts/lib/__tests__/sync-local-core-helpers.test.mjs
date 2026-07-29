import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_DATABASE_NAME,
  REPLACE_CONFIRMATION,
  decideSyncMode,
  findSchemaImportErrors,
  findSemanticImportErrors,
  parseLocalDatabaseUrl,
  parseSyncArguments,
  prepareWorkItemRows,
  redactSecrets,
  sanitizeRows,
  validateReferenceIntegrity,
} from "../../../ops/local-postgres/sync-local-core-helpers.mjs";

const localUrl = `postgres://mission:secret@127.0.0.1:5433/${LOCAL_DATABASE_NAME}`;

test("sync target parser accepts only the exact local database on an exact loopback host", () => {
  const parsed = parseLocalDatabaseUrl(localUrl);
  assert.deepEqual(
    {
      hostname: parsed.hostname,
      port: parsed.port,
      databaseName: parsed.databaseName,
      safeDescription: parsed.safeDescription,
    },
    {
      hostname: "127.0.0.1",
      port: "5433",
      databaseName: LOCAL_DATABASE_NAME,
      safeDescription: `127.0.0.1:5433/${LOCAL_DATABASE_NAME}`,
    },
  );

  for (const invalid of [
    `postgres://localhost/${LOCAL_DATABASE_NAME}`,
    `postgres://127.0.0.2/${LOCAL_DATABASE_NAME}`,
    "postgres://127.0.0.1/other_database",
    `https://127.0.0.1/${LOCAL_DATABASE_NAME}`,
    `${localUrl}?sslmode=require`,
  ]) {
    assert.throws(() => parseLocalDatabaseUrl(invalid), /MISSION_CONTROL_DATABASE_URL/);
  }
});

test("replacement mode requires explicit confirmation and an absolute backup directory", () => {
  assert.deepEqual(parseSyncArguments([], { homeDirectory: "/tmp/home" }), {
    replaceLocalData: false,
    backupDir: "/tmp/home/Library/Application Support/AIPaths Mission Control/backups",
  });
  assert.deepEqual(
    parseSyncArguments([REPLACE_CONFIRMATION, "--backup-dir=/tmp/backups"]),
    { replaceLocalData: true, backupDir: "/tmp/backups" },
  );
  assert.equal(decideSyncMode([], false), "bootstrap");
  assert.equal(decideSyncMode([{ tableName: "loops", rowCount: 1 }], true), "replace");
  assert.throws(
    () => decideSyncMode([{ tableName: "loops", rowCount: 1 }], false),
    /Refusing to touch a non-empty local database/,
  );
  assert.throws(() => parseSyncArguments(["--backup-dir=relative"]), /exact confirmation|absolute|only valid/);
});

test("sync preflight is lossless, schema-drift loud, and Loop-FK safe", () => {
  const rowsByTable = new Map([
    ["loops", [{ id: "loop-1", name: "One" }]],
    ["work_items", [{ id: "work-1", loop_id: "missing-loop", title: "Task" }]],
    [
      "memories",
      [
        { id: "one", agent: "systems", type: "journal", date: "2026-07-26" },
        { id: "two", agent: "systems", type: "journal", date: "2026-07-26" },
      ],
    ],
  ]);
  const columnsByTable = new Map([
    ["loops", [{ column_name: "id", is_nullable: "NO", column_default: null, is_identity: "NO" }]],
    ["work_items", [{ column_name: "id", is_nullable: "NO", column_default: null, is_identity: "NO" }]],
  ]);

  assert.deepEqual(sanitizeRows("memories", rowsByTable.get("memories")), rowsByTable.get("memories"));
  assert.match(findSchemaImportErrors(rowsByTable, columnsByTable, ["loops", "work_items"]).join("\n"), /name exists in cloud|loop_id exists in cloud/);
  assert.match(findSemanticImportErrors(rowsByTable).join("\n"), /duplicate journal key/);
  assert.match(
    validateReferenceIntegrity(rowsByTable, [["work_items", "loop_id", "loops", "id"]]).join("\n"),
    /missing-loop has no imported loops.id/,
  );
});

test("sync semantic preflight rejects malformed V2 state and graph relationships", () => {
  const rowsByTable = new Map([
    ["loops", [
      { id: "loop-1", workflow_version: 1, mode: "dag", current_plan_revision_id: null },
      { id: "loop-2", workflow_version: 2, mode: "dag", current_plan_revision_id: "rev-foreign" },
    ]],
    ["loop_plan_revisions", [
      { id: "rev-1", loop_id: "loop-1" },
      { id: "rev-foreign", loop_id: "loop-1" },
      { id: "rev-2", loop_id: "loop-2" },
    ]],
    ["loop_stages", [
      { id: "stage-1", plan_revision_id: "rev-1" },
      { id: "stage-2", plan_revision_id: "rev-2" },
    ]],
    ["loop_tasks", [
      { id: "task-1", stage_id: "stage-1" },
      { id: "task-2", stage_id: "stage-2" },
    ]],
    ["loop_task_dependencies", [
      { task_id: "task-1", depends_on_task_id: "task-2" },
      { task_id: "task-2", depends_on_task_id: "task-1" },
    ]],
    ["loop_task_runs", [{ id: "run-2", task_id: "task-2" }]],
    ["loop_task_reviews", [{ id: "review-1", task_id: "task-1", task_run_id: "run-2" }]],
    ["loop_evidence", [{ id: "evidence-1", task_id: "task-1", task_run_id: "run-2" }]],
  ]);

  const errors = findSemanticImportErrors(rowsByTable).join("\n");
  assert.match(errors, /loop-1.*V1.*linear/i);
  assert.match(errors, /loop-2.*current plan revision.*same Loop/i);
  assert.match(errors, /dependency.*same plan revision/i);
  assert.match(errors, /dependency graph.*cycle/i);
  assert.match(errors, /review-1.*run-2.*same task/i);
  assert.match(errors, /evidence-1.*run-2.*same task/i);
});

test("work-item self references are split into insert and restore phases", () => {
  const rows = [
    { id: "parent", parent_id: null },
    { id: "child", parent_id: "parent" },
  ];
  const prepared = prepareWorkItemRows(rows);
  assert.deepEqual(prepared.rowsForInsert.map((row) => row.parent_id), [null, null]);
  assert.deepEqual(prepared.parentLinks, [{ id: "child", parentId: "parent" }]);
});

test("sync errors redact database credentials and service secrets", () => {
  const output = redactSecrets(new Error(`connection failed for ${localUrl}; key=service-secret`), [localUrl, "service-secret"]);
  assert.equal(output.includes("secret"), false);
  assert.equal(output.includes("service-secret"), false);
});
