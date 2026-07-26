import { NextResponse, type NextRequest } from "next/server";
import { generateEmbedding } from "@/lib/embeddings";
import { listMemories, upsertMemory } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  const key = process.env.AGENT_API_KEY;
  if (!key) return false;
  return !!token && token === key;
}

/**
 * GET /api/agent/memory?agent=dev&type=journal&from=2025-01-01&to=2025-12-31&limit=50
 */
export async function GET(req: NextRequest) {
  if (!checkAuth(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const agent = params.get("agent");
  const type = params.get("type");
  const from = params.get("from");
  const to = params.get("to");
  const limit = Math.min(Number(params.get("limit") || 50), 200);

  try {
    const memories = await listMemories({ agent, type, from, to, limit });
    return NextResponse.json({ memories });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}

/**
 * POST /api/agent/memory
 * Body: { agent, type, content, title?, tags?, date? }
 * - journal type: upserts by (agent, date, type) — appends content for same day
 * - strategic/report: always inserts new
 */
export async function POST(req: NextRequest) {
  if (!checkAuth(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { agent, type = "journal", content, title, tags, date } = body;

  if (!agent || !content) {
    return NextResponse.json(
      { error: "agent and content required" },
      { status: 400 }
    );
  }

  const validTypes = ["journal", "strategic", "report"];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${validTypes.join(", ")}` },
      { status: 400 }
    );
  }

  const memoryDate = date || new Date().toISOString().split("T")[0];
  const safeTags = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  const embedding = await generateEmbedding(String(content));

  try {
    const data = await upsertMemory({
      agent,
      type,
      title: title || null,
      content,
      tags: safeTags,
      date: memoryDate,
      embedding,
    });
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_write_failed" }, { status: 500 });
  }
}
