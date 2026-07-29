import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

const ALLOWED_REPOSITORY_ROOT = "/Users/joaco/openclaw";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNSAFE_PATH_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export type RegisteredRepository = {
  id: string;
  canonical_root: string;
  git_common_dir: string;
  object_format: "sha1" | "sha256";
  enabled?: boolean;
};

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: "/Users/joaco",
    NODE_ENV: process.env.NODE_ENV || "production",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

export function execFileChecked(file: string, args: string[], options: { cwd?: string; maxBuffer?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: gitEnv(),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

function isWithinRoot(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function safePath(value: string) {
  return value.length > 0 && !UNSAFE_PATH_PATTERN.test(value);
}

async function git(repositoryPath: string, args: string[], maxBuffer?: number) {
  return execFileChecked("git", [
    "--no-replace-objects",
    "-c", "core.hooksPath=/dev/null",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.required=false",
    "-C", repositoryPath,
    ...args,
  ], { maxBuffer });
}

/** Capture canonical, server-owned identity for an operator-registered repository. */
export async function inspectRepositoryRegistration(repositoryPath: string) {
  if (!safePath(repositoryPath)) throw new Error("repository_path_controls_forbidden");
  const [allowedRoot, requestedPath] = await Promise.all([
    realpath(ALLOWED_REPOSITORY_ROOT),
    realpath(repositoryPath),
  ]).catch(() => { throw new Error("repository_path_invalid"); });
  if (!isWithinRoot(requestedPath, allowedRoot)) throw new Error("repository_outside_allowed_root");
  const rootRaw = (await git(requestedPath, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("repository_git_required");
  })).stdout.trim();
  const commonRaw = (await git(requestedPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const objectFormat = (await git(requestedPath, ["rev-parse", "--show-object-format"])).stdout.trim();
  const [canonicalRoot, gitCommonDir] = await Promise.all([realpath(rootRaw), realpath(commonRaw)]);
  if (!isWithinRoot(canonicalRoot, allowedRoot) || !isWithinRoot(requestedPath, canonicalRoot)) {
    throw new Error("repository_git_root_invalid");
  }
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("repository_object_format_invalid");
  return { canonicalRoot, gitCommonDir, objectFormat } as const;
}

/** Resolve the exact HEAD commit for first materialization from registered DB identity. */
export async function captureRegisteredRepositoryHead(repository: RegisteredRepository) {
  if (repository.enabled === false) throw new Error("registered_repository_disabled");
  const identity = await inspectRepositoryRegistration(repository.canonical_root);
  if (identity.canonicalRoot !== await realpath(repository.canonical_root)
      || identity.gitCommonDir !== await realpath(repository.git_common_dir)
      || identity.objectFormat !== repository.object_format) {
    throw new Error("registered_repository_identity_mismatch");
  }
  const head = (await git(identity.canonicalRoot, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  const expectedLength = repository.object_format === "sha256" ? 64 : 40;
  if (!SHA_PATTERN.test(head) || head.length !== expectedLength) throw new Error("registered_repository_head_invalid");
  const type = (await git(identity.canonicalRoot, ["cat-file", "-t", head])).stdout.trim();
  if (type !== "commit") throw new Error("registered_repository_head_not_commit");
  return { ...identity, sha: head };
}

/**
 * Fail-closed verification of an implementation artifact against a DB-pinned
 * repository. Only the reported worktree's literal HEAD is accepted: tags,
 * replace refs, non-HEAD commits and commits from another repository fail.
 */
export async function verifyRepositoryCommit(
  repositoryPath: string,
  sha: string,
  registered: RegisteredRepository,
  registeredBaseSha: string,
  priorArtifactSha?: string | null,
) {
  if (!safePath(repositoryPath)) throw new Error("implementation_repository_path_controls_forbidden");
  if (!SHA_PATTERN.test(sha)) throw new Error("implementation_head_sha_not_commit");
  const expectedLength = registered.object_format === "sha256" ? 64 : 40;
  if (sha.length !== expectedLength) throw new Error("implementation_head_sha_object_format_mismatch");
  if (!SHA_PATTERN.test(registeredBaseSha) || registeredBaseSha.length !== expectedLength) {
    throw new Error("implementation_registered_base_sha_invalid");
  }
  let allowedRoot: string;
  let requestedPath: string;
  try {
    [allowedRoot, requestedPath] = await Promise.all([realpath(ALLOWED_REPOSITORY_ROOT), realpath(repositoryPath)]);
  } catch {
    throw new Error("implementation_repository_path_invalid");
  }
  if (!isWithinRoot(requestedPath, allowedRoot)) throw new Error("implementation_repository_outside_allowed_root");

  let identity: Awaited<ReturnType<typeof inspectRepositoryRegistration>>;
  try {
    identity = await inspectRepositoryRegistration(requestedPath);
  } catch (error) {
    if (error instanceof Error && error.message === "repository_git_required") throw new Error("implementation_repository_git_required");
    throw error;
  }
  const registeredCommon = await realpath(registered.git_common_dir).catch(() => "");
  if (!registered.enabled || identity.gitCommonDir !== registeredCommon
      || identity.objectFormat !== registered.object_format) {
    throw new Error("implementation_repository_identity_mismatch");
  }
  const type = (await git(requestedPath, ["cat-file", "-t", sha]).catch(() => ({ stdout: "" }))).stdout.trim();
  if (type !== "commit") throw new Error("implementation_head_sha_not_commit");
  const head = (await git(requestedPath, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (head !== sha) throw new Error("implementation_head_sha_not_head");
  await git(requestedPath, ["merge-base", "--is-ancestor", registeredBaseSha, sha]).catch(() => {
    throw new Error("implementation_not_descendant_of_registered_base");
  });
  if (priorArtifactSha) {
    if (!SHA_PATTERN.test(priorArtifactSha) || priorArtifactSha.length !== expectedLength) {
      throw new Error("implementation_prior_artifact_sha_invalid");
    }
    if (priorArtifactSha === sha) throw new Error("implementation_rework_sha_unchanged");
    await git(requestedPath, ["merge-base", "--is-ancestor", priorArtifactSha, sha]).catch(() => {
      throw new Error("implementation_rework_not_descendant");
    });
  }
  return { repositoryPath: requestedPath, repositoryRoot: identity.canonicalRoot, gitCommonDir: identity.gitCommonDir, sha };
}
