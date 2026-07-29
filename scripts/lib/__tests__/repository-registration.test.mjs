import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import {
  inspectRepositoryForRegistration,
  registerReviewRepository,
} from "../repository-registration.mjs";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 4 });
after(() => pool.end());

async function withTransaction(run) {
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

async function makeRepository() {
  const root = await mkdtemp("/Users/joaco/openclaw/.mc-register-repo-");
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Mission Control Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "mc-test@local"]);
  await writeFile(resolve(root, "README.md"), "registered\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

test("repository registration requires explicit enable and real safe Git identity", async () => {
  const root = await makeRepository();
  const key = `registration-${randomUUID()}`;
  try {
    const identity = await inspectRepositoryForRegistration(root);
    assert.equal(identity.canonicalRoot, root);
    assert.match(identity.gitCommonDir, /\.git$/);
    assert.equal(identity.objectFormat, "sha1");
    await assert.rejects(registerReviewRepository({ key, repositoryPath: root, enable: false, withTransaction }),
      /repository_enable_flag_required/);
    await assert.rejects(inspectRepositoryForRegistration("/tmp"), /repository_outside_allowed_root/);
    assert.equal((await pool.query("select count(*)::int n from review_repositories where key=$1", [key])).rows[0].n, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository registration inserts, idempotently returns exact identity, enables, and fails closed on collisions", async () => {
  const left = await makeRepository();
  const right = await makeRepository();
  const key = `registration-${randomUUID()}`;
  const otherKey = `registration-${randomUUID()}`;
  try {
    const inserted = await registerReviewRepository({ key, repositoryPath: left, enable: true, withTransaction });
    assert.equal(inserted.action, "inserted");
    assert.equal(inserted.repository.enabled, true);

    const existing = await registerReviewRepository({ key, repositoryPath: left, enable: true, withTransaction });
    assert.equal(existing.action, "existing");
    assert.equal(existing.repository.id, inserted.repository.id);

    await pool.query("update review_repositories set enabled=false where id=$1", [inserted.repository.id]);
    const enabled = await registerReviewRepository({ key, repositoryPath: left, enable: true, withTransaction });
    assert.equal(enabled.action, "enabled");
    assert.equal(enabled.repository.enabled, true);

    await assert.rejects(registerReviewRepository({ key, repositoryPath: right, enable: true, withTransaction }),
      /repository_registration_identity_conflict/);
    await assert.rejects(registerReviewRepository({ key: otherKey, repositoryPath: left, enable: true, withTransaction }),
      /repository_registration_identity_conflict/);
    assert.equal((await pool.query("select count(*)::int n from review_repositories where key=any($1)", [[key, otherKey]])).rows[0].n, 1);
  } finally {
    await pool.query("delete from review_repositories where key=any($1)", [[key, otherKey]]);
    await Promise.all([rm(left, { recursive: true, force: true }), rm(right, { recursive: true, force: true })]);
  }
});
