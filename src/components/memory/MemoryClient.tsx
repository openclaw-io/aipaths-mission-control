"use client";

import { useState } from "react";
import type { MemoryEntry } from "@/app/memory/page";
import { MemoryEntryCard } from "./MemoryEntry";

const AGENTS = [
  { id: "all", name: "All Agents" },
  { id: "strategist", name: "Strategist" },
  { id: "youtube", name: "YouTube" },
  { id: "content", name: "Content" },
  { id: "marketing", name: "Marketing" },
  { id: "dev", name: "Dev" },
  { id: "community", name: "Community" },
  { id: "editor", name: "Editor" },
  { id: "legal", name: "Legal" },
];

export function MemoryClient({ initialEntries }: { initialEntries: MemoryEntry[] }) {
  const [agentFilter, setAgentFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filtered = initialEntries.filter((entry) => {
    if (agentFilter !== "all" && entry.agent !== agentFilter) return false;
    if (dateFrom && entry.date < dateFrom) return false;
    if (dateTo && entry.date > dateTo) return false;
    return true;
  });

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🧠 Memory</h1>
      <p className="mt-2 text-gray-400">
        Browse agent memory logs and session history.
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {AGENTS.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {(agentFilter !== "all" || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setAgentFilter("all");
              setDateFrom("");
              setDateTo("");
            }}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition hover:bg-white/5 hover:text-white"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Entry count */}
      <p className="mt-4 text-sm text-gray-500">
        {filtered.length} entr{filtered.length !== 1 ? "ies" : "y"}
      </p>

      {/* Memory Feed */}
      {filtered.length === 0 ? (
        <p className="mt-6 text-gray-500">
          No memory entries yet. Agent memory logs will appear here as agents write their daily journals.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {filtered.map((entry) => (
            <MemoryEntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
