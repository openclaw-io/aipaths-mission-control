"use client";

import { useState } from "react";
import type { MemoryEntry } from "@/app/memory/page";
import { timeAgo } from "@/lib/utils";

const AGENT_COLORS: Record<string, string> = {
  strategist: "bg-purple-500/20 text-purple-400",
  youtube: "bg-red-500/20 text-red-400",
  content: "bg-green-500/20 text-green-400",
  marketing: "bg-orange-500/20 text-orange-400",
  dev: "bg-blue-500/20 text-blue-400",
  community: "bg-teal-500/20 text-teal-400",
  editor: "bg-pink-500/20 text-pink-400",
  legal: "bg-gray-500/20 text-gray-400",
};

export function MemoryEntryCard({ entry }: { entry: MemoryEntry }) {
  const [expanded, setExpanded] = useState(false);

  const badgeColor = AGENT_COLORS[entry.agent] ?? "bg-gray-500/20 text-gray-400";
  const preview = entry.content?.length > 200
    ? entry.content.slice(0, 200) + "..."
    : entry.content;
  const isLong = entry.content?.length > 200;

  return (
    <div className="rounded-lg border border-gray-800 bg-[#111118]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor}`}
          >
            {entry.agent}
          </span>
          <span className="text-xs text-gray-500">{entry.date}</span>
          <span className="text-xs text-gray-600">{timeAgo(entry.created_at)}</span>
          {isLong && (
            <svg
              className={`ml-auto h-4 w-4 shrink-0 text-gray-500 transition ${expanded ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </div>
        <p className="mt-2 text-sm text-gray-300">
          {expanded ? "" : preview}
        </p>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3">
          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-300">
            {entry.content}
          </pre>
        </div>
      )}
    </div>
  );
}
