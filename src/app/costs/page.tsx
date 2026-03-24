import { supabaseAdmin } from "@/lib/supabase/admin";
import { CostsClient } from "@/components/costs/CostsClient";

export const dynamic = "force-dynamic";

export default async function CostsPage() {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  // Monday of current week
  const dayOfWeek = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const weekStart = monday.toISOString().split("T")[0];

  // 1st of current month
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;

  // 30 days ago
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);
  const thirtyDaysStr = thirtyDaysAgo.toISOString().split("T")[0];

  // Fetch all usage data for the last 30 days
  const { data: usageData } = await supabaseAdmin
    .from("usage_logs")
    .select("agent, date, model, input_tokens, output_tokens, cost_usd")
    .gte("date", thirtyDaysStr)
    .order("date", { ascending: true });

  const rows = usageData ?? [];

  // Calculate summary stats
  const todayTotal = rows
    .filter((r) => r.date === todayStr)
    .reduce((sum, r) => sum + Number(r.cost_usd), 0);

  const weekTotal = rows
    .filter((r) => r.date >= weekStart)
    .reduce((sum, r) => sum + Number(r.cost_usd), 0);

  const monthTotal = rows
    .filter((r) => r.date >= monthStart)
    .reduce((sum, r) => sum + Number(r.cost_usd), 0);

  // Aggregate by date + agent for chart
  const dailyByAgent: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    if (!dailyByAgent[row.date]) dailyByAgent[row.date] = {};
    dailyByAgent[row.date][row.agent] = (dailyByAgent[row.date][row.agent] || 0) + Number(row.cost_usd);
  }

  // Aggregate by agent for breakdown table
  const agentTotals: Record<string, { input: number; output: number; cost: number }> = {};
  for (const row of rows.filter((r) => r.date >= monthStart)) {
    if (!agentTotals[row.agent]) agentTotals[row.agent] = { input: 0, output: 0, cost: 0 };
    agentTotals[row.agent].input += Number(row.input_tokens);
    agentTotals[row.agent].output += Number(row.output_tokens);
    agentTotals[row.agent].cost += Number(row.cost_usd);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">💰 Costs</h1>
      <p className="mt-1 text-sm text-gray-500">
        Token usage and spend per agent
      </p>
      <div className="mt-6">
        <CostsClient
          todayTotal={todayTotal}
          weekTotal={weekTotal}
          monthTotal={monthTotal}
          dailyByAgent={dailyByAgent}
          agentTotals={agentTotals}
        />
      </div>
    </div>
  );
}
