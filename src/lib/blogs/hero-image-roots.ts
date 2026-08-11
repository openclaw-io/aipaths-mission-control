import { homedir } from "node:os";
import path from "node:path";

import { directorRoot, legacyDirectorRoot } from "@/lib/agents-paths";

// These are the exact roots already used by the blog hero endpoint. Keeping
// the allowlist shared lets completion and final approval fail closed against
// the same filesystem boundary without expanding GON-91.
export function allowedBlogHeroImageRoots(): string[] {
  const roots = new Set([path.join(homedir(), ".openclaw", "media")]);
  for (const content of [directorRoot("content"), legacyDirectorRoot("content")]) {
    if (content) roots.add(path.join(content, "work", "localizations"));
  }
  return [...roots];
}
