"use client";

import type { IntelInboxListItem } from "@/lib/intel-inbox";

function formatScore(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

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
        <p className="mt-1 text-xs text-gray-500">Título, resumen breve, lote reciente, score y fecha.</p>
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
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-medium text-white">{item.title}</div>
                    {item.isLatestRun ? (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-200">
                        Latest run
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-400">
                    {item.miniDescription || "No summary yet"}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs font-semibold text-white">Score {formatScore(item.overallScore)}</div>
                  <div className="mt-1 text-[11px] text-gray-500">{formatDate(item.createdAt)}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
