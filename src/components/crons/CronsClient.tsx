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

interface CronLog {
  id: string;
  cron_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  rows_affected: number | null;
  message: string | null;
}

interface CronsClientProps {
  crons: CronRow[];
  logs: CronLog[];
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
];

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function CronsClient({ crons, logs }: CronsClientProps) {
  const [activeTab, setActiveTab] = useState("all");
  const [selectedCrons, setSelectedCrons] = useState<Set<string>>(new Set());
  const [visibleLogs, setVisibleLogs] = useState(30);

  // Filter crons by tab
  const filteredCrons = activeTab === "all"
    ? crons
    : crons.filter((c) => c.category === activeTab);

  // Parse schedule to frequency rank (lower = more frequent = higher in list)
  function scheduleRank(schedule: string): number {
    const s = schedule.toLowerCase();
    if (s.includes("always")) return 0;
    if (s.includes("disabled")) return 99999;
    // Extract number from "every N min/hour/etc"
    const minMatch = s.match(/(\d+)\s*min/);
    if (minMatch) return parseInt(minMatch[1]);
    const hourMatch = s.match(/(\d+)\s*hour/);
    if (hourMatch) return parseInt(hourMatch[1]) * 60;
    if (s.includes("hourly")) return 60;
    if (s.includes("daily")) return 1440;
    if (s.includes("weekly")) return 10080;
    return 1000;
  }

  // Sort crons: errors first, then by frequency (most frequent first)
  const sortedCrons = [...filteredCrons].sort((a, b) => {
    if (a.last_status === "error" && b.last_status !== "error") return -1;
    if (a.last_status !== "error" && b.last_status === "error") return 1;
    return scheduleRank(a.schedule) - scheduleRank(b.schedule);
  });

  // Filter logs: by tab category AND selected crons
  const tabCronNames = new Set(filteredCrons.map((c) => c.cron_name));
  const filteredLogs = logs.filter((log) => {
    // Must be in current tab's crons
    if (!tabCronNames.has(log.cron_name)) return false;
    // If specific crons selected, filter by those
    if (selectedCrons.size > 0 && !selectedCrons.has(log.cron_name)) return false;
    return true;
  });

  // Summary stats
  const healthy = filteredCrons.filter((c) => c.last_status === "ok").length;
  const errors = filteredCrons.filter((c) => c.last_status === "error").length;
  const unknown = filteredCrons.filter((c) => c.last_status === "unknown").length;

  const tabCounts: Record<string, number> = {
    all: crons.length,
    scheduled: crons.filter((c) => c.category === "scheduled").length,
    heartbeats: crons.filter((c) => c.category === "heartbeats").length,
  };

  function handleTabChange(tabId: string) {
    setActiveTab(tabId);
    setSelectedCrons(new Set());
    setVisibleLogs(30);
  }

  function toggleCron(cronName: string) {
    setSelectedCrons((prev) => {
      const next = new Set(prev);
      if (next.has(cronName)) {
        next.delete(cronName);
      } else {
        next.add(cronName);
      }
      return next;
    });
  }

  const summaryItems = [
    { label: "Total", value: String(filteredCrons.length), color: "text-white" },
    { label: "Healthy", value: String(healthy), color: "text-green-400", dot: "bg-green-500" },
    { label: "Errors", value: String(errors), color: "text-red-400", dot: "bg-red-500" },
    { label: "Unknown", value: String(unknown), color: "text-gray-400", dot: "bg-gray-500" },
  ];

  return (
    <>
      {/* Tabs */}
      <div className="mt-6 flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
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

      {/* Two Column Layout: Crons + Logs */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Left: Cron List */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Crons {selectedCrons.size > 0 && `(${selectedCrons.size} selected)`}
          </h2>
          {sortedCrons.length === 0 ? (
            <p className="text-gray-500">No crons in this category.</p>
          ) : (
            <div className="space-y-2">
              {sortedCrons.map((cron) => {
                const isSelected = selectedCrons.has(cron.cron_name);
                return (
                  <div
                    key={cron.id}
                    onClick={() => toggleCron(cron.cron_name)}
                    className={`cursor-pointer rounded-lg border bg-[#111118] transition ${
                      isSelected
                        ? "border-blue-500 ring-1 ring-blue-500/50"
                        : "border-gray-800 hover:border-gray-600"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span
                        className={`h-3 w-3 shrink-0 rounded-full ${STATUS_DOT[cron.last_status] ?? "bg-gray-500"}`}
                      />
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
                      <div className="text-xs text-gray-400">
                        {cron.last_run_at ? timeAgo(cron.last_run_at) : "Never"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Logs */}
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Logs ({filteredLogs.length})
          </h2>
          {filteredLogs.length === 0 ? (
            <p className="text-gray-500">
              {logs.length === 0
                ? "No logs yet. Logs will appear once crons start reporting."
                : "No logs match the current filter."}
            </p>
          ) : (
            <>
            <div className="space-y-1.5">
              {filteredLogs.slice(0, visibleLogs).map((log) => (
                <div
                  key={log.id}
                  className={`rounded-lg border bg-[#111118] px-4 py-2.5 ${
                    log.status === "error"
                      ? "border-red-500/30"
                      : "border-gray-800"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        log.status === "ok" ? "bg-green-500" : "bg-red-500"
                      }`}
                    />
                    <span className="font-medium text-white text-sm">
                      {log.cron_name}
                    </span>
                    <span className="text-xs text-gray-500">
                      {formatTime(log.started_at)}
                    </span>
                    <span className="text-xs text-gray-500">
                      {formatDuration(log.duration_ms)}
                    </span>
                    {log.rows_affected ? (
                      <span className="text-xs text-gray-500">
                        {log.rows_affected} rows
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-gray-500">
                      {timeAgo(log.started_at)}
                    </span>
                  </div>
                  {log.message && (
                    <p className="mt-1 text-xs text-gray-400 pl-5">
                      {log.message}
                    </p>
                  )}
                  {log.status === "error" && log.error && (
                    <p className="mt-1 text-xs text-red-400 pl-5">
                      {log.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {filteredLogs.length > visibleLogs && (
              <button
                onClick={() => setVisibleLogs((v) => v + 30)}
                className="mt-3 w-full rounded-lg border border-gray-800 bg-[#111118] py-2 text-sm text-gray-400 hover:text-white hover:border-gray-600 transition"
              >
                Load more ({filteredLogs.length - visibleLogs} remaining)
              </button>
            )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
