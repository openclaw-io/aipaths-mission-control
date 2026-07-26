import { NextResponse, type NextRequest } from "next/server";
import { getWorkItem, patchAgentWorkItem, type JsonRecord } from "@/lib/db/mission-control";

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

  try {
    const data = await patchAgentWorkItem(id, body);
    if (!data) return NextResponse.json({ error: "Work item not found" }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_write_failed" }, { status: 500 });
  }
}
