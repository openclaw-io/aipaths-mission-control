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

  const supabase = createServiceClient();

  let query = supabase
    .from("memories")
    .select("id, agent, type, title, content, tags, date, created_at, updated_at")
    .order("date", { ascending: false })
    .limit(limit);

  if (agent) query = query.eq("agent", agent);
  if (type) query = query.eq("type", type);
  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data, error } = await query;

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ memories: data });
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

  const supabase = createServiceClient();
  const memoryDate = date || new Date().toISOString().split("T")[0];

  // For journal type, upsert by (agent, date, type) — append content if exists
  if (type === "journal") {
    const { data: existing } = await supabase
      .from("memories")
      .select("id, content")
      .eq("agent", agent)
      .eq("type", "journal")
      .eq("date", memoryDate)
      .maybeSingle();

    if (existing) {
      const merged = existing.content + "\n\n" + content;
      const embedding = await generateEmbedding(merged);

      const { data, error } = await supabase
        .from("memories")
        .update({
          content: merged,
          title: title || undefined,
          tags: tags || undefined,
          embedding,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (error)
        return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json(data);
    }
  }

  // Insert new memory
  const embedding = await generateEmbedding(content);

  const { data, error } = await supabase
    .from("memories")
    .insert({
      agent,
      type,
      title: title || null,
      content,
      tags: tags || [],
      date: memoryDate,
      embedding,
    })
    .select()
    .single();

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
