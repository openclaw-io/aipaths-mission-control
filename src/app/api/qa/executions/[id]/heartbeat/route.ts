import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { lockQaExecution } from "@/lib/qa/execution";

export const dynamic = "force-dynamic";
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_HEARTBEAT_ERRORS = new Set(["23514", "28000"]);
function response(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function token(request: NextRequest) {
  const match = (request.headers.get("authorization") || "").match(/^QaCapability ([A-Za-z0-9_-]{43})$/);
  return match?.[1] || null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const capability = token(request);
  if (!capability || !CAPABILITY.test(capability)) return response({ error: "invalid_qa_capability" }, 401);
  const { id } = await params;
  const suppliedHash = createHash("sha256").update(capability).digest();
  try {
    const outcome = await withTransaction(async (client) => {
      const execution = await lockQaExecution(client, id);
      if (!execution) return { error: "qa_execution_not_found", status: 404 as const };
      if (execution.status !== "running" || execution.capability_consumed_at || execution.capability_revoked_at) {
        return { error: "qa_capability_already_consumed_or_revoked", status: 409 as const };
      }
      const stored = Buffer.from(execution.capability_hash);
      if (stored.length !== suppliedHash.length || !timingSafeEqual(stored, suppliedHash)) {
        return { error: "invalid_qa_capability", status: 401 as const };
      }
      if (new Date(execution.capability_expires_at).getTime() <= Date.now()) {
        return { error: "qa_capability_expired", status: 410 as const };
      }
      const beat = await client.query<{ heartbeat_at: string }>(
        "select heartbeat_visual_qa_execution($1,$2) heartbeat_at", [id,capability]);
      if (beat.rowCount !== 1 || !beat.rows[0]?.heartbeat_at) return { error: "qa_heartbeat_concurrent_conflict", status: 409 as const };
      return { heartbeat_at: beat.rows[0].heartbeat_at };
    });
    if ("error" in outcome) return response({ error: outcome.error }, outcome.status);
    return response({ ok: true, execution_id: id, heartbeat_at: outcome.heartbeat_at });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    if (PUBLIC_HEARTBEAT_ERRORS.has(code)) return response({ error: "qa_heartbeat_state_conflict" }, 409);
    return response({ error: "qa_heartbeat_failed" }, 500);
  }
}
