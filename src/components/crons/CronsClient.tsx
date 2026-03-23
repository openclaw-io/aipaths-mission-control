"use client";

import { useState } from "react";
import { timeAgo } from "@/lib/utils";

interface CronRow {
  id: string;
  cron_name: string;
  schedule: string;
  description: string | null;
  last_run_at: string | null;
  last_status: string;
  last_duration_ms: number | null;
  last_error: string | null;
  rows_affected: number | null;
  category: string;
}

interface CronsClientProps {
  crons: CronRow[];
}

const STATUS_DOT: Record<string, string> = {
  ok: "bg-green-500",
  error: "bg-red-500",
  unknown: "bg-gray-500",
};

const TABS = [
  { id: "all", label: "All", emoji: "📋" },
  { id: "scheduled", label: "Scheduled", emoji: "⏰" },
  { id: "heartbeats", label: "Heartbeats", emoji: "💓" },
  { id: "services", label: "Services", emoji: "🔄" },
];

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function CronsClient({ crons }: CronsClientProps) {
  const [activeTab, setActiveTab] = useState("all");
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const filtered = activeTab === "all"
    ? crons
    : crons.filter((c) => c.category === activeTab);

  // Sort: errors first, then by last_run_at DESC
  const sorted = [...filtered].sort((a, b) => {
    if (a.last_status === "error" && b.last_status !== "error") return -1;
    if (a.last_status !== "error" && b.last_status === "error") return 1;
    const aTime = a.last_run_at ? new Date(a.last_run_at).getTime() : 0;
    const bTime = b.last_run_at ? new Date(b.last_run_at).getTime() : 0;
    return bTime - aTime;
  });

  const healthy = filtered.filter((c) => c.last_status === "ok").length;
  const errors = filtered.filter((c) => c.last_status === "error").length;
  const unknown = filtered.filter((c) => c.last_status === "unknown").length;

  const summaryItems = [
    { label: "Total", value: String(filtered.length), color: "text-white" },
    { label: "Healthy", value: String(healthy), color: "text-green-400", dot: "bg-green-500" },
    { label: "Errors", value: String(errors), color: "text-red-400", dot: "bg-red-500" },
    { label: "Unknown", value: String(unknown), color: "text-gray-400", dot: "bg-gray-500" },
  ];

  // Count per tab for badges
  const tabCounts: Record<string, number> = {
    all: crons.length,
    services: crons.filter((c) => c.category === "services").length,
    scheduled: crons.filter((c) => c.category === "scheduled").length,
    heartbeats: crons.filter((c) => c.category === "heartbeats").length,
  };

  return (
    <>
      {/* Tabs */}
      <div className="mt-6 flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === tab.id
                ? "bg-blue-600 text-white"
                : "bg-[#111118] text-gray-400 hover:bg-[#1a1a24] hover:text-white"
            }`}
          >
            {tab.emoji} {tab.label}
            <span className="ml-1.5 text-xs opacity-70">{tabCounts[tab.id]}</span>
          </button>
        ))}
      </div>

      {/* Summary Bar */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {summaryItems.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-gray-800 bg-[#111118] p-5"
          >
            <div className="flex items-center gap-2">
              {item.dot && (
                <span className={`h-3 w-3 rounded-full ${item.dot}`} />
              )}
              <span className={`text-3xl font-bold ${item.color}`}>
                {item.value}
              </span>
            </div>
            <div className="mt-1 text-sm text-gray-400">{item.label}</div>
          </div>
        ))}
      </div>

      {/* Cron List */}
      {sorted.length === 0 ? (
        <p className="mt-8 text-gray-500">
          No crons in this category.
        </p>
      ) : (
        <div className="mt-6 space-y-2">
          {sorted.map((cron) => (
            <div
              key={cron.id}
              className="rounded-lg border border-gray-800 bg-[#111118]"
            >
              <div
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
                  cron.last_status === "error" && cron.last_error ? "cursor-pointer" : ""
                }`}
                onClick={() => {
                  if (cron.last_status === "error" && cron.last_error) {
                    setExpandedError(expandedError === cron.id ? null : cron.id);
                  }
                }}
              >
                {/* Status dot */}
                <span
                  className={`h-3 w-3 shrink-0 rounded-full ${STATUS_DOT[cron.last_status] ?? "bg-gray-500"}`}
                />

                {/* Name + schedule */}
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-white">
                    {cron.cron_name}
                  </span>
                  <span className="ml-2 text-sm text-gray-500">
                    {cron.schedule}
                  </span>
                  {cron.description && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      {cron.description}
                    </p>
                  )}
                </div>

                {/* Metadata */}
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <div>
                    <span className="text-gray-500">Last run: </span>
                    <span className="text-gray-300">
                      {cron.last_run_at ? timeAgo(cron.last_run_at) : "Never"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Duration: </span>
                    <span className="text-gray-300">
                      {formatDuration(cron.last_duration_ms)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Rows: </span>
                    <span className="text-gray-300">
                      {cron.rows_affected ?? "—"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Error details (expandable) */}
              {cron.last_status === "error" && cron.last_error && expandedError === cron.id && (
                <div className="border-t border-red-500/20 bg-red-500/5 px-4 py-3">
                  <p className="text-sm text-red-400">{cron.last_error}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
