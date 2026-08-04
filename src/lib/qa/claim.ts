import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";
import { parsePersistedQaPolicy } from "@/lib/loops/qa-policy";
import { signQaClaimEnvelope, type QaClaimEnvelope } from "@/lib/qa/authority";
import { hashQaPolicy } from "@/lib/qa/result";

export type QaClaimTransactionRunner = <T>(run: (client: CompletionQueryClient) => Promise<T>) => Promise<T>;

export type QaClaimExpectedIdentity = {
  execution_attempt_id: string;
  target_sha: string;
  policy_hash: string;
};

export type QaClaimResult =
  | { alreadyRunning: true; execution_id: string; status: "running" }
  | { alreadyRunning: false; execution_id: string; qa_run_id: string; task_id: string; work_item_id: string;
      execution_attempt_id: string; target_sha: string; policy_hash: string; qa_session_id: string;
      capability: string; capability_expires_at: string };

export class QaClaimError extends Error {
  readonly kind = "qa_claim_error";

  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "QaClaimError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISUAL_QA_CAPABILITY_TTL_MS = 90 * 60_000;
const MAX_VISUAL_QA_COMBINATIONS = 2;

type ClaimRow = {
  qa_run_id: string; task_id: string; run_status: string; run_role: string; quality_cycle: number;
  execution_attempt_id: string; target_run_id: string; target_sha: string; work_status: string;
  task_status: string; task_metadata: Record<string, unknown>; loop_status: string; payload: Record<string, unknown>;
  plan_revision_id: string; plan_hash: string; revision_status: string; current_plan_revision_id: string; loop_id: string;
  implementation_status: string; implementation_role: string; implementation_sha: string;
  implementer_session_id: string; reviewer_session_id: string; reviewed_sha: string;
  repository_id: string; base_sha: string;
};

function sessionId(now: Date) {
  return `${now.toISOString().slice(0,10).replaceAll("-","")}_${now.toISOString().slice(11,19).replaceAll(":","")}_${randomBytes(3).toString("hex")}`;
}

export async function claimQaWorkItem(
  workItemId: string,
  options: {
    withTransaction: QaClaimTransactionRunner;
    expected?: QaClaimExpectedIdentity;
    allowAlreadyRunning?: boolean;
    now?: Date;
  },
): Promise<QaClaimResult> {
  if (!UUID.test(workItemId)) throw new QaClaimError("invalid_qa_claim_identity", 400);
  const capability = randomBytes(32).toString("base64url");
  const capabilityHash = createHash("sha256").update(capability).digest();
  const executionId = randomUUID();
  const now = options.now || new Date();
  const qaSessionId = sessionId(now);
  const expiresAt = new Date(now.getTime() + VISUAL_QA_CAPABILITY_TTL_MS).toISOString();

  return options.withTransaction(async (client) => {
    const rows = await client.query<ClaimRow>(`select r.id qa_run_id,r.task_id,r.status run_status,r.run_role,r.quality_cycle,r.execution_attempt_id,
        r.target_run_id,r.target_sha,wi.status work_status,wi.payload,t.status task_status,t.metadata task_metadata,
        p.id plan_revision_id,p.content_hash plan_hash,p.status revision_status,l.current_plan_revision_id,l.status loop_status,l.id loop_id,
        impl.status implementation_status,impl.run_role implementation_role,impl.artifact_sha implementation_sha,
        impl.server_session_id implementer_session_id,d.reviewer_session_id,d.reviewed_sha,r.repository_id,r.base_sha
      from work_items wi join loop_task_runs r on r.work_item_id=wi.id join loop_tasks t on t.id=r.task_id
      join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
      join loops l on l.id=p.loop_id join loop_task_runs impl on impl.id=r.target_run_id and impl.task_id=r.task_id
      join loop_task_reviews d on d.task_id=r.task_id and d.task_run_id=impl.id and d.quality_cycle=r.quality_cycle
        and d.status='approved' and d.reviewed_sha=r.target_sha
      where wi.id=$1 for update of wi,r,t,l`, [workItemId]);
    if (rows.rows.length !== 1) throw new QaClaimError("qa_work_item_not_found", 404);
    const row = rows.rows[0];
    const payload = row.payload || {};
    const policy = parsePersistedQaPolicy(payload.qa_policy);
    const frozenPolicy = parsePersistedQaPolicy(row.task_metadata?.qa_policy);
    const policyCombinations = policy
      ? policy.viewports.length * Math.max(1, policy.flows.length)
      : Number.POSITIVE_INFINITY;
    const frozenPolicyCombinations = frozenPolicy
      ? frozenPolicy.viewports.length * Math.max(1, frozenPolicy.flows.length)
      : Number.POSITIVE_INFINITY;
    const expectedAttempt = options.expected?.execution_attempt_id ?? row.execution_attempt_id;
    const expectedSha = options.expected?.target_sha ?? row.target_sha;
    const expectedPolicyHash = options.expected?.policy_hash ?? String(payload.policy_hash || "");
    const exact = row.run_role === "qa" && payload.runtime_contract === "visual_qa_v1" && payload.run_role === "qa"
      && row.execution_attempt_id === expectedAttempt && payload.execution_attempt_id === expectedAttempt
      && row.target_sha === expectedSha && payload.target_sha === expectedSha
      && payload.target_run_id === row.target_run_id
      && payload.plan_revision_id === row.plan_revision_id && payload.plan_hash === row.plan_hash
      && row.revision_status === "approved" && row.current_plan_revision_id === row.plan_revision_id
      && row.implementation_role === "implementation" && row.implementation_status === "succeeded"
      && row.implementation_sha === expectedSha && row.reviewed_sha === expectedSha
      && row.implementer_session_id !== row.reviewer_session_id
      && payload.policy_hash === expectedPolicyHash && !!policy?.required && !!frozenPolicy?.required
      && policyCombinations <= MAX_VISUAL_QA_COMBINATIONS
      && frozenPolicyCombinations <= MAX_VISUAL_QA_COMBINATIONS
      && hashQaPolicy(policy) === expectedPolicyHash && hashQaPolicy(frozenPolicy) === expectedPolicyHash;
    if (!exact) throw new QaClaimError("qa_claim_binding_mismatch", 409);

    const stableRunning = row.run_status === "running" && row.work_status === "in_progress"
      && row.task_status === "qa_pending" && row.loop_status === "in_progress";
    if (options.allowAlreadyRunning && stableRunning) {
      const current = await client.query<{
        id: string; status: string; qa_run_id: string; work_item_id: string; execution_attempt_id: string;
        target_run_id: string; target_sha: string; policy_hash: string;
      }>(`select id,status,qa_run_id,work_item_id,execution_attempt_id,target_run_id,target_sha,policy_hash
          from qa_executions where qa_run_id=$1 or work_item_id=$2 order by id for update`,
        [row.qa_run_id, workItemId]);
      const execution = current.rows[0];
      const exactRunning = current.rows.length === 1 && execution?.status === "running"
        && execution.qa_run_id === row.qa_run_id && execution.work_item_id === workItemId
        && execution.execution_attempt_id === row.execution_attempt_id && execution.target_run_id === row.target_run_id
        && execution.target_sha === row.target_sha && execution.policy_hash === expectedPolicyHash
        && payload.dispatch_state === "in_progress" && payload.qa_execution_id === execution.id;
      if (exactRunning) return { alreadyRunning: true, execution_id: execution.id, status: "running" };
      throw new QaClaimError("qa_running_execution_ambiguous", 409);
    }

    if (row.run_status !== "queued" || row.work_status !== "ready" || row.task_status !== "qa_pending" || row.loop_status !== "in_progress") {
      throw new QaClaimError("qa_claim_state_conflict", 409);
    }
    const envelope: QaClaimEnvelope = {
      version: "qa_claim_v1", execution_id: executionId, qa_run_id: row.qa_run_id, task_id: row.task_id,
      work_item_id: workItemId, execution_attempt_id: expectedAttempt, target_run_id: row.target_run_id,
      target_sha: expectedSha, policy_hash: expectedPolicyHash, quality_cycle: row.quality_cycle,
      plan_revision_id: row.plan_revision_id, plan_hash: row.plan_hash, loop_id: row.loop_id,
      repository_id: row.repository_id, base_sha: row.base_sha,
      implementer_session_id: row.implementer_session_id, reviewer_session_id: row.reviewer_session_id,
      capability_hash: capabilityHash.toString("hex"), capability_expires_at: expiresAt,
      qa_session_id: qaSessionId, claimed_at: now.toISOString(),
    };
    const signature = signQaClaimEnvelope(envelope);
    const claimedExecution = await client.query<{ claimed: boolean }>(
      "select claim_visual_qa_execution($1::jsonb,$2,$3) claimed",
      [JSON.stringify(envelope), signature, capability],
    );
    if (!claimedExecution.rows[0]?.claimed) throw new QaClaimError("qa_claim_concurrent_conflict", 409);
    return { alreadyRunning: false, execution_id: executionId, qa_run_id: row.qa_run_id, task_id: row.task_id,
      work_item_id: workItemId, execution_attempt_id: expectedAttempt, target_sha: expectedSha,
      policy_hash: expectedPolicyHash, qa_session_id: qaSessionId, capability, capability_expires_at: expiresAt };
  });
}
