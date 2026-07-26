import test from "node:test";
import assert from "node:assert/strict";
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
  validateReferenceIntegrity,
} from "./sync-local-core-helpers.mjs";

test("semantic preflight rejects duplicate journal keys without dropping rows", () => {
  const rowsByTable = new Map([
    [
      "memories",
      [
        { id: "one", agent: "systems", type: "journal", date: "2026-07-26" },
        { id: "two", agent: "systems", type: "journal", date: "2026-07-26" },
        { id: "three", agent: "systems", type: "strategic", date: "2026-07-26" },
      ],
    ],
  ]);

  assert.deepEqual(findSemanticImportErrors(rowsByTable), [
    "memories contains duplicate journal key systems|journal|2026-07-26; refusing to discard either row",
  ]);
});

test("local URL parser accepts only exact IPv4/IPv6 loopback and database name", () => {
  const ipv4 = parseLocalDatabaseUrl(
    `postgres://mission:secret@127.0.0.1:5433/${LOCAL_DATABASE_NAME}`,
  );
  assert.deepEqual(
    { hostname: ipv4.hostname, port: ipv4.port, databaseName: ipv4.databaseName, safe: ipv4.safeDescription },
    { hostname: "127.0.0.1", port: "5433", databaseName: LOCAL_DATABASE_NAME, safe: `127.0.0.1:5433/${LOCAL_DATABASE_NAME}` },
  );
  assert.equal(ipv4.safeDescription.includes("mission:"), false);
  assert.equal(ipv4.safeDescription.includes("secret"), false);

  const ipv6 = parseLocalDatabaseUrl(`postgresql://[::1]/${LOCAL_DATABASE_NAME}`);
  assert.equal(ipv6.hostname, "::1");
  assert.equal(ipv6.port, "5432");
});

test("local URL parser rejects substring tricks, alternate databases, and connection overrides", () => {
  const invalid = [
    `postgres://127.0.0.1.evil/${LOCAL_DATABASE_NAME}`,
    `postgres://127.0.0.1@evil.example/${LOCAL_DATABASE_NAME}`,
    `postgres://localhost/${LOCAL_DATABASE_NAME}`,
    `postgres://127.1/${LOCAL_DATABASE_NAME}`,
    `postgres://2130706433/${LOCAL_DATABASE_NAME}`,
    `postgres://127.0.0.1/${LOCAL_DATABASE_NAME}_copy`,
    `postgres://127.0.0.1/other_${LOCAL_DATABASE_NAME}`,
    `postgres://127.0.0.1/${LOCAL_DATABASE_NAME}?host=evil.example`,
    `https://127.0.0.1/${LOCAL_DATABASE_NAME}`,
  ];
  for (const value of invalid) assert.throws(() => parseLocalDatabaseUrl(value));
});

test("replacement requires the exact database-specific confirmation", () => {
  assert.deepEqual(parseSyncArguments([], { homeDirectory: "/tmp/home" }), {
    replaceLocalData: false,
    backupDir: "/tmp/home/Library/Application Support/AIPaths Mission Control/backups",
  });
  assert.equal(parseSyncArguments([REPLACE_CONFIRMATION]).replaceLocalData, true);
  assert.throws(() => parseSyncArguments(["--replace-local-data"]), /exact confirmation/);
  assert.throws(() => parseSyncArguments(["--backup-dir=/tmp/backups"]), /only valid/);
  assert.throws(
    () => parseSyncArguments([REPLACE_CONFIRMATION, "--backup-dir=relative"]),
    /absolute path/,
  );
});

test("non-empty databases fail closed unless replacement is explicitly confirmed", () => {
  assert.equal(decideSyncMode([], false), "bootstrap");
  assert.throws(
    () => decideSyncMode([{ tableName: "work_items", rowCount: 3 }], false),
    /Refusing to touch a non-empty local database/,
  );
  assert.equal(decideSyncMode([{ tableName: "work_items", rowCount: 3 }], true), "replace");
});

test("work item self references are inserted null and restored after all rows exist", () => {
  const prepared = prepareWorkItemRows([
    { id: "parent", parent_id: null, title: "Parent" },
    { id: "child", parent_id: "parent", title: "Child" },
  ]);
  assert.deepEqual(prepared.rowsForInsert.map((row) => row.parent_id), [null, null]);
  assert.deepEqual(prepared.parentLinks, [{ id: "child", parentId: "parent" }]);
});

test("reference preflight reports missing parent rows before mutation", () => {
  const rows = new Map([
    ["loops", [{ id: "loop-present" }]],
    ["work_items", [{ id: "work", loop_id: "loop-missing", parent_id: "parent-missing" }]],
  ]);
  const errors = validateReferenceIntegrity(rows, [
    ["work_items", "loop_id", "loops", "id"],
    ["work_items", "parent_id", "work_items", "id"],
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /no imported loops.id/);
  assert.match(errors[1], /no imported work_items.id/);
});

test("schema preflight refuses cloud columns that local Postgres would drop", () => {
  const rows = new Map([["loops", [{ id: "l1", cloud_only: "must-not-disappear" }]]]);
  const columns = new Map([["loops", [
    { column_name: "id", is_nullable: "NO", column_default: "gen_random_uuid()", is_identity: "NO" },
  ]] ]);
  assert.deepEqual(
    findSchemaImportErrors(rows, columns, ["loops"]),
    ["loops.cloud_only exists in cloud but not in the local schema"],
  );
});

test("error redaction never emits Postgres passwords or supplied secrets", () => {
  const url = `postgres://mission:very-secret@127.0.0.1/${LOCAL_DATABASE_NAME}`;
  const output = redactSecrets(new Error(`connection failed for ${url}; key=service-secret`), [url, "service-secret"]);
  assert.equal(output.includes("very-secret"), false);
  assert.equal(output.includes("service-secret"), false);
});
