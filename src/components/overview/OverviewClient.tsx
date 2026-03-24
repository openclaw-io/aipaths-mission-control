"use client";

import { ActivityFeed } from "@/components/ActivityFeed";
import type { ActivityEvent } from "@/hooks/useRealtimeActivity";
import { timeAgo } from "@/lib/utils";

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Props {
  todayCost: number;
  dailyBudget: number;
  budgetPct: number;
  tasksDoneToday: number;
  activeAgents: string[];
  cronOk: number;
  cronError: number;
  cronTotal: number;
  projectProgress: Array<{ id: string; title: string; done: number; total: number }>;
  failedTasks: Array<{ id: string; title: string; agent: string; completed_at: string; error: string | null }>;
  errorCrons: Array<{ name: string; error: string | null; lastRun: string | null }>;
  initialActivity: ActivityEvent[];
}

export function OverviewClient({
  todayCost, dailyBudget, budgetPct,
  tasksDoneToday, activeAgents,
  cronOk, cronError, cronTotal,
  projectProgress, failedTasks, errorCrons,
  initialActivity,
}: Props) {
  const hasAlerts = failedTasks.length > 0 || errorCrons.length > 0 || budgetPct > 80;

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📊 Overview</h1>
      <p className="mt-1 text-sm text-gray-500">Your agent system at a glance</p>

      {/* Summary Cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* Cost Today */}
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">💰 Cost Today</p>
          <p className="mt-2 text-2xl font-bold text-white">${fmt(todayCost)}</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div
                className={`h-full transition-all ${budgetPct > 80 ? "bg-red-500" : budgetPct > 50 ? "bg-yellow-500" : "bg-green-500"}`}
                style={{ width: `${Math.min(budgetPct, 100)}%` }}
              />
            </div>
            <span className="text-xs text-gray-600">${fmt(dailyBudget)}</span>
          </div>
        </div>

        {/* Tasks Done */}
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">✅ Done Today</p>
          <p className="mt-2 text-2xl font-bold text-white">{tasksDoneToday}</p>
          <p className="mt-1 text-xs text-gray-600">tasks completed</p>
        </div>

        {/* Active Agents */}
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">🤖 Active Now</p>
          <p className="mt-2 text-2xl font-bold text-white">{activeAgents.length}</p>
          <div className="mt-1 flex gap-1">
            {activeAgents.map((a) => (
              <span key={a} className="text-sm" title={a}>{AGENT_EMOJI[a] || "🤖"}</span>
            ))}
            {activeAgents.length === 0 && <span className="text-xs text-gray-600">all idle</span>}
          </div>
        </div>

        {/* Cron Health */}
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">🕐 Crons</p>
          <p className="mt-2 text-2xl font-bold text-white">
            {cronOk}<span className="text-gray-600">/{cronTotal}</span>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${cronError > 0 ? "bg-red-500" : "bg-green-500"}`} />
            <span className="text-xs text-gray-600">
              {cronError > 0 ? `${cronError} error${cronError > 1 ? "s" : ""}` : "all healthy"}
            </span>
          </div>
        </div>
      </div>

      {/* Middle: Activity + Alerts */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Activity Feed (2/3 width) */}
        <div className="lg:col-span-2 rounded-xl border border-gray-800 bg-[#111118] p-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">⚡ Live Activity</h2>
          <ActivityFeed initialEvents={initialActivity} />
        </div>

        {/* Alerts (1/3 width) */}
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            🔔 Alerts
          </h2>
          {!hasAlerts ? (
            <div className="flex items-center gap-2 text-sm text-green-400 py-4 justify-center">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              All clear
            </div>
          ) : (
            <div className="space-y-2">
              {failedTasks.map((t) => (
                <div key={t.id} className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                  <p className="text-xs text-red-400 font-medium">{t.title}</p>
                  <p className="text-xs text-red-500/60 mt-0.5">
                    {AGENT_EMOJI[t.agent] || "🤖"} {t.agent} · {timeAgo(t.completed_at)}
                  </p>
                </div>
              ))}
              {errorCrons.map((c) => (
                <div key={c.name} className="rounded-lg border border-orange-500/20 bg-orange-500/5 px-3 py-2">
                  <p className="text-xs text-orange-400 font-medium">{c.name}</p>
                  <p className="text-xs text-orange-500/60 mt-0.5 line-clamp-1">{c.error || "error"}</p>
                </div>
              ))}
              {budgetPct > 80 && (
                <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
                  <p className="text-xs text-yellow-400 font-medium">Budget Warning</p>
                  <p className="text-xs text-yellow-500/60 mt-0.5">
                    {budgetPct.toFixed(0)}% of daily budget used (${fmt(todayCost)} / ${fmt(dailyBudget)})
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Active Projects */}
      {projectProgress.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">📐 Active Projects</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {projectProgress.map((p) => {
              const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
              return (
                <div key={p.id} className="rounded-xl border border-gray-800 bg-[#111118] px-4 py-3">
                  <p className="text-sm font-medium text-white truncate">{p.title}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                      <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-500">{p.done}/{p.total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
