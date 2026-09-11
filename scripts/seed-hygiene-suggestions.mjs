#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { parseLocalDatabaseUrl, redactSecrets } from "../ops/local-postgres/sync-local-core-helpers.mjs";

const { Client: PgClient } = pg;

function loadEnv(path) {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!process.env[key]) process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // .env.local is optional when the environment is already populated.
  }
}

loadEnv(resolve(process.cwd(), ".env.local"));

const databaseUrl = process.env.MISSION_CONTROL_DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing MISSION_CONTROL_DATABASE_URL; there is no Supabase/cloud fallback");
  process.exit(1);
}
try {
  parseLocalDatabaseUrl(databaseUrl);
} catch (error) {
  console.error(redactSecrets(error, [databaseUrl]));
  process.exit(1);
}

const db = new PgClient({ connectionString: databaseUrl });
const OPEN_STATUSES = ["draft", "blocked", "ready", "in_progress"];

const findings = [
  {
    title: "Review/push Mission Control live — ahead 9",
    target_agent_id: "systems",
    risk: "medium",
    dedupe_key: "repo-hygiene:mission-control-live:ahead-9:2026-04-29",
    proposed_action: "Review and push the 9 local Mission Control live commits if safe.",
    approval_prompt: "Mission Control live has a clean working tree but is ahead of remote by 9 commits. Approve to queue a Systems review/push task instead of auto-pushing production-related commits.",
    instruction: "Review /Users/joaco/Repos/repos/aipaths-mission-control-live. It was reported clean working tree but ahead of remote by 9 commits. Inspect the commit range, verify no secrets or unsafe production changes, run the smallest relevant checks, then push if safe or report the blocker. Do not rewrite history.",
  },
  {
    title: "Review strategist repo — ahead 2 + intel/docs changes",
    target_agent_id: "strategist",
    risk: "medium",
    dedupe_key: "repo-hygiene:strategist:ahead-2-dirty-intel-docs:2026-04-29",
    proposed_action: "Review repo state, commit/push owner-approved work, or report blockers.",
    approval_prompt: "Strategist is ahead by 2 and has many intel/docs changes. Approve to queue an owner review rather than letting Systems auto-commit cross-owner work.",
    instruction: "Review the Strategist repo state from the hygiene check: ahead 2 plus many intel/docs changes. Group coherent owner-approved changes, commit/push if safe, and report any active or ambiguous work that should remain uncommitted.",
  },
  {
    title: "Review systems repo hygiene batch",
    target_agent_id: "systems",
    risk: "medium",
    dedupe_key: "repo-hygiene:systems:large-docs-scripts-sql-archive:2026-04-29",
    proposed_action: "Review and commit coherent systems-owned batches or split active work.",
    approval_prompt: "Systems has a large batch of docs/scripts/sql/archive changes without commit. Approve to queue a focused cleanup/commit pass.",
    instruction: "Review /Users/joaco/Repos/agents/director-systems. There is a large docs/scripts/sql/archive batch without commit. Split active work from durable changes, run relevant lightweight checks, commit coherent systems-owned batches, and report anything that should remain uncommitted.",
  },
  {
    title: "Review YouTube knowledge restructure",
    target_agent_id: "youtube",
    risk: "medium",
    dedupe_key: "repo-hygiene:youtube:knowledge-restructure-state-tmp:2026-04-29",
    proposed_action: "Review, commit durable knowledge changes, and ignore/drop tmp only if safe.",
    approval_prompt: "YouTube has knowledge restructure plus state/tmp changes. Approve to queue owner review before committing durable knowledge changes.",
    instruction: "Review the YouTube repo state from the hygiene check: knowledge restructure plus state/tmp changes. Commit durable knowledge changes if safe, avoid committing ephemeral tmp/state artifacts unless intentionally durable, and report any ambiguity.",
  },
  {
    title: "Review notion-dispatcher workers — ahead 11",
    target_agent_id: "systems",
    risk: "medium",
    dedupe_key: "repo-hygiene:notion-dispatcher:ahead-11-new-workers:2026-04-29",
    proposed_action: "Review and push/commit dispatcher worker changes after safety check.",
    approval_prompt: "notion-dispatcher is ahead by 11 and has new workers. Approve to queue Systems review before pushing runtime worker changes.",
    instruction: "Review /Users/joaco/Repos/infra/aipaths-runtime-workers. It was reported ahead 11 plus new workers. Inspect local commits and dirty files, verify runtime safety, commit/push safe batches, and report blockers. Be careful with scheduler/worker behavior.",
  },
  {
    title: "Review academy changes — email/types + migration 104 + content submodule",
    target_agent_id: "dev",
    risk: "high",
    dedupe_key: "repo-hygiene:academy:email-types-migration-104-content-submodule:2026-04-29",
    proposed_action: "Review academy changes, validate migration/submodule state, commit/push safe batches.",
    approval_prompt: "Academy has email/types changes, migration 104, and a content submodule with a new blog. This is high risk because it touches web/product DB and content deployment state. Approve to queue Dev review.",
    instruction: "Review /Users/joaco/Repos/repos/aipaths-academy. Hygiene found email/types changes, migration 104, and content submodule with a new blog. Validate migration and submodule state, run relevant checks, commit/push only safe coherent batches, and report any deployment or content-publish blocker.",
  },
  {
    title: "Review content repo context/docs/drafts",
    target_agent_id: "content",
    risk: "low",
    dedupe_key: "repo-hygiene:content:context-docs-drafts:2026-04-29",
    proposed_action: "Owner review and commit/push safe context/docs/drafts.",
    approval_prompt: "Content has context/docs/drafts without commit. Approve to queue owner review.",
    instruction: "Review the Content repo hygiene finding: context/docs/drafts without commit. Commit/push safe owner-approved durable changes and leave/report active drafts that should not be committed yet.",
  },
  {
    title: "Review dev repo context/docs/drafts",
    target_agent_id: "dev",
    risk: "low",
    dedupe_key: "repo-hygiene:dev:context-docs-drafts:2026-04-29",
    proposed_action: "Owner review and commit/push safe context/docs/drafts.",
    approval_prompt: "Dev has context/docs/drafts without commit. Approve to queue owner review.",
    instruction: "Review the Dev repo hygiene finding: context/docs/drafts without commit. Commit/push safe owner-approved durable changes and leave/report active drafts that should not be committed yet.",
  },
  {
    title: "Review marketing repo context/docs/drafts",
    target_agent_id: "marketing",
    risk: "low",
    dedupe_key: "repo-hygiene:marketing:context-docs-drafts:2026-04-29",
    proposed_action: "Owner review and commit/push safe context/docs/drafts.",
    approval_prompt: "Marketing has context/docs/drafts without commit. Approve to queue owner review.",
    instruction: "Review the Marketing repo hygiene finding: context/docs/drafts without commit. Commit/push safe owner-approved durable changes and leave/report active drafts that should not be committed yet.",
  },
  {
    title: "Review community repo context/docs/drafts",
    target_agent_id: "community",
    risk: "low",
    dedupe_key: "repo-hygiene:community:context-docs-drafts:2026-04-29",
    proposed_action: "Owner review and commit/push safe context/docs/drafts.",
    approval_prompt: "Community has context/docs/drafts without commit. Approve to queue owner review.",
    instruction: "Review the Community repo hygiene finding: context/docs/drafts without commit. Commit/push safe owner-approved durable changes and leave/report active drafts that should not be committed yet.",
  },
  {
    title: "Review youtube_mcp video intel tool",
    target_agent_id: "youtube",
    risk: "medium",
    dedupe_key: "repo-hygiene:youtube-mcp:video-intel-tool:2026-04-29",
    proposed_action: "Review and commit video intel tool changes.",
    approval_prompt: "youtube_mcp has a video intel tool without commit. Approve to queue YouTube owner review.",
    instruction: "Review the youtube_mcp hygiene finding: video intel tool without commit. Inspect the tool changes, run relevant checks if available, commit/push if safe, and report blockers.",
  },
];

