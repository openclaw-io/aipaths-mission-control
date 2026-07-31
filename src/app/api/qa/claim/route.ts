import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { parsePersistedQaPolicy } from "@/lib/loops/qa-policy";
import { signQaClaimEnvelope, type QaClaimEnvelope } from "@/lib/qa/authority";
import { hashQaPolicy } from "@/lib/qa/result";

export const dynamic = "force-dynamic";
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function authorized(request: NextRequest) {
  const expected = process.env.AGENT_API_KEY;
  return !!expected && request.headers.get("authorization") === `Bearer ${expected}`;
}
function response(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return response({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workItemId = typeof body?.work_item_id === "string" ? body.work_item_id : "";
  const attemptId = typeof body?.execution_attempt_id === "string" ? body.execution_attempt_id : "";
  const targetSha = typeof body?.target_sha === "string" ? body.target_sha : "";
  const policyHash = typeof body?.policy_hash === "string" ? body.policy_hash : "";
  if (!UUID.test(workItemId) || !UUID.test(attemptId) || !SHA.test(targetSha) || !HASH.test(policyHash)) {
    return response({ error: "invalid_qa_claim_identity" }, 400);
  }
  const capability = randomBytes(32).toString("base64url");
  const capabilityHash = createHash("sha256").update(capability).digest();
  const executionId = randomUUID();
  const now = new Date();
  const qaSessionId = `${now.toISOString().slice(0,10).replaceAll("-","")}_${now.toISOString().slice(11,19).replaceAll(":","")}_${randomBytes(3).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  try {
    const claimed = await withTransaction(async (client) => {
      const rows = await client.query<{
        qa_run_id: string; task_id: string; run_status: string; run_role: string; quality_cycle: number;
        execution_attempt_id: string; target_run_id: string; target_sha: string; work_status: string;
        task_status: string; task_metadata: Record<string, unknown>; loop_status: string; payload: Record<string, unknown>;
        plan_revision_id: string; plan_hash: string; revision_status: string; current_plan_revision_id: string; loop_id: string;
        implementation_status: string; implementation_role: string; implementation_sha: string;
        implementer_session_id: string; reviewer_session_id: string; reviewed_sha: string;
        repository_id: string; base_sha: string;
      }>(`select r.id qa_run_id,r.task_id,r.status run_status,r.run_role,r.quality_cycle,r.execution_attempt_id,
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
      if (rows.rows.length !== 1) return { error: "qa_work_item_not_found", status: 404 as const };
      const row = rows.rows[0]; const payload = row.payload || {};
      const policy = parsePersistedQaPolicy(payload.qa_policy);
      const frozenPolicy = parsePersistedQaPolicy(row.task_metadata?.qa_policy);
      const exact = row.run_role === "qa" && payload.runtime_contract === "visual_qa_v1" && payload.run_role === "qa"
        && row.execution_attempt_id === attemptId && payload.execution_attempt_id === attemptId
        && row.target_sha === targetSha && payload.target_sha === targetSha
        && payload.target_run_id === row.target_run_id
        && payload.plan_revision_id === row.plan_revision_id && payload.plan_hash === row.plan_hash
        && row.revision_status === "approved" && row.current_plan_revision_id === row.plan_revision_id
        && row.implementation_role === "implementation" && row.implementation_status === "succeeded"
        && row.implementation_sha === targetSha && row.reviewed_sha === targetSha
        && row.implementer_session_id !== row.reviewer_session_id
        && payload.policy_hash === policyHash && !!policy?.required && !!frozenPolicy?.required
        && hashQaPolicy(policy) === policyHash && hashQaPolicy(frozenPolicy) === policyHash;
      if (!exact) return { error: "qa_claim_binding_mismatch", status: 409 as const };
      if (row.run_status !== "queued" || row.work_status !== "ready" || row.task_status !== "qa_pending" || row.loop_status !== "in_progress") {
        return { error: "qa_claim_state_conflict", status: 409 as const };
      }
      const envelope: QaClaimEnvelope = {
        version: "qa_claim_v1", execution_id: executionId, qa_run_id: row.qa_run_id, task_id: row.task_id,
        work_item_id: workItemId, execution_attempt_id: attemptId, target_run_id: row.target_run_id,
        target_sha: targetSha, policy_hash: policyHash, quality_cycle: row.quality_cycle,
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
      if (!claimedExecution.rows[0]?.claimed) throw new Error("qa_claim_concurrent_conflict");
      return { execution_id: executionId, qa_run_id: row.qa_run_id, task_id: row.task_id, work_item_id: workItemId,
        execution_attempt_id: attemptId, target_sha: targetSha, policy_hash: policyHash, qa_session_id: qaSessionId };
    });
    if ("error" in claimed) return response({ error: claimed.error }, claimed.status);
    return response({ ok: true, ...claimed, capability, capability_expires_at: expiresAt }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "qa_claim_failed";
    return response({ error: message }, /conflict|duplicate/.test(message) ? 409 : 500);
  }
}
