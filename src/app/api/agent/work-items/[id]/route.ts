import { NextResponse, type NextRequest } from "next/server";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { getWorkItem, type JsonRecord } from "@/lib/db/mission-control";
import { patchAgentWorkItemWithCompletion } from "@/lib/work-items/agent-completion-local";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["draft", "ready", "blocked", "in_progress", "done", "failed", "canceled"];

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const item = await getWorkItem(id);
    if (!item) return NextResponse.json({ error: "Work item not found" }, { status: 404 });
    return NextResponse.json(item);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json() as JsonRecord;
  const status = typeof body.status === "string" ? body.status : null;

  if (status && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Completion orchestration spans work items, Loops, pipeline rows, maps and
  // events. The only supported write architecture is one local Postgres
  // transaction; the REST/Supabase path cannot provide that atomicity.
  if (!isLocalAuthDisabled()) {
    return NextResponse.json({ error: "cloud_work_item_completion_not_supported" }, { status: 503 });
  }

  try {
    const data = await patchAgentWorkItemWithCompletion(id, body);
    if (!data) return NextResponse.json({ error: "Work item not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "local_postgres_write_failed";
    const statusCode = message === "stale_execution_attempt" || message === "terminal_status_conflict" ? 409 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
