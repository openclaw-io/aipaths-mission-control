"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IntelInboxDetail } from "./IntelInboxDetail";
import { IntelInboxList } from "./IntelInboxList";
import type { IntelInboxDetail as IntelInboxDetailType, IntelInboxListItem } from "@/lib/intel-inbox";

type DetailResponse = IntelInboxDetailType;

export function ContentInboxClient({
  initialItems,
  initialTotal,
  initialStatusFilter,
  initialAssetFilter,
  initialOwnerFilter,
  filterSourceItems,
  initialSelectedId,
  initialDetail,
}: {
  initialItems: IntelInboxListItem[];
  initialTotal: number;
  initialStatusFilter: string;
  initialAssetFilter: string;
  initialOwnerFilter: string;
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
  const [toast, setToast] = useState<string | null>(null);

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
    if (selectedId) params.set("idea", selectedId);

    const nextSearch = params.toString();
    const currentSearch = searchParams.toString();
    const next = nextSearch ? `${pathname}?${nextSearch}` : pathname;

    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }

    if (nextSearch === currentSearch) {
      setLoadingList(false);
      return;
    }

    setLoadingList(true);
    router.replace(next);
  }, [statusFilter, assetFilter, ownerFilter, selectedId, router, pathname, searchParams]);

  useEffect(() => {
    setSelectedId(initialSelectedId);
    setDetail(initialDetail);
    setLoadingList(false);
    setLoadingDetail(false);
  }, [initialSelectedId, initialDetail, initialItems, initialTotal]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  async function handleAction(action: "promote" | "park" | "discard", payload?: { comment?: string; ownerAgent?: string; collaborators?: string[] }) {
    if (!selectedId) return;
    const endpoint = `/api/intel/inbox/${selectedId}/${action}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comment: payload?.comment || undefined,
        ownerAgent: payload?.ownerAgent || undefined,
        collaborators: payload?.collaborators || undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `Failed to ${action} idea`);
    setToast(
      action === "promote"
        ? "Idea promoted to pipeline"
        : action === "park"
          ? "Idea saved"
          : "Idea dismissed"
    );
    setSelectedId(null);
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
          <div className="ml-auto flex flex-wrap gap-2">
           <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white">
             <option value="new">New</option>
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
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="rounded-full border border-gray-800 px-2 py-1">Default view: new intel</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Open detail to decide</span>
          <span className="rounded-full border border-gray-800 px-2 py-1">Promote, Save, Dismiss</span>
        </div>
      </div>

      <div>
        <IntelInboxList
          items={items}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loadingList}
        />

        <IntelInboxDetail
          detail={detail}
          loading={loadingDetail}
          onClose={() => setSelectedId(null)}
          onAction={handleAction}
        />
      </div>
    </div>
  );
}
