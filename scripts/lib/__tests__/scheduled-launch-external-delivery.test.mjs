import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";

const { Pool } = pg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/work-items/external-delivery.ts");
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

function loadModule() {
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, { module: cjs, exports: cjs.exports, require(specifier) { throw new Error(`Unexpected import ${specifier}`); }, Date, Number, String, Object, Array, JSON, RegExp, Set, Math }, { filename: sourcePath });
  return cjs.exports;
}

const delivery = loadModule();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 4 }) : null;

test.after(async () => { await pool?.end(); });

async function transaction(run) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const scope = { launch_generation: "generation-1", action: "publish_community_post", destination: "channel-1" };

test("same external delivery key has one atomic claimant and concurrent replay fails closed", { skip: !pool }, async () => {
  const firstWork = (await pool.query("insert into work_items(title,status) values ('delivery one','ready') returning id")).rows[0].id;
  const secondWork = (await pool.query("insert into work_items(title,status) values ('delivery two','ready') returning id")).rows[0].id;
  const key = `ytlaunch:Concurrent1:${Date.now()}`;
  try {
    const claims = await Promise.all([
      transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId: firstWork, scope, now: "2026-08-04T12:00:00.000Z" })),
      transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId: secondWork, scope, now: "2026-08-04T12:00:00.000Z" })),
    ]);
    assert.deepEqual(claims.map((claim) => claim.kind).sort(), ["acquired", "pending_fail_closed"]);
    assert.equal(new Set(claims.map((claim) => claim.claimToken)).size, 1);
    assert.equal((await pool.query("select count(*)::int count from external_delivery_attempts where idempotency_key=$1", [key])).rows[0].count, 1);
  } finally {
    await pool.query("delete from external_delivery_attempts where idempotency_key=$1", [key]);
    await pool.query("delete from work_items where id=any($1::uuid[])", [[firstWork, secondWork]]);
  }
});

test("provider-accepted delivery replays as accepted and can never be claimed again", { skip: !pool }, async () => {
  const workItemId = (await pool.query("insert into work_items(title,status) values ('delivery accepted','ready') returning id")).rows[0].id;
  const key = `ytlaunch:Accepted001:${Date.now()}`;
  try {
    const claim = await transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId, scope, now: "2026-08-04T12:00:00.000Z" }));
    assert.equal(claim.kind, "acquired");
    await assert.rejects(
      () => transaction((client) => delivery.markExternalDeliveryAccepted(client, {
        key,
        claimToken: claim.claimToken,
        workItemId,
        acceptedAt: "2026-08-04T12:00:05.000Z",
        providerDeliveryId: "   ",
        result: { status: "accepted" },
      })),
      /external_delivery_provider_id_required/,
    );
    const accepted = await transaction((client) => delivery.markExternalDeliveryAccepted(client, {
      key,
      claimToken: claim.claimToken,
      workItemId,
      acceptedAt: "2026-08-04T12:00:10.000Z",
      providerDeliveryId: "provider-123",
      result: { status: "accepted" },
    }));
    assert.equal(accepted.status, "accepted");

    const replay = await transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId, scope, now: "2026-08-04T12:01:00.000Z" }));
    assert.equal(replay.kind, "accepted_replay");
    assert.equal(replay.providerDeliveryId, "provider-123");
    const fkDefinition = (await pool.query(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conname='external_delivery_attempts_work_item_id_fkey'",
    )).rows[0]?.definition || "";
    assert.match(fkDefinition, /ON DELETE RESTRICT/i);
    const durableRows = await pool.query(
      "select w.id as work_id,d.work_item_id,d.status from public.external_delivery_attempts d left join public.work_items w on w.id=d.work_item_id where d.idempotency_key=$1",
      [key],
    );
    assert.equal(durableRows.rowCount, 1);
    assert.equal(durableRows.rows[0].work_id, workItemId);
    assert.equal(durableRows.rows[0].work_item_id, workItemId);
    assert.equal(durableRows.rows[0].status, "accepted");
    try {
      const deletion = await pool.query("delete from public.work_items where id=$1 returning id", [workItemId]);
      assert.equal(deletion.rowCount, 0);
    } catch (error) {
      assert.match(String(error), /foreign key constraint/i);
    }
    const preserved = await pool.query(
      "select exists(select 1 from public.work_items where id=$1) as work_exists, exists(select 1 from public.external_delivery_attempts where idempotency_key=$2 and status='accepted') as delivery_exists",
      [workItemId, key],
    );
    assert.equal(preserved.rows[0].work_exists, true);
    assert.equal(preserved.rows[0].delivery_exists, true);
  } finally {
    await pool.query("delete from external_delivery_attempts where idempotency_key=$1", [key]);
    await pool.query("delete from work_items where id=$1", [workItemId]);
  }
});

test("only a proven pre-delivery failure releases the same durable key for a retry", { skip: !pool }, async () => {
  const workItemId = (await pool.query("insert into work_items(title,status) values ('delivery retry','ready') returning id")).rows[0].id;
  const key = `ytlaunch:Retry00001:${Date.now()}`;
  try {
    const first = await transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId, scope, now: "2026-08-04T12:00:00.000Z" }));
    await transaction((client) => delivery.markExternalDeliveryPreDeliveryFailure(client, {
      key, claimToken: first.claimToken, workItemId, failedAt: "2026-08-04T12:00:01.000Z", error: "runtime unavailable",
    }));
    const second = await transaction((client) => delivery.claimExternalDelivery(client, { key, workItemId, scope, now: "2026-08-04T12:01:00.000Z" }));
    assert.equal(second.kind, "acquired");
    assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(second.claimAttempt, 2);
  } finally {
    await pool.query("delete from external_delivery_attempts where idempotency_key=$1", [key]);
    await pool.query("delete from work_items where id=$1", [workItemId]);
  }
});
