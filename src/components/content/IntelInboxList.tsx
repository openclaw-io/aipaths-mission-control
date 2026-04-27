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

const SOURCE_THEMES = {
  youtube: {
    label: "YouTube",
    row: "border-l-red-400/80 bg-red-500/[0.045] hover:bg-red-500/[0.08]",
    selected: "border-l-red-300 bg-red-500/12",
    chip: "border-red-400/30 bg-red-500/10 text-red-100",
  },
  reddit: {
    label: "Reddit",
    row: "border-l-orange-400/80 bg-orange-500/[0.045] hover:bg-orange-500/[0.08]",
    selected: "border-l-orange-300 bg-orange-500/12",
    chip: "border-orange-400/30 bg-orange-500/10 text-orange-100",
  },
  web: {
    label: "Web",
    row: "border-l-sky-400/80 bg-sky-500/[0.04] hover:bg-sky-500/[0.075]",
    selected: "border-l-sky-300 bg-sky-500/12",
    chip: "border-sky-400/30 bg-sky-500/10 text-sky-100",
  },
  producthunt: {
    label: "Product Hunt",
    row: "border-l-purple-400/80 bg-purple-500/[0.045] hover:bg-purple-500/[0.08]",
    selected: "border-l-purple-300 bg-purple-500/12",
    chip: "border-purple-400/30 bg-purple-500/10 text-purple-100",
  },
  github: {
    label: "GitHub",
    row: "border-l-emerald-400/80 bg-emerald-500/[0.04] hover:bg-emerald-500/[0.075]",
    selected: "border-l-emerald-300 bg-emerald-500/12",
    chip: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  },
  hackernews: {
    label: "HN",
    row: "border-l-amber-400/80 bg-amber-500/[0.04] hover:bg-amber-500/[0.075]",
    selected: "border-l-amber-300 bg-amber-500/12",
    chip: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  },
  other: {
    label: "Fuente",
    row: "border-l-gray-600 bg-white/[0.015] hover:bg-white/[0.05]",
    selected: "border-l-gray-400 bg-white/10",
    chip: "border-gray-600 bg-white/5 text-gray-300",
  },
} as const;

function getSourceTheme(item: IntelInboxListItem) {
  return SOURCE_THEMES[item.sourceKind] || SOURCE_THEMES.other;
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
          const sourceTheme = getSourceTheme(item);
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`w-full border-b border-l-4 border-b-gray-800 px-4 py-4 text-left transition last:border-b-0 ${
                selected ? sourceTheme.selected : sourceTheme.row
              }`}
            >
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="min-w-0 max-w-full truncate text-sm font-medium text-white">{item.title}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${sourceTheme.chip}`}>
                      {sourceTheme.label}
                    </span>
                    {item.isLatestRun ? (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-200">
                        Latest run
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 line-clamp-2 max-w-full text-xs leading-5 text-gray-400">
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
