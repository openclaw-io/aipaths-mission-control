import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as repositoryRoots from "../../../src/lib/work-items/repository-roots.mjs";

const sourceRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(sourceRepoRoot, "src/lib/work-items/git-artifact.ts");
const fixtureRoot = await mkdtemp(resolve(tmpdir(), "mc-git-artifact-fixture-"));
const servicesRoot = resolve(fixtureRoot, "services");
const repositoriesRoot = resolve(servicesRoot, "repos");
const worktreesRoot = resolve(servicesRoot, "worktrees");
const agentsRoot = resolve(fixtureRoot, "agents");
await Promise.all([
  mkdir(repositoriesRoot, { recursive: true }),
  mkdir(worktreesRoot, { recursive: true }),
  mkdir(agentsRoot, { recursive: true }),
]);

const originalAllowedRoots = process.env.AIPATHS_REPOSITORY_ROOTS;
process.env.AIPATHS_REPOSITORY_ROOTS = [servicesRoot, agentsRoot].join(delimiter);

after(async () => {
  if (originalAllowedRoots === undefined) delete process.env.AIPATHS_REPOSITORY_ROOTS;
  else process.env.AIPATHS_REPOSITORY_ROOTS = originalAllowedRoots;
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeRepository(parent, prefix) {
  const root = await mkdtemp(resolve(parent, prefix));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Mission Control Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "mc-test@local"]);
  writeFileSync(resolve(root, "artifact.txt"), "one\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "one"]);
  writeFileSync(resolve(root, "artifact.txt"), "two\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "two"]);
  return root;
}

const serviceRepository = await makeRepository(repositoriesRoot, "mission-control-");
const agentRepository = await makeRepository(agentsRoot, "director-systems-");

function loadGitArtifact() {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(transpiled, {
    module: cjsModule,
    exports: cjsModule.exports,
    process,
    require(specifier) {
      if (specifier === "node:child_process") return { execFile };
      if (specifier === "node:fs/promises") return { realpath };
      if (specifier === "node:os") return { homedir };
      if (specifier === "./repository-roots.mjs") return repositoryRoots;
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
  }, { filename: sourcePath });
  return cjsModule.exports;
}

const { inspectRepositoryRegistration, verifyRepositoryCommit } = loadGitArtifact();

function gitSha(repositoryPath, revision) {
  return execFileSync("git", ["-C", repositoryPath, "rev-parse", revision], { encoding: "utf8" }).trim();
}

async function registeredRepository(repositoryPath = serviceRepository) {
  const identity = await inspectRepositoryRegistration(repositoryPath);
  return { id: "test", canonical_root: identity.canonicalRoot, git_common_dir: identity.gitCommonDir,
    object_format: identity.objectFormat, enabled: true };
}

test("repository roots derive the services and declared agents trees and reject an empty override", async () => {
  const roots = await repositoryRoots.resolveAllowedRepositoryRoots({
    cwd: serviceRepository,
    env: { AIPATHS_AGENTS_DIR: agentsRoot },
  });
  assert.deepEqual(roots, [await realpath(servicesRoot), await realpath(agentsRoot)]);
  assert.equal(repositoryRoots.isPathWithinAllowedRoots(roots[0], roots), false);
  assert.equal(repositoryRoots.isPathWithinAllowedRoots(await realpath(serviceRepository), roots), true);
  await assert.rejects(
    repositoryRoots.resolveAllowedRepositoryRoots({
      cwd: serviceRepository,
      env: { AIPATHS_REPOSITORY_ROOTS: "" },
    }),
    /repository_allowed_roots_unavailable/,
  );
});

test("git artifact verification accepts service and agent repositories without a shell", async () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /execFile\(/);
  assert.doesNotMatch(source, /\bexecSync\s*\(|\bexec\s*\(|shell\s*:\s*true/);

  for (const repositoryPath of [serviceRepository, agentRepository]) {
    const headSha = gitSha(repositoryPath, "HEAD");
    const baseSha = gitSha(repositoryPath, "HEAD^");
    const verified = await verifyRepositoryCommit(
      repositoryPath,
      headSha,
      await registeredRepository(repositoryPath),
      baseSha,
    );
    assert.equal(verified.repositoryPath, await realpath(repositoryPath));
    assert.equal(verified.repositoryRoot, await realpath(repositoryPath));
    assert.equal(verified.sha, headSha);
  }
});

test("git artifact verification fails closed for outside, non-repository, missing, and wrong artifacts", async () => {
  const outsidePath = await mkdtemp(resolve(fixtureRoot, "outside-"));
  const prefixCollisionRoot = resolve(fixtureRoot, "services-evil");
  await mkdir(prefixCollisionRoot);
  const prefixCollisionRepository = await makeRepository(prefixCollisionRoot, "repo-");
  const symlinkEscape = resolve(servicesRoot, ".mc-git-artifact-symlink-escape");
  await symlink(prefixCollisionRepository, symlinkEscape);
  const nonRepositoryPath = await mkdtemp(resolve(servicesRoot, ".mc-git-artifact-non-repo-"));
  const missingPath = resolve(servicesRoot, `.missing-git-artifact-${process.pid}`);
  const headSha = gitSha(serviceRepository, "HEAD");
  const baseSha = gitSha(serviceRepository, "HEAD^");
  const registered = await registeredRepository();

  await assert.rejects(
    verifyRepositoryCommit(outsidePath, headSha, registered, baseSha),
    /implementation_repository_outside_allowed_root/,
  );
  await assert.rejects(
    verifyRepositoryCommit(prefixCollisionRepository, headSha, registered, baseSha),
    /implementation_repository_outside_allowed_root/,
  );
  await assert.rejects(
    verifyRepositoryCommit(symlinkEscape, headSha, registered, baseSha),
    /implementation_repository_outside_allowed_root/,
  );
  await assert.rejects(
    verifyRepositoryCommit(nonRepositoryPath, headSha, registered, baseSha),
    /implementation_repository_git_required/,
  );
  await assert.rejects(
    verifyRepositoryCommit(missingPath, headSha, registered, baseSha),
    /implementation_repository_path_invalid/,
  );
  await assert.rejects(
    verifyRepositoryCommit(serviceRepository, "", registered, baseSha),
    /implementation_head_sha_not_commit/,
  );
  await assert.rejects(
    verifyRepositoryCommit(serviceRepository, "0".repeat(40), registered, baseSha),
    /implementation_head_sha_not_commit/,
  );
});

test("git artifact rejects an allowed worktree backed by a git-common-dir outside every root", async () => {
  const outsideRepository = await makeRepository(fixtureRoot, "outside-common-");
  const escapedWorktree = resolve(worktreesRoot, `.mc-git-external-common-${process.pid}`);
  try {
    execFileSync("git", ["-C", outsideRepository, "worktree", "add", "--detach", escapedWorktree, "HEAD"]);
    await assert.rejects(
      inspectRepositoryRegistration(escapedWorktree),
      /repository_git_root_invalid/,
    );
  } finally {
    execFileSync("git", ["-C", outsideRepository, "worktree", "remove", "--force", escapedWorktree]);
  }
});

test("git artifact fails closed when no configured root resolves", async () => {
  const configured = process.env.AIPATHS_REPOSITORY_ROOTS;
  process.env.AIPATHS_REPOSITORY_ROOTS = resolve(fixtureRoot, "missing-root");
  try {
    await assert.rejects(
      inspectRepositoryRegistration(serviceRepository),
      /repository_allowed_roots_unavailable/,
    );
  } finally {
    process.env.AIPATHS_REPOSITORY_ROOTS = configured;
  }
});

test("git artifact accepts a sibling worktree with the registered git-common-dir and rejects non-HEAD and tags", async () => {
  const sibling = resolve(worktreesRoot, `.mc-git-sibling-${process.pid}`);
  const headSha = gitSha(serviceRepository, "HEAD");
  const baseSha = gitSha(serviceRepository, "HEAD^");
  const registered = await registeredRepository();
  try {
    execFileSync("git", ["-C", serviceRepository, "worktree", "add", "--detach", sibling, headSha]);
    const verified = await verifyRepositoryCommit(sibling, headSha, registered, baseSha);
    assert.equal(verified.repositoryPath, await realpath(sibling));
    assert.equal(verified.gitCommonDir, registered.git_common_dir);

    const parent = gitSha(sibling, "HEAD^");
    await assert.rejects(verifyRepositoryCommit(sibling, parent, registered, baseSha), /implementation_head_sha_not_head/);
    execFileSync("git", ["-C", sibling, "-c", "user.name=Mission Control Test", "-c", "user.email=mc-test@local",
      "tag", "-a", `mc-artifact-tag-${process.pid}`, "-m", "test tag", headSha]);
    const tagObject = gitSha(sibling, `refs/tags/mc-artifact-tag-${process.pid}`);
    await assert.rejects(verifyRepositoryCommit(sibling, tagObject, registered, baseSha), /implementation_head_sha_not_commit/);
  } finally {
    try { execFileSync("git", ["-C", serviceRepository, "tag", "-d", `mc-artifact-tag-${process.pid}`]); } catch {}
    try { execFileSync("git", ["-C", serviceRepository, "worktree", "remove", "--force", sibling]); } catch {}
  }
});

test("git artifact rejects another repository and ignores replace refs while enforcing literal HEAD", async () => {
  const other = await makeRepository(repositoriesRoot, ".mc-git-artifact-other-");
  const headSha = gitSha(serviceRepository, "HEAD");
  const baseSha = gitSha(serviceRepository, "HEAD^");
  const parent = gitSha(other, "HEAD^");
  const head = gitSha(other, "HEAD");

  await assert.rejects(
    verifyRepositoryCommit(other, head, await registeredRepository(), baseSha),
    /implementation_repository_identity_mismatch/,
  );
  const identity = await inspectRepositoryRegistration(other);
  const ownRegistration = { id: "other", canonical_root: identity.canonicalRoot, git_common_dir: identity.gitCommonDir,
    object_format: identity.objectFormat, enabled: true };
  execFileSync("git", ["-C", other, "replace", head, parent]);
  assert.equal((await verifyRepositoryCommit(other, head, ownRegistration, parent)).sha, head,
    "--no-replace-objects must preserve the literal commit identity");
  await assert.rejects(verifyRepositoryCommit(other, parent, ownRegistration, parent), /implementation_head_sha_not_head/);
  await assert.rejects(verifyRepositoryCommit(`${other}\n`, headSha, ownRegistration, parent),
    /implementation_repository_path_controls_forbidden/);
});
