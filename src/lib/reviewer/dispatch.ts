import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";
import { buildReviewerPackage } from "@/lib/reviewer/package";
import { lockReviewerExecution } from "@/lib/reviewer/execution-context";
import { failReviewerExecution } from "@/lib/reviewer/review-completion";
import { REVIEW_CAPABILITY_TTL_MS } from "../../../scripts/lib/reviewer-contract.mjs";

export type TransactionRunner = <T>(run: (client: CompletionQueryClient) => Promise<T>) => Promise<T>;
export type ReviewerLauncher = (executionId: string, capability: string) => Promise<number>;
export type ReviewerDispatchResult =
  | { ok: true; already_running: true; state_claimed: true; execution_id: string; status: "running" }
  | { ok: true; already_running: false; state_claimed: true; execution_id: string; package_sha256: string;
      status: "running" | "succeeded" | "failed" | "cancelled" | "blocked" };

export class ReviewerDispatchError extends Error {
  readonly kind = "reviewer_dispatch_error";

  constructor(
    message: string,
    readonly state_claimed?: boolean,
    readonly execution_id?: string,
  ) {
    super(message);
    this.name = "ReviewerDispatchError";
  }
}

export function isReviewerDispatchError(error: unknown): error is ReviewerDispatchError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate.kind === "reviewer_dispatch_error"
    && (candidate.state_claimed === undefined || typeof candidate.state_claimed === "boolean")
    && (candidate.execution_id === undefined || typeof candidate.execution_id === "string");
}

type DispatchRow = {
  loop_id: string; loop_status: string; workflow_version: number; approval_scope: unknown;
  plan_revision_id: string; revision_status: string; plan_hash: string; plan_snapshot: unknown;
  stage_id: string; task_id: string; task_status: string; task_key: string; task_title: string;
  task_description: string | null; task_metadata: Record<string, unknown> | null;
  work_item_id: string; work_status: string; work_payload: Record<string, unknown>;
  review_run_id: string; review_run_status: string; run_role: string; quality_cycle: number;
  execution_attempt_id: string; target_run_id: string; target_sha: string; base_sha: string; repository_id: string;
  implementation_status: string; implementation_role: string; implementation_sha: string;
  implementer_session_id: string | null; review_id: string; review_status: string; reviewed_sha: string;
  repository_key: string; canonical_root: string; git_common_dir: string; object_format: "sha1" | "sha256";
  repository_enabled: boolean; max_diff_bytes: number; max_package_bytes: number;
};

const DEFAULT_DB = "postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local";

export function safeRunnerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/Users/joaco",
    TMPDIR: process.env.TMPDIR || "/tmp",
    NODE_ENV: process.env.NODE_ENV || "production",
    MISSION_CONTROL_DATABASE_URL: process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_DB,
    HERMES_REVIEWER_BIN: process.env.HERMES_REVIEWER_BIN || "/Users/joaco/.hermes/hermes-agent/venv/bin/hermes",
    HERMES_REVIEWER_PROFILE: process.env.HERMES_REVIEWER_PROFILE || "reviewer",
    HERMES_REVIEWER_MODEL: process.env.HERMES_REVIEWER_MODEL || "gpt-5.6-sol",
    HERMES_REVIEWER_PROVIDER: process.env.HERMES_REVIEWER_PROVIDER || "openai-codex",
  };
}

/** Launches the detached runner. The raw capability exists only in the parent and child FD 3 pipe. */
export const launchReviewerRunner: ReviewerLauncher = async (executionId, capability) => {
  const script = resolve(process.cwd(), "scripts/reviewer-runner.mjs");
  const child: ChildProcess = spawn(process.execPath, [script, executionId], {
    cwd: process.cwd(), detached: true, env: safeRunnerEnv(),
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  } as SpawnOptions);
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  const capabilityPipe = child.stdio[3] as Writable | null;
  if (!capabilityPipe || typeof capabilityPipe.write !== "function") {
    child.kill("SIGTERM");
    throw new Error("reviewer_capability_pipe_unavailable");
  }
  capabilityPipe.end(capability, "utf8");
  child.unref();
  if (!child.pid) throw new Error("reviewer_runner_pid_missing");
  return child.pid;
};

async function failLaunch(withTransaction: TransactionRunner, executionId: string, reason: string) {
  await withTransaction(async (client) => {
    const execution = await lockReviewerExecution(client, executionId);
    if (!execution || execution.status !== "running") return;
    await failReviewerExecution(client, execution, reason);
    const now = new Date().toISOString();
    await client.query(
      `update reviewer_executions set status='failed',error=$2,finished_at=$3,
         capability_revoked_at=$3,heartbeat_at=$3,updated_at=$3 where id=$1 and status='running'`,
      [executionId, reason, now],
    );
  });
}

