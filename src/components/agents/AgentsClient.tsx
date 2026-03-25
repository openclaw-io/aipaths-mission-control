"use client";

import { AGENTS } from "@/lib/agents";
import type { AgentStats } from "@/app/agents/page";
import { AgentSessionBadge } from "./AgentSessionBadge";
import { timeAgo } from "@/lib/utils";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function MiniChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-[2px] h-8">
      {data.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-blue-500/60 transition-all"
          style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? "2px" : "0" }}
          title={`${v} tasks`}
        />
      ))}
    </div>
  );
}

export function AgentsClient({ agentStats }: { agentStats: Record<string, AgentStats> }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {AGENTS.map((agent) => {
        const stats = agentStats[agent.id];
        if (!stats) return null;

        const successColor = stats.successRate >= 90
          ? "text-green-400"
          : stats.successRate >= 70
          ? "text-yellow-400"
          : "text-red-400";

        return (
          <div
            key={agent.id}
            className="rounded-xl border border-gray-800 bg-[#111118] p-5 hover:border-gray-700 transition"
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-2xl">{agent.emoji}</span>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-white">{agent.name}</h3>
                <p className="text-xs text-gray-500 truncate">{agent.role}</p>
              </div>
              <span className={`text-sm font-bold ${successColor}`}>
                {stats.successRate}%
              </span>
            </div>

            {/* Session status */}
            <AgentSessionBadge agentId={agent.id} />

            {/* Stats grid */}
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-gray-800 pt-3">
              <div>
                <p className="text-xs text-gray-600">Tasks</p>
                <p className="text-sm font-medium text-white">{stats.doneTasks}<span className="text-gray-600">/{stats.totalTasks}</span></p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Cost</p>
                <p className="text-sm font-medium text-white">${fmt(stats.totalCost)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Tokens</p>
                <p className="text-sm font-medium text-white">{fmtTokens(stats.totalTokens)}</p>
              </div>
            </div>

            {/* Mini chart */}
            <div className="mt-3 border-t border-gray-800 pt-3">
              <p className="text-xs text-gray-600 mb-1">Last 7 days</p>
              <MiniChart data={stats.last7Days} />
            </div>

            {/* Last activity */}
            {stats.lastActivityAt && (
              <p className="mt-2 text-xs text-gray-600">
                Last seen {timeAgo(stats.lastActivityAt)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
