import { realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const ROOTS_ENV = "AIPATHS_REPOSITORY_ROOTS";

function rootCandidates(env, cwd) {
  if (Object.prototype.hasOwnProperty.call(env, ROOTS_ENV)) {
    return typeof env[ROOTS_ENV] === "string" ? env[ROOTS_ENV].split(delimiter) : [];
  }

  // Mission Control runs from <services-root>/{repos,worktrees}/<checkout>.
  // AIPATHS_AGENTS_DIR is the explicit cross-tree contract established by GON-91.
  const agents = env.AIPATHS_AGENTS_DIR?.trim();
  return [resolve(cwd, "..", ".."), ...(agents ? [resolve(agents)] : [])];
}

/** Resolve and canonicalize the fail-closed repository security boundary. */
export async function resolveAllowedRepositoryRoots({
  env = process.env,
  cwd = process.cwd(),
  realpathImpl = realpath,
} = {}) {
  const roots = [];
  for (const candidate of rootCandidates(env, cwd)) {
    if (!candidate) continue;
    const canonical = await realpathImpl(resolve(candidate)).catch(() => null);
    if (!canonical || canonical === dirname(canonical) || roots.includes(canonical)) continue;
    roots.push(canonical);
  }
  if (roots.length === 0) throw new Error("repository_allowed_roots_unavailable");
  return roots;
}

/** Compare canonical paths without prefix collisions such as /allowed and /allowed-evil. */
export function isPathWithinAllowedRoots(candidate, roots, { allowRoot = false } = {}) {
  return roots.some((root) => {
    const nested = relative(root, candidate);
    if (nested === "") return allowRoot;
    return nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
  });
}
