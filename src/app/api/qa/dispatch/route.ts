import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { dispatchQa, isQaDispatchError } from "@/lib/qa/dispatch";

export const dynamic = "force-dynamic";
const PUBLIC_DISPATCH_ERRORS = new Set([
  "invalid_qa_work_item_id",
  "invalid_qa_claim_identity",
  "qa_work_item_not_found",
  "qa_claim_binding_mismatch",
  "qa_running_execution_ambiguous",
  "qa_claim_state_conflict",
  "qa_claim_concurrent_conflict",
  "qa_dispatch_claim_failed",
  "qa_spawn_failed",
  "qa_pid_persistence_failed",
  "qa_runner_cleanup_failed",
]);

function authorized(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const expected = process.env.AGENT_API_KEY;
  return !!expected && header === `Bearer ${expected}`;
}

function response(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return response({ error: "Unauthorized" }, 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workItemId = typeof body?.work_item_id === "string" ? body.work_item_id : "";
  try {
    const execution = await dispatchQa(workItemId, { withTransaction });
    if (execution.already_running) {
      return response({ ok: true, already_running: true, state_claimed: true,
        execution_id: execution.execution_id, status: "running" }, 409);
    }
    if (execution.status === "running" || execution.status === "succeeded") {
      return response({ ok: true, state_claimed: true, started: true,
        execution_id: execution.execution_id, status: execution.status }, 202);
    }
    return response({ ok: false, state_claimed: true,
      execution_id: execution.execution_id, error: `qa_execution_${execution.status}` }, 500);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    const message = PUBLIC_DISPATCH_ERRORS.has(rawMessage) ? rawMessage : "qa_dispatch_failed";
    const status = message.startsWith("invalid_") ? 400
      : /not_found/.test(message) ? 404
      : /conflict|ambiguous/.test(message) ? 409 : 500;
    if (isQaDispatchError(error)) {
      if (error.state_claimed === true) {
        return response({ error: message, state_claimed: true, execution_id: error.execution_id }, status);
      }
      if (error.state_claimed === false) {
        return response({ error: message, state_claimed: false }, status);
      }
    }
    return response({ error: message }, status);
  }
}
