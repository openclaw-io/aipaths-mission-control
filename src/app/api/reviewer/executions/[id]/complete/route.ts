import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { lockReviewerExecution } from "@/lib/reviewer/execution-context";
import { parseReviewerResult } from "@/lib/reviewer/package";
import { applyReviewerResult } from "@/lib/reviewer/review-completion";

export const dynamic = "force-dynamic";
const SESSION_PATTERN = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function capability(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^ReviewCapability ([A-Za-z0-9_-]{43})$/);
  return match?.[1] || null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = capability(request);
  if (!token || !CAPABILITY_PATTERN.test(token)) return NextResponse.json({ error: "invalid_review_capability" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  const packageSha = typeof body?.package_sha256 === "string" ? body.package_sha256 : "";
  const attemptId = typeof body?.execution_attempt_id === "string" ? body.execution_attempt_id : "";
  if (!SESSION_PATTERN.test(sessionId) || !/^[0-9a-f]{64}$/.test(packageSha) || !attemptId) {
    return NextResponse.json({ error: "invalid_reviewer_completion_identity" }, { status: 400 });
  }
  let result;
  try { result = parseReviewerResult(JSON.stringify(body?.result)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid_reviewer_result" }, { status: 400 }); }
  const { id } = await params;
  const suppliedHash = createHash("sha256").update(token).digest();
  try {
    const outcome = await withTransaction(async (client) => {
      const execution = await lockReviewerExecution(client, id);
      if (!execution) return { status: 404 as const, error: "reviewer_execution_not_found" };
      if (execution.status !== "running" || execution.capability_consumed_at || execution.capability_revoked_at) {
        return { status: 409 as const, error: "review_capability_already_consumed_or_revoked" };
      }
      const storedHash = Buffer.from(execution.capability_hash);
      if (storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)) {
        return { status: 401 as const, error: "invalid_review_capability" };
      }
      if (new Date(execution.capability_expires_at).getTime() <= Date.now()) {
        return { status: 410 as const, error: "review_capability_expired" };
      }
      if (execution.package_sha256 !== packageSha || execution.execution_attempt_id !== attemptId) {
        return { status: 409 as const, error: "review_capability_binding_mismatch" };
      }
      if (execution.reviewer_session_id && execution.reviewer_session_id !== sessionId) {
        return { status: 409 as const, error: "reviewer_session_mismatch" };
      }
      const applied = await applyReviewerResult(client, execution, result, sessionId);
      const now = new Date().toISOString();
      const completed = await client.query(
        `update reviewer_executions set status='succeeded',reviewer_session_id=$2,
           capability_consumed_at=$3,finished_at=$3,result=$4::jsonb,updated_at=$3,heartbeat_at=$3
          where id=$1 and status='running' and capability_consumed_at is null and capability_revoked_at is null returning id`,
        [id, sessionId, now, JSON.stringify(result)],
      );
      if (completed.rowCount !== 1) throw new Error("review_capability_concurrent_conflict");
      return { status: 200 as const, applied };
    });
    if ("error" in outcome) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true, execution_id: id, ...outcome.applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reviewer_completion_failed";
    const status = /conflict|mismatch|concurrent/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
