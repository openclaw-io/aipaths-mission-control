"use client";

import type { IntelInboxListItem } from "@/lib/intel-inbox";

export function IntelInboxList({
  items,
  selectedId,
  onSelect,
  loading,
}: {
  items: IntelInboxListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-[#111118] p-6 text-sm text-gray-400">
        Loading intel inbox...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-[#111118] p-8 text-center">
        <p className="text-lg text-gray-400">Inbox empty</p>
        <p className="mt-1 text-sm text-gray-600">No intel items match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-800 bg-[#111118]">
      <div className="border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">Intel items</h2>
        <p className="mt-1 text-xs text-gray-500">Scan titles, open one, and decide from detail.</p>
      </div>
      <div className="max-h-[72vh] overflow-y-auto">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`w-full border-b border-gray-800 px-4 py-4 text-left transition last:border-b-0 ${
                selected ? "bg-blue-500/10" : "hover:bg-white/5"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{item.title}</div>
                  <div className="mt-1 line-clamp-1 text-xs text-gray-400">{item.summary || "No summary yet"}</div>
                </div>
                <div className="shrink-0 rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300">
                  {item.lane || item.promoteType || "intel"}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                <span className="rounded-full bg-white/5 px-2 py-0.5">score {item.overallScore}</span>
                <span>{item.promoteOwner || item.suggestedOwner || "unassigned"}</span>
                <span>·</span>
                <span>{item.promoteType || "doc"}</span>
                <span>·</span>
                <span>{item.reviewStatus}</span>
                <span>·</span>
                <span>{new Date(item.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
