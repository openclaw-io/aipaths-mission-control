import { NextResponse, type NextRequest } from "next/server";
import { searchMemories } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  const key = process.env.AGENT_API_KEY;
  if (!key) return false;
  return !!token && token === key;
}

/**
 * POST /api/agent/memory/search
 * Body: { query, agent?, type?, threshold?, limit? }
 */
export async function POST(req: NextRequest) {
  if (!checkAuth(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const {
    query,
    agent,
    type,
    limit = 10,
  } = body;

  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  try {
    const results = await searchMemories({
      text: String(query),
      agent: typeof agent === "string" ? agent : null,
      type: typeof type === "string" ? type : null,
      limit: Math.min(Number(limit) || 10, 50),
    });
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}
