import { NextResponse, type NextRequest } from "next/server";
import { withTransaction } from "@/lib/db/postgres";
import { dispatchReviewer, isReviewerDispatchError } from "@/lib/reviewer/dispatch";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const expected = process.env.AGENT_API_KEY;
  return !!expected && header === `Bearer ${expected}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workItemId = typeof body?.work_item_id === "string" ? body.work_item_id : "";
  try {
    const execution = await dispatchReviewer(workItemId, { withTransaction });
    if (execution.already_running) {
      return NextResponse.json({ ok: true, already_running: true, state_claimed: true,
        execution_id: execution.execution_id, status: "running" }, { status: 409 });
    }
    if (execution.status === "running" || execution.status === "succeeded") {
      return NextResponse.json({ ok: true, state_claimed: true, started: true,
        execution_id: execution.execution_id, status: execution.status }, { status: 202 });
    }
    return NextResponse.json({ ok: false, state_claimed: true,
      execution_id: execution.execution_id, error: `reviewer_execution_${execution.status}` }, { status: 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reviewer_dispatch_failed";
    const status = message.startsWith("invalid_") ? 400
      : /not_found/.test(message) ? 404
      : /conflict/.test(message) ? 409 : 500;
    if (isReviewerDispatchError(error)) {
      if (error.state_claimed === true) {
        return NextResponse.json({ error: message, state_claimed: true,
          execution_id: error.execution_id }, { status });
      }
      if (error.state_claimed === false) {
        return NextResponse.json({ error: message, state_claimed: false }, { status });
      }
    }
    return NextResponse.json({ error: message }, { status });
  }
}
