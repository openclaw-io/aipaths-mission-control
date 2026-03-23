"use client";

import { useState } from "react";
import type { MemoryEntry } from "@/app/memory/page";
import { timeAgo } from "@/lib/utils";
import { getAgentBadgeClass } from "@/lib/agents";

const TYPE_COLORS: Record<string, string> = {
  journal: "bg-sky-500/20 text-sky-400",
  strategic: "bg-amber-500/20 text-amber-400",
  report: "bg-emerald-500/20 text-emerald-400",
};

function renderMarkdown(text: string): string {
  // Escape HTML
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="my-2 rounded bg-black/30 p-3 text-xs overflow-x-auto"><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="rounded bg-black/30 px-1 py-0.5 text-xs">$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3 class="mt-3 mb-1 text-sm font-semibold text-white">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="mt-3 mb-1 text-base font-semibold text-white">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="mt-3 mb-1 text-lg font-bold text-white">$1</h1>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="text-white">$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Bullet lists
  html = html.replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-1 space-y-0.5">$1</ul>');

  // Line breaks (double newline = paragraph break)
  html = html.replace(/\n\n/g, '<br/><br/>');
  html = html.replace(/\n/g, '<br/>');

  return html;
}

export function MemoryEntryCard({ entry }: { entry: MemoryEntry }) {
  const [expanded, setExpanded] = useState(false);

  const agentBadge = getAgentBadgeClass(entry.agent);
  const typeBadge = TYPE_COLORS[entry.type] ?? "bg-gray-500/20 text-gray-400";

  const plainPreview =
    entry.content?.length > 200
      ? entry.content.slice(0, 200) + "..."
      : entry.content;
  const isLong = entry.content?.length > 200;

  return (
    <div className="rounded-lg border border-gray-800 bg-[#111118]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${agentBadge}`}>
            {entry.agent}
          </span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${typeBadge}`}>
            {entry.type}
          </span>
          {entry.title && (
            <span className="text-sm font-medium text-white">{entry.title}</span>
          )}
          <span className="text-xs text-gray-500">{entry.date}</span>
          <span className="text-xs text-gray-600">{timeAgo(entry.created_at)}</span>
          {entry.similarity != null && (
            <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-xs text-blue-400">
              {(entry.similarity * 100).toFixed(0)}% match
            </span>
          )}
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

        {/* Tags */}
        {entry.tags && entry.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-gray-700/50 px-1.5 py-0.5 text-[10px] text-gray-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {!expanded && (
          <p className="mt-2 text-sm text-gray-300">{plainPreview}</p>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3">
          <div
            className="text-sm text-gray-300 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }}
          />
        </div>
      )}
    </div>
  );
}
