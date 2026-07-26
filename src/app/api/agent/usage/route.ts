import { NextResponse, type NextRequest } from "next/server";
import { insertUsageLog } from "@/lib/db/mission-control";
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
  const costUsd = Number(cost.toFixed(4));

  try {
    const data = await insertUsageLog({
      agent,
      model,
      inputTokens: Number(input_tokens || 0),
      outputTokens: Number(output_tokens || 0),
      costUsd,
      taskId: task_id || null,
    });
    return NextResponse.json({ ok: true, cost_usd: costUsd, id: data.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_write_failed" }, { status: 500 });
  }
}
