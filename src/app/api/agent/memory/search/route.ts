import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { generateEmbedding } from "@/lib/embeddings";

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
    threshold = 0.7,
    limit = 10,
  } = body;

  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Try semantic search first
  const embedding = await generateEmbedding(query);

  if (embedding) {
    const { data, error } = await supabase.rpc("match_memories", {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: limit,
      filter_agent: agent || null,
      filter_type: type || null,
    });

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ results: data });
  }

  // Fallback: text search with ILIKE
  let textQuery = supabase
    .from("memories")
    .select("id, agent, type, title, content, tags, date, created_at")
    .ilike("content", `%${query}%`)
    .order("date", { ascending: false })
    .limit(limit);

  if (agent) textQuery = textQuery.eq("agent", agent);
  if (type) textQuery = textQuery.eq("type", type);

  const { data, error } = await textQuery;

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const results = (data ?? []).map((m) => ({ ...m, similarity: null }));
  return NextResponse.json({ results });
}
