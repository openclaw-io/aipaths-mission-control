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
