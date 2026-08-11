import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import {
  inspectRepositoryForRegistration,
  registerReviewRepository,
} from "../repository-registration.mjs";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const fixtureRoot = await mkdtemp(resolve(tmpdir(), "mc-register-fixture-"));
const servicesRoot = resolve(fixtureRoot, "services");
const repositoriesRoot = resolve(servicesRoot, "repos");
const agentsRoot = resolve(fixtureRoot, "agents");
await Promise.all([
  mkdir(repositoriesRoot, { recursive: true }),
  mkdir(agentsRoot, { recursive: true }),
]);

const originalAllowedRoots = process.env.AIPATHS_REPOSITORY_ROOTS;
process.env.AIPATHS_REPOSITORY_ROOTS = [servicesRoot, agentsRoot].join(delimiter);

const pool = new pg.Pool({ connectionString: requireMissionControlTestDatabaseUrl(), max: 4 });
after(async () => {
  await pool.end();
  if (originalAllowedRoots === undefined) delete process.env.AIPATHS_REPOSITORY_ROOTS;
  else process.env.AIPATHS_REPOSITORY_ROOTS = originalAllowedRoots;
  await rm(fixtureRoot, { recursive: true, force: true });
});

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

async function makeRepository(parent = repositoriesRoot) {
  const root = await mkdtemp(resolve(parent, ".mc-register-repo-"));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Mission Control Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "mc-test@local"]);
  await writeFile(resolve(root, "README.md"), "registered\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

test("repository registration accepts service and agent roots and requires explicit enable", async () => {
  const serviceRepository = await makeRepository();
  const agentRepository = await makeRepository(agentsRoot);
  const outsideRepository = await makeRepository(fixtureRoot);
  const escapedWorktree = resolve(repositoriesRoot, `.mc-register-external-common-${randomUUID()}`);
  const key = `registration-${randomUUID()}`;

  try {
    execFileSync("git", ["-C", outsideRepository, "worktree", "add", "--detach", escapedWorktree, "HEAD"]);
    for (const root of [serviceRepository, agentRepository]) {
      const identity = await inspectRepositoryForRegistration(root);
      assert.equal(identity.canonicalRoot, await realpath(root));
      assert.match(identity.gitCommonDir, /\.git$/);
      assert.equal(identity.objectFormat, "sha1");
    }
    await assert.rejects(registerReviewRepository({
      key,
      repositoryPath: serviceRepository,
      enable: false,
      withTransaction,
    }), /repository_enable_flag_required/);
    await assert.rejects(inspectRepositoryForRegistration(outsideRepository), /repository_outside_allowed_root/);
    await assert.rejects(inspectRepositoryForRegistration(escapedWorktree), /repository_git_root_invalid/);
  } finally {
    execFileSync("git", ["-C", outsideRepository, "worktree", "remove", "--force", escapedWorktree]);
  }
  const rootConstraint = (await pool.query(
    `select pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid='public.review_repositories'::regclass
        and conname='review_repositories_canonical_root_check'`,
  )).rows[0]?.definition || "";
  assert.doesNotMatch(rootConstraint, /\/Users\/[^/]+\//);
  assert.match(rootConstraint, /canonical_root <> '\/'/);
  assert.equal((await pool.query("select count(*)::int n from review_repositories where key=$1", [key])).rows[0].n, 0);
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
  }
});

test("repository-root migration accepts the agents tree and refuses an unsafe rollback", async () => {
  const migrationRoot = resolve("ops/migrations/20260811_repository_roots_allowlist");
  const sourceSql = await Promise.all([
    readFile(resolve(migrationRoot, "preflight.sql"), "utf8"),
    readFile(resolve(migrationRoot, "forward.sql"), "utf8"),
    readFile(resolve(migrationRoot, "verify.sql"), "utf8"),
    readFile(resolve(migrationRoot, "rollback.sql"), "utf8"),
  ]);
  const schema = `gon124_${randomUUID().replaceAll("-", "")}`;
  const table = `"${schema}".review_repositories`;
  const [preflight, forward, verify, rollback] = sourceSql.map((sql) =>
    sql.replaceAll("public.review_repositories", table));
  const legacyPrefix = rollback.match(/canonical_root LIKE '([^']*)%'/i)?.[1];
  assert.ok(legacyPrefix, "rollback must declare the historical repository prefix");
  assert.doesNotMatch(legacyPrefix, /'/);
  const legacyRoot = `${legacyPrefix}repos/${randomUUID()}`;
  const agentRoot = resolve(await realpath(agentsRoot), `director-${randomUUID()}`);
  const client = await pool.connect();
  const legacyKey = `legacy-${randomUUID()}`;
  const agentKey = `agent-${randomUUID()}`;
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`create table ${table} (
      id uuid primary key default gen_random_uuid(),
      key text not null unique,
      canonical_root text not null unique
        constraint review_repositories_canonical_root_check
        check (canonical_root like '${legacyPrefix}%'),
      git_common_dir text not null unique,
      object_format text not null,
      enabled boolean not null default true
    )`);
    await client.query(`insert into ${table}(key,canonical_root,git_common_dir,object_format)
      values ($1,$2,$3,'sha1')`, [
      legacyKey,
      legacyRoot,
      `${legacyRoot}/.git`,
    ]);

    await client.query(preflight);
    await client.query(forward);
    await client.query(verify);
    await client.query(`insert into ${table}(key,canonical_root,git_common_dir,object_format)
      values ($1,$2,$3,'sha1')`, [
      agentKey,
      agentRoot,
      `${agentRoot}/.git`,
    ]);

    await assert.rejects(client.query(rollback), /rollback refused/);
    await client.query("rollback");
    await client.query(`delete from ${table} where key=$1`, [agentKey]);
    await client.query(rollback);
    await assert.rejects(client.query(`insert into ${table}(key,canonical_root,git_common_dir,object_format)
      values ($1,$2,$3,'sha1')`, [
      agentKey,
      agentRoot,
      `${agentRoot}/.git`,
    ]), /review_repositories_canonical_root_check/);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.query(`drop schema if exists "${schema}" cascade`);
    client.release();
  }
});
