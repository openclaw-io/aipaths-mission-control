"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IntelInboxDetail } from "./IntelInboxDetail";
import { IntelInboxList } from "./IntelInboxList";
import type { IntelInboxDetail as IntelInboxDetailType, IntelInboxHealth, IntelInboxListItem } from "@/lib/intel-inbox";

type DetailResponse = IntelInboxDetailType;
type ActionPayload = {
  comment?: string;
  destinations?: string[];
  ownerAgent?: string;
  collaborators?: string[];
};

export function ContentInboxClient({
  initialItems,
  initialTotal,
  initialStatusFilter,
  initialAssetFilter,
  initialOwnerFilter,
  initialIncludeOlderNew,
  health,
  filterSourceItems,
  initialSelectedId,
  initialDetail,
}: {
  initialItems: IntelInboxListItem[];
  initialTotal: number;
  initialStatusFilter: string;
  initialAssetFilter: string;
  initialOwnerFilter: string;
  initialIncludeOlderNew: boolean;
  health: IntelInboxHealth;
  filterSourceItems: IntelInboxListItem[];
  initialSelectedId: string | null;
  initialDetail: DetailResponse | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initializedRef = useRef(false);
  const [items, setItems] = useState<IntelInboxListItem[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [detail, setDetail] = useState<DetailResponse | null>(initialDetail);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [assetFilter, setAssetFilter] = useState(initialAssetFilter);
  const [ownerFilter, setOwnerFilter] = useState(initialOwnerFilter);
  const [includeOlderNew, setIncludeOlderNew] = useState(initialIncludeOlderNew);
  const [toast, setToast] = useState<string | null>(null);
  const [discardingIds, setDiscardingIds] = useState<Set<string>>(() => new Set());

  const assetOptions = useMemo(() => {
    return Array.from(new Set(filterSourceItems.map((item) => item.lane).filter(Boolean) as string[])).sort();
  }, [filterSourceItems]);

  const ownerOptions = useMemo(() => {
    return Array.from(new Set(filterSourceItems.map((item) => item.promoteOwner).filter(Boolean) as string[])).sort();
  }, [filterSourceItems]);

  useEffect(() => {
    setItems(initialItems);
    setTotal(initialTotal);
  }, [initialItems, initialTotal]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "new") params.set("status", statusFilter);
    if (assetFilter !== "all") params.set("primaryAssetType", assetFilter);
    if (ownerFilter !== "all") params.set("ownerAgent", ownerFilter);
    if (statusFilter === "new" && includeOlderNew) params.set("older", "1");

    const nextSearch = params.toString();
    const currentParams = new URLSearchParams(searchParams.toString());
    currentParams.delete("idea");
    const currentSearch = currentParams.toString();
    const next = nextSearch ? `${pathname}?${nextSearch}` : pathname;

    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }

    if (nextSearch === currentSearch) {
      setLoadingList(false);
      return;
    }

    setSelectedId(null);
    setDetail(null);
    setLoadingList(true);
    router.replace(next);
  }, [statusFilter, assetFilter, ownerFilter, includeOlderNew, router, pathname, searchParams]);

  useEffect(() => {
    setItems(initialItems);
    setTotal(initialTotal);
    setLoadingList(false);
  }, [initialItems, initialTotal]);

  useEffect(() => {
    if (!initialSelectedId || !initialDetail) return;
    setSelectedId(initialSelectedId);
    setDetail(initialDetail);
  }, [initialSelectedId, initialDetail]);

  useEffect(() => {
    if (!selectedId) {
      setLoadingDetail(false);
      return;
    }
    if (detail?.item?.id === selectedId) {
      setLoadingDetail(false);
      return;
    }

    const controller = new AbortController();
    setLoadingDetail(true);

    fetch(`/api/intel/inbox/${selectedId}`, { signal: controller.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load intel item");
        setDetail(json as DetailResponse);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[ContentInboxClient] Failed to load intel detail", error);
        setSelectedId(null);
        setDetail(null);
        setToast("Could not load intel detail");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });

    return () => controller.abort();
  }, [selectedId, detail?.item?.id]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function openDetail(id: string) {
    setSelectedId(id);
    setDetail((current) => current?.item?.id === id ? current : null);
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    const params = new URLSearchParams(window.location.search);
    if (params.has("idea")) {
      params.delete("idea");
      const next = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      window.history.replaceState(null, "", next);
    }
  }

  async function quickDiscard(id: string) {
    if (discardingIds.has(id)) return;
    setDiscardingIds((current) => new Set(current).add(id));
    try {
      const res = await fetch(`/api/intel/inbox/${id}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        setToast(json?.error || "Could not dismiss intel item");
        return;
      }
      setItems((current) => current.filter((item) => item.id !== id));
      setTotal((current) => Math.max(0, current - 1));
      if (selectedId === id) closeDetail();
      setToast("Intel dismissed");
      router.refresh();
    } finally {
      setDiscardingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleAction(action: "promote" | "park" | "discard", payload?: ActionPayload) {
    if (!selectedId) return;
    const endpoint = `/api/intel/inbox/${selectedId}/${action}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comment: payload?.comment || undefined,
        destinations: payload?.destinations || undefined,
        ownerAgent: payload?.ownerAgent || undefined,
        collaborators: payload?.collaborators || undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `Failed to ${action} idea`);
    if (action === "promote") {
      const promotedCount = Array.isArray(json?.destinations) ? json.destinations.length : payload?.destinations?.length || 0;
      setToast(promotedCount > 1 ? `Promoted to ${promotedCount} destinations` : "Promoted to pipeline");
    } else {
      setToast(action === "park" ? "Intel saved" : "Intel dismissed");
    }
    closeDetail();
    router.refresh();
  }

  return (
    <div className="relative">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-gray-700 bg-[#14141d] px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-4 rounded-xl border border-gray-800 bg-[#111118] p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
          <span>{total} intel item{total !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>Inbox de señales enriquecidas para revisar y decidir</span>
          {statusFilter === "new" ? (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
              Fresh: últimos 3 días
            </span>
          ) : null}
          <span
            title={health.lastError || undefined}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              health.status === "ok"
                ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            }`}
          >
            Competitors: {health.enabledCompetitors} · {health.latestCompetitorRunStatus || "unknown"}
            {health.unresolvedCompetitors || health.failingSources ? ` · ${health.unresolvedCompetitors + health.failingSources} issues` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
           <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white">
             <option value="new">New / sin decidir</option>
             <option value="all">All statuses</option>
             <option value="saved">Saved</option>
             <option value="promoted">Promoted</option>
             <option value="dismissed">Dismissed</option>
           </select>
           <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)} className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white">
             <option value="all">All lanes</option>
             {assetOptions.map((option) => (
               <option key={option} value={option}>{option}</option>
             ))}
           </select>
           <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white">
             <option value="all">All owners</option>
             {ownerOptions.map((option) => (
               <option key={option} value={option}>{option}</option>
             ))}
           </select>
           {statusFilter === "new" ? (
             <label className="inline-flex items-center gap-2 rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-gray-300">
               <input
                 type="checkbox"
                 checked={includeOlderNew}
                 onChange={(e) => setIncludeOlderNew(e.target.checked)}
                 className="h-4 w-4 accent-sky-500"
               />
               Show older
             </label>
           ) : null}
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-gray-500 sm:grid-cols-2 lg:grid-cols-4">
          <span className="rounded-full border border-gray-800 px-2 py-1">Raw 3d: {health.pipeline.rawRecent}</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Enriched 3d: {health.pipeline.enrichedRecent}</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Inbox visible: {health.pipeline.visibleInbox}</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Reddit ctx: {health.pipeline.redditWithDiscussion}</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">YT transcript ctx: {health.pipeline.youtubeTranscriptSummaries}</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Transcripts: {health.pipeline.transcriptsSummarized}/{health.pipeline.transcriptsFetched} summarized</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Unavailable/failed: {health.pipeline.transcriptsUnavailable}/{health.pipeline.transcriptsFailed}</span>
          <span className={`rounded-full border px-2 py-1 ${health.pipeline.duplicateSnapshotRows ? "border-amber-500/30 text-amber-200" : "border-gray-800"}`}>
            Snapshot dupes: {health.pipeline.duplicateSnapshotRows}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="rounded-full border border-gray-800 px-2 py-1">Default view: new intel</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">&quot;new&quot; = sin decisión de review</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Badge &quot;latest run&quot; = lote reciente, no estado</span>
        </div>
      </div>

      <div>
        <IntelInboxList
          items={items}
          selectedId={selectedId}
          onSelect={openDetail}
          onQuickDiscard={quickDiscard}
          discardingIds={discardingIds}
          loading={loadingList}
        />

        <IntelInboxDetail
          detail={detail}
          loading={loadingDetail}
          onClose={closeDetail}
          onAction={handleAction}
        />
      </div>
    </div>
  );
}
