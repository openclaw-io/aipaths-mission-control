import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { calculateCost } from "@/lib/model-pricing";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  const key = process.env.AGENT_API_KEY;
  if (!key) return false;
  return !!token && token === key;
}

/**
 * POST /api/agent/usage
 * Agents self-report their token usage per task.
 * Cost calculated server-side from model pricing.
 */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { agent, model, input_tokens, output_tokens, task_id } = body;

  if (!agent || !model) {
    return NextResponse.json({ error: "agent and model required" }, { status: 400 });
  }

  const cost = calculateCost(model, input_tokens || 0, output_tokens || 0);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("usage_logs")
    .insert({
      agent,
      date: new Date().toISOString().split("T")[0],
      model,
      input_tokens: input_tokens || 0,
      output_tokens: output_tokens || 0,
      cost_usd: Number(cost.toFixed(4)),
      task_id: task_id || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cost_usd: Number(cost.toFixed(4)), id: data.id });
}
