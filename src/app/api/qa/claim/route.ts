import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { claimQaWorkItem, QaClaimError } from "@/lib/qa/claim";

export const dynamic = "force-dynamic";
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_CLAIM_ERRORS = new Map<string, number>([
  ["invalid_qa_claim_identity", 400],
  ["qa_work_item_not_found", 404],
  ["qa_claim_binding_mismatch", 409],
  ["qa_running_execution_ambiguous", 409],
  ["qa_claim_state_conflict", 409],
  ["qa_claim_concurrent_conflict", 409],
]);
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
  try {
    const claimed = await claimQaWorkItem(workItemId, {
      withTransaction,
      expected: { execution_attempt_id: attemptId, target_sha: targetSha, policy_hash: policyHash },
    });
    if (claimed.alreadyRunning) return response({ error: "qa_claim_state_conflict" }, 409);
    return response({ ok: true, ...claimed }, 201);
  } catch (error) {
    if (error instanceof QaClaimError) {
      const status = PUBLIC_CLAIM_ERRORS.get(error.message);
      if (status) return response({ error: error.message }, status);
    }
    return response({ error: "qa_claim_failed" }, 500);
  }
}
