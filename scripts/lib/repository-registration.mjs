import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  isPathWithinAllowedRoots,
  resolveAllowedRepositoryRoots,
} from "../../src/lib/work-items/repository-roots.mjs";

export const REPOSITORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const UNSAFE_PATH_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function execFileChecked(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: homedir(),
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function git(repositoryPath, args) {
  return execFileChecked("git", [
    "--no-replace-objects",
    "-c", "core.hooksPath=/dev/null",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.required=false",
    "-C", repositoryPath,
    ...args,
  ]);
}

/** Read server-owned, literal Git identity without a shell, hooks, or replace refs. */
export async function inspectRepositoryForRegistration(repositoryPath) {
  if (typeof repositoryPath !== "string" || !repositoryPath || UNSAFE_PATH_PATTERN.test(repositoryPath)) {
    throw new Error("repository_path_invalid");
  }
  let allowedRoots;
  let requestedPath;
  try {
    allowedRoots = await resolveAllowedRepositoryRoots();
  } catch (error) {
    if (error instanceof Error && error.message === "repository_allowed_roots_unavailable") throw error;
    throw new Error("repository_path_invalid");
  }
  try {
    requestedPath = await realpath(repositoryPath);
  } catch {
    throw new Error("repository_path_invalid");
  }
  if (!isPathWithinAllowedRoots(requestedPath, allowedRoots, { allowRoot: false })) {
    throw new Error("repository_outside_allowed_root");
  }

  let rootRaw;
  let commonRaw;
  let objectFormat;
  try {
    [rootRaw, commonRaw, objectFormat] = await Promise.all([
      git(requestedPath, ["rev-parse", "--show-toplevel"]),
      git(requestedPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(requestedPath, ["rev-parse", "--show-object-format"]),
    ]);
  } catch {
    throw new Error("repository_git_identity_unavailable");
  }

  let canonicalRoot;
  let gitCommonDir;
  try {
    [canonicalRoot, gitCommonDir] = await Promise.all([
      realpath(rootRaw.stdout.trim()),
      realpath(commonRaw.stdout.trim()),
    ]);
  } catch {
    throw new Error("repository_git_identity_unavailable");
  }
  if (!isPathWithinAllowedRoots(canonicalRoot, allowedRoots, { allowRoot: false })
      || !isPathWithinAllowedRoots(gitCommonDir, allowedRoots, { allowRoot: false })
      || !isPathWithinAllowedRoots(requestedPath, [canonicalRoot], { allowRoot: true })) {
    throw new Error("repository_git_root_invalid");
  }
  const format = objectFormat.stdout.trim();
  if (format !== "sha1" && format !== "sha256") throw new Error("repository_object_format_invalid");
  return { canonicalRoot, gitCommonDir, objectFormat: format };
}

/**
 * Transactionally registers and explicitly enables one repository. A key,
 * canonical root, or git-common-dir collision is idempotent only when every
 * persisted identity field is an exact match.
 */
export async function registerReviewRepository({
  key,
  repositoryPath,
  enable,
  withTransaction,
  inspect = inspectRepositoryForRegistration,
}) {
  if (!REPOSITORY_KEY_PATTERN.test(key || "")) throw new Error("repository_key_invalid");
  if (enable !== true) throw new Error("repository_enable_flag_required");
  if (typeof withTransaction !== "function") throw new Error("repository_transaction_required");
  const identity = await inspect(repositoryPath);

  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended('mission-control:review-repository-registration',0))");
    const conflicts = await client.query(
      `select id,key,canonical_root,git_common_dir,object_format,enabled
         from review_repositories
        where key=$1 or canonical_root=$2 or git_common_dir=$3
        order by id for update`,
      [key, identity.canonicalRoot, identity.gitCommonDir],
    );
    if (conflicts.rows.length > 0) {
      const exact = conflicts.rows.length === 1 && conflicts.rows[0].key === key
        && conflicts.rows[0].canonical_root === identity.canonicalRoot
        && conflicts.rows[0].git_common_dir === identity.gitCommonDir
        && conflicts.rows[0].object_format === identity.objectFormat;
      if (!exact) throw new Error("repository_registration_identity_conflict");
      const existing = conflicts.rows[0];
      if (!existing.enabled) {
        const enabled = await client.query(
          "update review_repositories set enabled=true,updated_at=now() where id=$1 returning id,key,canonical_root,git_common_dir,object_format,enabled",
          [existing.id],
        );
        return { action: "enabled", repository: enabled.rows[0] };
      }
      return { action: "existing", repository: existing };
    }

    const inserted = await client.query(
      `insert into review_repositories(key,canonical_root,git_common_dir,object_format,enabled)
       values ($1,$2,$3,$4,true)
       returning id,key,canonical_root,git_common_dir,object_format,enabled`,
      [key, identity.canonicalRoot, identity.gitCommonDir, identity.objectFormat],
    );
    return { action: "inserted", repository: inserted.rows[0] };
  });
}
