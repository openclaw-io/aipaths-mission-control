import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

/**
 * GET /api/agent/tasks?agent=dev&status=new
 * List tasks for an agent. Defaults to status=new (ready tasks).
 */
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const agent = req.nextUrl.searchParams.get("agent");
  if (!agent) return NextResponse.json({ error: "agent param required" }, { status: 400 });

  const status = req.nextUrl.searchParams.get("status") || "new";
  const supabase = createServiceClient();

  let query = supabase
    .from("agent_tasks")
    .select("id, title, instruction, agent, status, priority, depends_on, scheduled_for, tags, created_at, assignee, error, result")
    .eq("agent", agent);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data });
}

/**
 * POST /api/agent/tasks
 * Create a new task (agent creating task for another agent or self).
 */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { title, instruction, agent, created_by, depends_on, scheduled_for, tags, priority, assignee } = body;

  if (!title || !agent) {
    return NextResponse.json({ error: "title and agent required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const status = depends_on ? "blocked" : "new";

  const { data, error } = await supabase
    .from("agent_tasks")
    .insert({
      title,
      instruction: instruction || null,
      agent,
      created_by: created_by || "agent",
      status,
      priority: priority || "medium",
      depends_on: depends_on || null,
      scheduled_for: scheduled_for || null,
      tags: tags || [],
      assignee: assignee || null,
      task_type: scheduled_for ? "scheduled" : "auto",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
