import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { lockQaExecution, applyQaResult } from "@/lib/qa/execution";
import { verifyQaEvidence } from "@/lib/qa/evidence";
import { parseQaResult, hashQaPolicy, hashQaResult } from "@/lib/qa/result";
import { containsInvalidUtf8String, parsePersistedQaPolicy } from "@/lib/loops/qa-policy";

export const dynamic = "force-dynamic";
const SESSION = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PUBLIC_COMPLETION_ERRORS = new Set([
  "qa_execution_state_conflict",
  "qa_session_mismatch",
  "qa_planner_session_unbound",
  "qa_tested_sha_mismatch",
  "qa_run_concurrent_conflict",
  "qa_completion_concurrent_conflict",
]);
function response(body: object, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function token(request: NextRequest) {
  const match = (request.headers.get("authorization") || "").match(/^QaCapability ([A-Za-z0-9_-]{43})$/);
  return match?.[1] || null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const capability = token(request);
  if (!capability || !CAPABILITY.test(capability)) return response({ error: "invalid_qa_capability" }, 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  const attemptId = typeof body?.execution_attempt_id === "string" ? body.execution_attempt_id : "";
  const targetSha = typeof body?.target_sha === "string" ? body.target_sha : "";
  const policyHash = typeof body?.policy_hash === "string" ? body.policy_hash : "";
  const suppliedResultHash = typeof body?.result_hash === "string" ? body.result_hash : "";
  if (!SESSION.test(sessionId) || !attemptId || !SHA.test(targetSha) || !HASH.test(policyHash) || !HASH.test(suppliedResultHash)) {
    return response({ error: "invalid_qa_completion_identity" }, 400);
  }
  // PostgreSQL jsonb cannot represent U+0000, and JS can represent unpaired
  // surrogates that are not valid UTF-8. Reject both before any database query.
  if (containsInvalidUtf8String(body?.result)) return response({ error: "qa_result_utf8_invalid" }, 400);
  const { id } = await params;
  const suppliedCapabilityHash = createHash("sha256").update(capability).digest();
  try {
    const outcome = await withTransaction(async (client) => {
      const execution = await lockQaExecution(client, id);
      if (!execution) return { error: "qa_execution_not_found", status: 404 as const };
      if (execution.status !== "running" || execution.capability_consumed_at || execution.capability_revoked_at) {
        return { error: "qa_capability_already_consumed_or_revoked", status: 409 as const };
      }
      const stored = Buffer.from(execution.capability_hash);
      if (stored.length !== suppliedCapabilityHash.length || !timingSafeEqual(stored, suppliedCapabilityHash)) {
        return { error: "invalid_qa_capability", status: 401 as const };
      }
      if (new Date(execution.capability_expires_at).getTime() <= Date.now()) return { error: "qa_capability_expired", status: 410 as const };
      if (execution.execution_attempt_id !== attemptId || execution.target_sha !== targetSha
        || execution.policy_hash !== policyHash || execution.qa_session_id !== sessionId) {
        return { error: "qa_capability_binding_mismatch", status: 409 as const };
      }
      const payloadPolicy = parsePersistedQaPolicy(execution.work_payload?.qa_policy);
      const frozenPolicy = parsePersistedQaPolicy(execution.task_metadata?.qa_policy);
      if (!payloadPolicy?.required || !frozenPolicy?.required
        || hashQaPolicy(payloadPolicy) !== policyHash || hashQaPolicy(frozenPolicy) !== policyHash
        || execution.work_payload?.plan_revision_id !== execution.plan_revision_id
        || execution.work_payload?.plan_hash !== execution.plan_hash
        || execution.revision_status !== "approved" || execution.current_plan_revision_id !== execution.plan_revision_id) {
        return { error: "qa_policy_binding_mismatch", status: 409 as const };
      }
      let result;
      try { result = parseQaResult(JSON.stringify(body?.result), frozenPolicy, targetSha); }
      catch { return { error: "invalid_qa_result", status: 400 as const }; }
      const computedResultHash = hashQaResult(result);
      if (computedResultHash !== suppliedResultHash) return { error: "qa_result_hash_mismatch", status: 409 as const };
      try { await verifyQaEvidence(result, computedResultHash); }
      catch { return { error: "qa_evidence_verification_failed", status: 409 as const }; }
      const applied = await applyQaResult(client, execution, result, computedResultHash, sessionId, capability);
      return { applied };
    });
    if ("error" in outcome) return response({ error: outcome.error }, outcome.status);
    return response({ ok: true, execution_id: id, ...outcome.applied });
  } catch (error) {
    if (error instanceof Error && PUBLIC_COMPLETION_ERRORS.has(error.message)) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "qa_completion_failed" }, 500);
  }
}