export async function dispatchReviewer(
  workItemId: string,
  dependencies: {
    withTransaction: TransactionRunner;
    launch?: ReviewerLauncher;
    terminate?: (pid: number) => void | Promise<void>;
  },
): Promise<ReviewerDispatchResult> {
  if (!/^[0-9a-f-]{36}$/i.test(workItemId)) {
    throw new ReviewerDispatchError("invalid_review_work_item_id", false);
  }
  const capability = randomBytes(32).toString("base64url");
  const capabilityHash = createHash("sha256").update(capability).digest();
  const executionId = randomUUID();
  const expiresAt = new Date(Date.now() + REVIEW_CAPABILITY_TTL_MS).toISOString();

  const prepared = await dependencies.withTransaction(async (client) => {
    try {
      const rows = await client.query<DispatchRow>(
        `select l.id loop_id,l.status loop_status,l.workflow_version,l.approval_scope,
          p.id plan_revision_id,p.status revision_status,p.content_hash plan_hash,p.plan_snapshot,
          s.id stage_id,t.id task_id,t.status task_status,t.key task_key,t.title task_title,t.description task_description,t.metadata task_metadata,
          wi.id work_item_id,wi.status work_status,wi.payload work_payload,
          rr.id review_run_id,rr.status review_run_status,rr.run_role,rr.quality_cycle,rr.execution_attempt_id,
          rr.target_run_id,rr.target_sha,rr.base_sha,rr.repository_id,
          impl.status implementation_status,impl.run_role implementation_role,impl.artifact_sha implementation_sha,
          impl.server_session_id implementer_session_id,d.id review_id,d.status review_status,d.reviewed_sha,
          repo.key repository_key,repo.canonical_root,repo.git_common_dir,repo.object_format,
          repo.enabled repository_enabled,repo.max_diff_bytes,repo.max_package_bytes
        from work_items wi join loop_work_items lwi on lwi.work_item_id=wi.id and lwi.relation_type='task_execution'
        join loops l on l.id=lwi.loop_id join loop_task_runs rr on rr.work_item_id=wi.id
        join loop_task_runs impl on impl.id=rr.target_run_id and impl.task_id=rr.task_id
        join loop_task_reviews d on d.review_run_id=rr.id and d.task_id=rr.task_id
        join loop_tasks t on t.id=rr.task_id join loop_stages s on s.id=t.stage_id
        join loop_plan_revisions p on p.id=s.plan_revision_id and p.loop_id=l.id
        join review_repositories repo on repo.id=rr.repository_id
        where wi.id=$1 for update of l,t,rr,wi,d`,
        [workItemId],
      );
    if (rows.rows.length !== 1) {
      throw new ReviewerDispatchError("isolated_review_relation_not_found_or_ambiguous", false);
    }
    const row = rows.rows[0];
    const payload = row.work_payload || {};
    const identityMatches = payload.runtime_contract === "fresh_review_v1" && payload.run_role === "review"
      && payload.execution_attempt_id === row.execution_attempt_id && payload.target_run_id === row.target_run_id
      && payload.target_sha === row.target_sha && payload.plan_revision_id === row.plan_revision_id
      && payload.plan_hash === row.plan_hash && row.reviewed_sha === row.target_sha
      && row.implementation_role === "implementation" && row.implementation_status === "succeeded"
      && row.implementation_sha === row.target_sha && Boolean(row.implementer_session_id);
    if (!identityMatches) throw new ReviewerDispatchError("isolated_review_identity_conflict", false);

    const stableState = row.workflow_version === 2 && row.loop_status === "in_progress"
      && row.task_status === "review_pending" && row.run_role === "review"
      && row.review_status === "pending" && row.revision_status === "approved" && row.repository_enabled;
    if (stableState && row.work_status === "in_progress" && row.review_run_status === "running") {
      const current = await client.query<{
        id: string; status: string; review_run_id: string; work_item_id: string; execution_attempt_id: string;
        repository_id: string; base_sha: string; target_sha: string;
      }>(
        `select id,status,review_run_id,work_item_id,execution_attempt_id,repository_id,base_sha,target_sha
           from reviewer_executions where review_run_id=$1 or work_item_id=$2 order by id for update`,
        [row.review_run_id, row.work_item_id],
      );
      const execution = current.rows[0];
      const exactRunning = current.rows.length === 1 && execution?.status === "running"
        && execution.review_run_id === row.review_run_id && execution.work_item_id === row.work_item_id
        && execution.execution_attempt_id === row.execution_attempt_id && execution.repository_id === row.repository_id
        && execution.base_sha === row.base_sha && execution.target_sha === row.target_sha
        && payload.dispatch_state === "in_progress" && payload.reviewer_execution_id === execution.id;
      if (exactRunning) return { alreadyRunning: true as const, executionId: execution.id };
    }
    if (!stableState || row.work_status !== "ready" || row.review_run_status !== "queued") {
      throw new ReviewerDispatchError("isolated_review_dispatch_state_conflict", false);
    }
    const acceptance = Array.isArray((row.plan_snapshot as Record<string, unknown> | null)?.acceptance_criteria)
      ? (row.plan_snapshot as { acceptance_criteria: string[] }).acceptance_criteria : [];
    const reviewPackage = await buildReviewerPackage({
      executionId, reviewRunId: row.review_run_id, workItemId: row.work_item_id,
      executionAttemptId: row.execution_attempt_id,
      repository: { id: row.repository_id, key: row.repository_key, canonical_root: row.canonical_root,
        git_common_dir: row.git_common_dir, object_format: row.object_format, enabled: row.repository_enabled,
        max_diff_bytes: row.max_diff_bytes, max_package_bytes: row.max_package_bytes },
      baseSha: row.base_sha, targetSha: row.target_sha, plan: row.plan_snapshot,
      approval: row.approval_scope,
      task: { key: row.task_key, title: row.task_title, description: row.task_description,
        acceptance_criteria: acceptance },
      untrustedAgentTests: row.task_metadata?.agent_reported_tests,
    });
    const now = new Date().toISOString();
    const work = await client.query(
      `update work_items set status='in_progress',started_at=coalesce(started_at,$2),updated_at=$2,
         payload=payload||jsonb_build_object('dispatch_state','in_progress','reviewer_execution_id',$3::text)
       where id=$1 and status='ready' returning id`, [workItemId, now, executionId]);
    const run = await client.query(
      "update loop_task_runs set status='running',started_at=coalesce(started_at,$2),updated_at=$2 where id=$1 and status='queued' returning id",
      [row.review_run_id, now]);
    if (work.rowCount !== 1 || run.rowCount !== 1) {
      throw new ReviewerDispatchError("isolated_review_dispatch_concurrent_conflict", false);
    }
    await client.query(
      `insert into reviewer_executions(id,review_run_id,work_item_id,execution_attempt_id,repository_id,
         base_sha,target_sha,package_sha256,status,capability_hash,capability_expires_at,dispatched_at,started_at,heartbeat_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,$11,$11,$11,$11,$11)`,
      [executionId,row.review_run_id,workItemId,row.execution_attempt_id,row.repository_id,row.base_sha,row.target_sha,
        reviewPackage.sha256,capabilityHash,expiresAt,now],
    );
    return { alreadyRunning: false as const, executionId, packageSha256: reviewPackage.sha256 };
    } catch (error) {
      if (isReviewerDispatchError(error)) throw error;
      const message = error instanceof Error ? error.message : "reviewer_dispatch_preclaim_failed";
      throw new ReviewerDispatchError(message, false);
    }
  });

  if (prepared.alreadyRunning) {
    return { ok: true, already_running: true, state_claimed: true,
      execution_id: prepared.executionId, status: "running" };
  }

  let pid: number;
  try {
    pid = await (dependencies.launch || launchReviewerRunner)(prepared.executionId, capability);
  } catch (error) {
    const reason = `reviewer_spawn_failed:${error instanceof Error ? error.message : "unknown"}`;
    await failLaunch(dependencies.withTransaction, prepared.executionId, reason).catch(() => {});
    throw new ReviewerDispatchError(reason, true, prepared.executionId);
  }
  let persistedStatus: "running" | "succeeded" | "failed" | "cancelled" | "blocked" = "running";
  try {
    persistedStatus = await dependencies.withTransaction(async (client) => {
      const updated = await client.query(
        "update reviewer_executions set pid=$2,heartbeat_at=now(),updated_at=now() where id=$1 and status='running' returning status",
        [prepared.executionId, pid],
      );
      if (updated.rowCount === 1) return "running";
      const current = await client.query<{ status: string; pid: number | null }>(
        "select status,pid from reviewer_executions where id=$1",
        [prepared.executionId],
      );
      const state = current.rows[0];
      if (state && ["succeeded", "failed", "cancelled", "blocked"].includes(state.status)) {
        return state.status as "succeeded" | "failed" | "cancelled" | "blocked";
      }
      throw new Error("reviewer_execution_pid_state_conflict");
    });
  } catch (error) {
    const terminate = dependencies.terminate || ((childPid: number) => { process.kill(childPid, "SIGTERM"); });
    await Promise.resolve(terminate(pid)).catch(() => {});
    const reason = `reviewer_pid_persistence_failed:${error instanceof Error ? error.message : "unknown"}`;
    await failLaunch(dependencies.withTransaction, prepared.executionId, reason).catch(() => {});
    throw new ReviewerDispatchError(reason, true, prepared.executionId);
  }
  return { ok: true, already_running: false, state_claimed: true, execution_id: prepared.executionId,
    package_sha256: prepared.packageSha256, status: persistedStatus };
}
