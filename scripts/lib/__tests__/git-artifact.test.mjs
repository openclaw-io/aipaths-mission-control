import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/work-items/git-artifact.ts");

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
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
  }, { filename: sourcePath });
  return cjsModule.exports;
}

const { inspectRepositoryRegistration, verifyRepositoryCommit } = loadGitArtifact();
const headSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baseSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
async function registeredRepository() {
  const identity = await inspectRepositoryRegistration(repoRoot);
  return { id: "test", canonical_root: identity.canonicalRoot, git_common_dir: identity.gitCommonDir,
    object_format: identity.objectFormat, enabled: true };
}

test("git artifact verification accepts the current worktree HEAD without a shell", async () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /execFile\(/);
  assert.doesNotMatch(source, /\bexecSync\s*\(|\bexec\s*\(|shell\s*:\s*true/);

  const verified = await verifyRepositoryCommit(repoRoot, headSha, await registeredRepository(), baseSha);
  assert.equal(verified.repositoryPath, await realpath(repoRoot));
  assert.equal(verified.repositoryRoot, await realpath(repoRoot));
  assert.equal(verified.sha, headSha);
});

test("git artifact verification fails closed for outside, non-repository, missing, and wrong artifacts", async () => {
  const outsidePath = await mkdtemp(resolve(tmpdir(), "mc-git-artifact-outside-"));
  const nonRepositoryPath = await mkdtemp("/Users/joaco/openclaw/.mc-git-artifact-non-repo-");
  const missingPath = resolve(repoRoot, `.missing-git-artifact-${process.pid}`);
  const registered = await registeredRepository();
  try {
    await assert.rejects(
      verifyRepositoryCommit(outsidePath, headSha, registered, baseSha),
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
      verifyRepositoryCommit(repoRoot, "", registered, baseSha),
      /implementation_head_sha_not_commit/,
    );
    await assert.rejects(
      verifyRepositoryCommit(repoRoot, "0".repeat(40), registered, baseSha),
      /implementation_head_sha_not_commit/,
    );
  } finally {
    await Promise.all([
      rm(outsidePath, { recursive: true, force: true }),
      rm(nonRepositoryPath, { recursive: true, force: true }),
    ]);
  }
});

test("git artifact accepts a sibling worktree with the registered git-common-dir and rejects non-HEAD and tags", async () => {
  const sibling = `/Users/joaco/openclaw/worktrees/.mc-git-sibling-${process.pid}`;
  const registered = await registeredRepository();
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", sibling, headSha]);
    const verified = await verifyRepositoryCommit(sibling, headSha, registered, baseSha);
    assert.equal(verified.repositoryPath, await realpath(sibling));
    assert.equal(verified.gitCommonDir, registered.git_common_dir);

    const parent = execFileSync("git", ["-C", sibling, "rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
    await assert.rejects(verifyRepositoryCommit(sibling, parent, registered, baseSha), /implementation_head_sha_not_head/);
    execFileSync("git", ["-C", sibling, "-c", "user.name=Mission Control Test", "-c", "user.email=mc-test@local",
      "tag", "-a", `mc-artifact-tag-${process.pid}`, "-m", "test tag", headSha]);
    const tagObject = execFileSync("git", ["-C", sibling, "rev-parse", `refs/tags/mc-artifact-tag-${process.pid}`], { encoding: "utf8" }).trim();
    await assert.rejects(verifyRepositoryCommit(sibling, tagObject, registered, baseSha), /implementation_head_sha_not_commit/);
  } finally {
    try { execFileSync("git", ["-C", repoRoot, "tag", "-d", `mc-artifact-tag-${process.pid}`]); } catch {}
    try { execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", sibling]); } catch {}
  }
});

test("git artifact rejects another repository and ignores replace refs while enforcing literal HEAD", async () => {
  const other = await mkdtemp("/Users/joaco/openclaw/.mc-git-artifact-other-");
  try {
    execFileSync("git", ["init", other]);
    execFileSync("git", ["-C", other, "config", "user.name", "Mission Control Test"]);
    execFileSync("git", ["-C", other, "config", "user.email", "mc-test@local"]);
    writeFileSync(resolve(other, "artifact.txt"), "one\n");
    execFileSync("git", ["-C", other, "add", "."]);
    execFileSync("git", ["-C", other, "commit", "-m", "one"]);
    const parent = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(resolve(other, "artifact.txt"), "two\n");
    execFileSync("git", ["-C", other, "add", "."]);
    execFileSync("git", ["-C", other, "commit", "-m", "two"]);
    const head = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await assert.rejects(verifyRepositoryCommit(other, head, await registeredRepository(), baseSha), /implementation_repository_identity_mismatch/);
    const identity = await inspectRepositoryRegistration(other);
    const ownRegistration = { id: "other", canonical_root: identity.canonicalRoot, git_common_dir: identity.gitCommonDir,
      object_format: identity.objectFormat, enabled: true };
    execFileSync("git", ["-C", other, "replace", head, parent]);
    assert.equal((await verifyRepositoryCommit(other, head, ownRegistration, parent)).sha, head,
      "--no-replace-objects must preserve the literal commit identity");
    await assert.rejects(verifyRepositoryCommit(other, parent, ownRegistration, parent), /implementation_head_sha_not_head/);
    await assert.rejects(verifyRepositoryCommit(`${other}\n`, head, ownRegistration, parent), /implementation_repository_path_controls_forbidden/);
  } finally { await rm(other, { recursive: true, force: true }); }
});
