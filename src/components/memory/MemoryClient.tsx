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

const TYPES = [
  { id: "all", name: "All" },
  { id: "journal", name: "Journal" },
  { id: "strategic", name: "Strategic" },
  { id: "report", name: "Report" },
];

export function MemoryClient({ initialEntries }: { initialEntries: MemoryEntry[] }) {
  const [agentFilter, setAgentFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null);
  const [searching, setSearching] = useState(false);

  const filtered = initialEntries.filter((entry) => {
    if (agentFilter !== "all" && entry.agent !== agentFilter) return false;
    if (typeFilter !== "all" && entry.type !== typeFilter) return false;
    if (dateFrom && entry.date < dateFrom) return false;
    if (dateTo && entry.date > dateTo) return false;
    return true;
  });

  const displayEntries = searchResults ?? filtered;

  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          agent: agentFilter !== "all" ? agentFilter : undefined,
          type: typeFilter !== "all" ? typeFilter : undefined,
          limit: 20,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results ?? []);
      }
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchResults(null);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">Memory</h1>
      <p className="mt-2 text-gray-400">
        Browse agent memory logs and session history.
      </p>

      {/* Search */}
      <div className="mt-6 flex gap-2">
        <input
          type="text"
          placeholder="Semantic search across memories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={searching}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search"}
        </button>
        {searchResults && (
          <button
            onClick={clearSearch}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition hover:bg-white/5 hover:text-white"
          >
            Clear
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
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

        {/* Type filter tabs */}
        <div className="flex rounded-lg border border-gray-700 bg-[#1a1a24]">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTypeFilter(t.id)}
              className={`px-3 py-1.5 text-sm transition ${
                typeFilter === t.id
                  ? "bg-white/10 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>

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

        {(agentFilter !== "all" || typeFilter !== "all" || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setAgentFilter("all");
              setTypeFilter("all");
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
        {searchResults ? `${displayEntries.length} search result` : `${displayEntries.length} entr`}
        {searchResults
          ? displayEntries.length !== 1 ? "s" : ""
          : displayEntries.length !== 1 ? "ies" : "y"}
      </p>

      {/* Memory Feed */}
      {displayEntries.length === 0 ? (
        <p className="mt-6 text-gray-500">
          {searchResults
            ? "No results found. Try a different query."
            : "No memory entries yet. Agent memory logs will appear here as agents write their daily journals."}
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {displayEntries.map((entry) => (
            <MemoryEntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
