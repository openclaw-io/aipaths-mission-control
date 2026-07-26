#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const ALLOWLIST = new Set([
  "README.md", // Supabase product terminology.
  "src/lib/intel-destinations.ts", // Generic startup synonym mapping.
  "src/lib/intel-inbox.ts", // External “Startup/Project of the Day” copy.
  "supabase/migrations/024_retire_empty_project_content_service_links.sql", // Immutable historical migration.
  "supabase/migrations/030_projects_to_loops_total_cutover.sql", // Forward cutover must name its source.
  "ops/migrations/20260726_loops_cutover/preflight.sql",
  "ops/migrations/20260726_loops_cutover/postflight.sql",
  "ops/migrations/20260726_loops_cutover/rollback.sql",
  "scripts/lib/__tests__/work-item-loop-contract.test.mjs", // Verifies controlled legacy mapping.
  "scripts/lib/__tests__/loops-total-cutover.test.mjs", // Verifies old route/schema absence.
  "scripts/lib/__tests__/loops-cutover-postgres.test.mjs", // Executes the legacy fixture through forward/rollback.
  "scripts/rehearse-loops-cutover.mjs", // Executable scratch PostgreSQL legacy fixture.
  "scripts/lib/work-item-loop-contract.mjs", // Implements the one-shot controlled mapping.
  "docs/loops-cutover-tdd.md", // Recorded RED evidence.
  "scripts/guard-no-project-domain.mjs", // This guard's own patterns.
]);

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sql", ".md", ".yml", ".yaml"]);
const DOMAIN_PATTERNS = [
  ["legacy source path", /(?:^|\/)src\/(?:app|components|lib)\/projects(?:\/|$)/m],
  ["legacy UI/API route", /["'`](?:\/api)?\/projects(?:\/|["'`?])/],
  ["legacy import namespace", /@\/(?:lib|components)\/projects(?:\/|["'])/],
  ["legacy table", /\b(?:projects|project_events|project_work_items)\b/],
  ["legacy relation column", /\bproject_id\b/],
  ["legacy camel-case contract", /\b(?:projectId|projectStatus|projectUpdates|Project[A-Z][A-Za-z0-9_]*)\b/],
  ["legacy source type", /source_type\s*(?:=|:|===?)\s*["']project["']/],
  ["legacy event prefix", /["']project\.[a-z_]/],
  ["legacy actor", /["']project-(?:planner|execution-materializer)["']/],
  ["legacy controlled payload key", /\b(?:source_project_id|source_project_title|materialized_from_project|project_status_at_materialization|superseded_for_project_id)\b/],
];

const schema = readFileSync("ops/local-postgres/schema.sql", "utf8");
const forward = readFileSync("supabase/migrations/030_projects_to_loops_total_cutover.sql", "utf8");
const rollback = readFileSync("ops/migrations/20260726_loops_cutover/rollback.sql", "utf8");
const postflight = readFileSync("ops/migrations/20260726_loops_cutover/postflight.sql", "utf8");
const reviewRoute = readFileSync("src/app/api/loops/[id]/review/route.ts", "utf8");
const localReviewBranch = reviewRoute.slice(reviewRoute.indexOf("if (useLocalMode)"), reviewRoute.indexOf("const supabase = createServiceClient"));
const contractViolations = [];
if (!/CREATE TABLE IF NOT EXISTS public\.pipeline_items[\s\S]*\bloop_id uuid/i.test(schema)) contractViolations.push("fresh schema: pipeline_items.loop_id missing");
if (/public\.recurrence_rules\b/i.test(schema)) contractViolations.push("fresh schema: legacy recurrence_rules was introduced");
if (/\bproject_id\b/i.test(schema)) contractViolations.push("fresh schema: project_id remains");
for (const relation of ["pipeline_items", "recurrence_rules"]) {
  if (!new RegExp(`${relation}[\\s\\S]*project_id[\\s\\S]*loop_id`, "i").test(forward)) contractViolations.push(`forward: optional ${relation} rename missing`);
}
if (!/cutover_created/i.test(forward) || !/DROP INDEX[\s\S]*cutover_created/i.test(rollback)) contractViolations.push("migration: reversible cutover-created primary index contract missing");
if (!/orphaned_source_loop_id/.test(forward + postflight + rollback)) contractViolations.push("migration: orphan Loop source marker contract missing");
if (/last_completed_at/i.test(localReviewBranch)) contractViolations.push("local runtime: review assumes last_completed_at");

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = [...contractViolations];

for (const file of files) {
  if (!existsSync(file) || ALLOWLIST.has(file) || !TEXT_EXTENSIONS.has(extname(file))) continue;
  const content = readFileSync(file, "utf8");
  for (const [label, pattern] of DOMAIN_PATTERNS) {
    if (pattern.test(file) || pattern.test(content)) violations.push(`${file}: ${label}`);
  }
}

if (violations.length) {
  console.error("Mission Control legacy Projects-domain references found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Loops guard passed: ${files.length} repository files scanned, zero unapproved legacy domain references.`);
