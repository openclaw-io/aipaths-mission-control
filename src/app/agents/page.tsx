import { supabaseAdmin } from "@/lib/supabase/admin";
import { AGENTS } from "@/lib/agents";
import { AgentsClient } from "@/components/agents/AgentsClient";

export const dynamic = "force-dynamic";

export interface AgentStats {
  totalTasks: number;
  doneTasks: number;
  failedTasks: number;
  successRate: number;
  totalCost: number;
  avgCostPerTask: number;
  totalTokens: number;
  last7Days: number[]; // 7 elements, tasks per day (oldest→newest)
  lastActivityAt: string | null;
}

export default async function AgentsPage() {
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 6);

  // Fetch all data in bulk
  const [tasksRes, usageRes, activityRes] = await Promise.all([
    supabaseAdmin
      .from("agent_tasks")
      .select("agent, status, created_at")
      .not("tags", "cs", '{"epic"}')
      .not("tags", "cs", '{"project"}'),
    supabaseAdmin
      .from("usage_logs")
      .select("agent, cost_usd, input_tokens, output_tokens"),
    supabaseAdmin
      .from("activity_log")
      .select("agent, created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const allTasks = tasksRes.data || [];
  const allUsage = usageRes.data || [];
  const allActivity = activityRes.data || [];

  // Build per-agent stats
  const agentStats: Record<string, AgentStats> = {};

  for (const agent of AGENTS) {
    const tasks = allTasks.filter((t) => t.agent === agent.id);
    const done = tasks.filter((t) => t.status === "done").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const successRate = done + failed > 0 ? Math.round((done / (done + failed)) * 100) : 100;

    const usage = allUsage.filter((u) => u.agent === agent.id);
    const totalCost = usage.reduce((s, u) => s + Number(u.cost_usd), 0);
    const totalTokens = usage.reduce((s, u) => s + Number(u.input_tokens) + Number(u.output_tokens), 0);
    const avgCostPerTask = done > 0 ? totalCost / done : 0;

    // Last 7 days activity (tasks created per day)
    const last7Days: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(sevenDaysAgo.getDate() + i);
      const dateStr = d.toISOString().split("T")[0];
      const count = tasks.filter((t) => t.created_at?.startsWith(dateStr)).length;
      last7Days.push(count);
    }

    // Last activity
    const lastAct = allActivity.find((a) => a.agent === agent.id);

    agentStats[agent.id] = {
      totalTasks: tasks.length,
      doneTasks: done,
      failedTasks: failed,
      successRate,
      totalCost,
      avgCostPerTask,
      totalTokens,
      last7Days,
      lastActivityAt: lastAct?.created_at || null,
    };
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">🤖 Agents</h1>
      <p className="mt-1 text-sm text-gray-500">Performance and activity per agent</p>
      <div className="mt-6">
        <AgentsClient agentStats={agentStats} />
      </div>
    </div>
  );
}
