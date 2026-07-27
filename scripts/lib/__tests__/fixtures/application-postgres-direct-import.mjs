import assert from "node:assert/strict";

const expectedDatabase = process.env.EXPECTED_TEST_DATABASE;
if (!expectedDatabase) throw new Error("Missing EXPECTED_TEST_DATABASE");

// Import the real application DB module, not the script-level test helper. Its
// module initialization must select and validate the dedicated test URL before
// pg creates a pool or can consult inherited connection fallbacks.
const postgres = await import("../../../../src/lib/db/postgres.ts");
try {
  const selectedUrl = new URL(postgres.missionControlDatabaseUrl);
  assert.equal(decodeURIComponent(selectedUrl.pathname.slice(1)), expectedDatabase);
  const result = await postgres.query("select current_database() as database_name");
  assert.equal(result.rows[0]?.database_name, expectedDatabase);
  console.log(`[application-db-target] ${result.rows[0].database_name}`);
} finally {
  await postgres.getPostgresPool().end().catch(() => {});
}
