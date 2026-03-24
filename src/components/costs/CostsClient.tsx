"use client";

const AGENT_COLORS: Record<string, string> = {
  dev: "#3b82f6",
  strategist: "#8b5cf6",
  youtube: "#ef4444",
  content: "#f59e0b",
  marketing: "#10b981",
  community: "#06b6d4",
  editor: "#a855f7",
  legal: "#f97316",
  gonza: "#ec4899",
};

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// --- Summary Cards ---
function SummaryCards({ today, week, month }: { today: number; week: number; month: number }) {
  const cards = [
    { label: "Today", value: today, emoji: "💰" },
    { label: "This Week", value: week, emoji: "📅" },
    { label: "This Month", value: month, emoji: "📆" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      {cards.map(({ label, value, emoji }) => (
        <div key={label} className="rounded-xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-xs text-gray-500 uppercase tracking-wider">{emoji} {label}</p>
          <p className="mt-2 text-2xl font-bold text-white">${fmt(value)}</p>
        </div>
      ))}
    </div>
  );
}

// --- Daily Cost Bar Chart (CSS only) ---
function DailyChart({ dailyByAgent }: { dailyByAgent: Record<string, Record<string, number>> }) {
  // Generate last 30 days
  const days: string[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split("T")[0]);
  }

  // Collect all agents
  const allAgents = new Set<string>();
  for (const agents of Object.values(dailyByAgent)) {
    for (const agent of Object.keys(agents)) allAgents.add(agent);
  }
  const agents = [...allAgents].sort();

  // Find max daily total for scaling
  let maxTotal = 0;
  for (const day of days) {
    const total = Object.values(dailyByAgent[day] || {}).reduce((s, v) => s + v, 0);
    if (total > maxTotal) maxTotal = total;
  }
  if (maxTotal === 0) maxTotal = 1; // Avoid division by zero

  return (
    <div className="rounded-xl border border-gray-800 bg-[#111118] p-5 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Daily Cost (Last 30 Days)
      </h2>

      {/* Chart area */}
      <div className="flex items-end gap-[2px] h-40">
        {days.map((day, i) => {
          const agentCosts = dailyByAgent[day] || {};
          const dayTotal = Object.values(agentCosts).reduce((s, v) => s + v, 0);
          const heightPct = (dayTotal / maxTotal) * 100;

          return (
            <div
              key={day}
              className="flex-1 flex flex-col justify-end group relative"
              style={{ height: "100%" }}
            >
              {/* Tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                <div className="rounded bg-gray-900 border border-gray-700 px-2 py-1 text-xs whitespace-nowrap shadow-lg">
                  <p className="text-gray-300 font-medium">{day.slice(5)}</p>
                  <p className="text-white">${fmt(dayTotal)}</p>
                </div>
              </div>

              {/* Stacked bar */}
              <div className="w-full rounded-t-sm overflow-hidden" style={{ height: `${heightPct}%` }}>
                {agents.map((agent) => {
                  const cost = agentCosts[agent] || 0;
                  if (cost === 0) return null;
                  const segPct = (cost / dayTotal) * 100;
                  return (
                    <div
                      key={agent}
                      style={{
                        height: `${segPct}%`,
                        backgroundColor: AGENT_COLORS[agent] || "#6b7280",
                      }}
                      title={`${agent}: $${fmt(cost)}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div className="flex gap-[2px] mt-1">
        {days.map((day, i) => (
          <div key={day} className="flex-1 text-center">
            {i % 5 === 0 && (
              <span className="text-xs text-gray-600">{day.slice(5)}</span>
            )}
          </div>
        ))}
      </div>

      {/* Max value label */}
      <div className="flex justify-between mt-2">
        <span className="text-xs text-gray-600">$0</span>
        <span className="text-xs text-gray-600">${fmt(maxTotal)}</span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-gray-800">
        {agents.map((agent) => (
          <div key={agent} className="flex items-center gap-1.5">
            <div
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: AGENT_COLORS[agent] || "#6b7280" }}
            />
            <span className="text-xs text-gray-500">{AGENT_EMOJI[agent] || "🤖"} {agent}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Agent Breakdown Table ---
function BreakdownTable({
  agentTotals,
}: {
  agentTotals: Record<string, { input: number; output: number; cost: number }>;
}) {
  const entries = Object.entries(agentTotals).sort((a, b) => b[1].cost - a[1].cost);
  const grandTotal = entries.reduce((s, [, v]) => s + v.cost, 0);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-[#111118] p-8 text-center">
        <p className="text-gray-500">No usage data this month yet.</p>
        <p className="mt-1 text-xs text-gray-600">Run the usage sync to populate data.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-[#111118] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-left">
            <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Agent</th>
            <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Input Tokens</th>
            <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Output Tokens</th>
            <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Cost</th>
            <th className="px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([agent, data]) => (
            <tr key={agent} className="border-b border-gray-800/50 hover:bg-white/5">
              <td className="px-5 py-3 text-gray-300">
                <span className="mr-1.5">{AGENT_EMOJI[agent] || "🤖"}</span>
                {agent}
                <div
                  className="inline-block h-2 w-2 rounded-sm ml-2"
                  style={{ backgroundColor: AGENT_COLORS[agent] || "#6b7280" }}
                />
              </td>
              <td className="px-5 py-3 text-gray-400 text-right font-mono text-xs">{fmtTokens(data.input)}</td>
              <td className="px-5 py-3 text-gray-400 text-right font-mono text-xs">{fmtTokens(data.output)}</td>
              <td className="px-5 py-3 text-white text-right font-medium">${fmt(data.cost)}</td>
              <td className="px-5 py-3 text-gray-400 text-right">
                {grandTotal > 0 ? (data.cost / grandTotal * 100).toFixed(1) : "0.0"}%
              </td>
            </tr>
          ))}
          {/* Totals row */}
          <tr className="border-t border-gray-700 bg-[#0d0d14]">
            <td className="px-5 py-3 text-white font-semibold">Total</td>
            <td className="px-5 py-3 text-gray-300 text-right font-mono text-xs">
              {fmtTokens(entries.reduce((s, [, d]) => s + d.input, 0))}
            </td>
            <td className="px-5 py-3 text-gray-300 text-right font-mono text-xs">
              {fmtTokens(entries.reduce((s, [, d]) => s + d.output, 0))}
            </td>
            <td className="px-5 py-3 text-white text-right font-bold">${fmt(grandTotal)}</td>
            <td className="px-5 py-3 text-gray-400 text-right">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// --- Main Client Component ---
export function CostsClient({
  todayTotal,
  weekTotal,
  monthTotal,
  dailyByAgent,
  agentTotals,
}: {
  todayTotal: number;
  weekTotal: number;
  monthTotal: number;
  dailyByAgent: Record<string, Record<string, number>>;
  agentTotals: Record<string, { input: number; output: number; cost: number }>;
}) {
  return (
    <>
      <SummaryCards today={todayTotal} week={weekTotal} month={monthTotal} />
      <DailyChart dailyByAgent={dailyByAgent} />
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Agent Breakdown (This Month)
      </h2>
      <BreakdownTable agentTotals={agentTotals} />
    </>
  );
}
