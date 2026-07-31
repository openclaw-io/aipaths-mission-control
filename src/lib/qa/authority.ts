import { createHmac } from "node:crypto";
import { canonicalJson } from "@/lib/qa/result";

const HMAC_KEY = /^[0-9a-f]{64}$/;

export type QaClaimEnvelope = {
  version: "qa_claim_v1";
  execution_id: string;
  qa_run_id: string;
  task_id: string;
  work_item_id: string;
  execution_attempt_id: string;
  target_run_id: string;
  target_sha: string;
  policy_hash: string;
  quality_cycle: number;
  plan_revision_id: string;
  plan_hash: string;
  loop_id: string;
  repository_id: string;
  base_sha: string;
  implementer_session_id: string;
  reviewer_session_id: string;
  capability_hash: string;
  capability_expires_at: string;
  qa_session_id: string;
  claimed_at: string;
};

export function requireQaAuthorityHmacKey(environment: NodeJS.ProcessEnv = process.env) {
  const key = environment.QA_AUTHORITY_HMAC_KEY;
  if (!key || !HMAC_KEY.test(key)) throw new Error("qa_authority_hmac_key_invalid");
  return Buffer.from(key, "hex");
}

export function signQaClaimEnvelope(envelope: QaClaimEnvelope, environment: NodeJS.ProcessEnv = process.env) {
  return createHmac("sha256", requireQaAuthorityHmacKey(environment))
    .update(canonicalJson(envelope), "utf8")
    .digest("hex");
}