async function createDedupedSuggestion(finding) {
  await db.query("begin");
  try {
    const existingResult = await db.query(
      `select id, title, status
         from public.work_items
        where payload ->> 'dedupe_key' = $1
          and status = any($2::text[])
        order by created_at desc
        limit 1`,
      [finding.dedupe_key, OPEN_STATUSES],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      await db.query("commit");
      return { ...existing, created: false, dedupe_key: finding.dedupe_key };
    }

    const payload = {
      requires_human_approval: true,
      dedupe_key: finding.dedupe_key,
      risk: finding.risk,
      proposed_action: finding.proposed_action,
      approval_prompt: finding.approval_prompt,
      suggestion_source: "systems_repo_hygiene_check",
      hygiene_check_work_item_id: "a9f05742-2f16-4745-a1cd-2889275dccfe",
      hygiene_check_date: "2026-04-29",
    };
    const insertResult = await db.query(
      `insert into public.work_items (
         kind, source_type, source_id, title, instruction, status, priority,
         owner_agent, target_agent_id, requested_by, scheduled_for, payload
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       returning id, title, status`,
      [
        "task",
        "service",
        "a9f05742-2f16-4745-a1cd-2889275dccfe",
        finding.title,
        finding.instruction,
        "draft",
        finding.risk === "high" ? "high" : "medium",
        finding.target_agent_id,
        finding.target_agent_id,
        "systems_repo_hygiene_check",
        null,
        JSON.stringify(payload),
      ],
    );
    const inserted = insertResult.rows[0];
    await db.query(
      `insert into public.event_log (
         domain, event_type, entity_type, entity_id, actor, payload
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        "work",
        "work_item.suggestion_created",
        "work_item",
        inserted.id,
        "systems_repo_hygiene_check",
        JSON.stringify({
          dedupe_key: finding.dedupe_key,
          title: finding.title,
          target_agent_id: finding.target_agent_id,
          proposed_action: finding.proposed_action,
          risk: finding.risk,
          hygiene_check_work_item_id: "a9f05742-2f16-4745-a1cd-2889275dccfe",
        }),
      ],
    );
    await db.query("commit");
    return { ...inserted, created: true, dedupe_key: finding.dedupe_key };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

try {
  await db.connect();
  const results = [];
  for (const finding of findings) results.push(await createDedupedSuggestion(finding));
  console.table(results.map((result) => ({
    created: result.created,
    status: result.status,
    title: result.title,
    id: result.id,
  })));
} catch (error) {
  console.error(redactSecrets(error, [databaseUrl]));
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
