"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BlogItem, LinkedWorkItem } from "@/app/blogs/page";
import { useRealtimeBlogs } from "@/hooks/useRealtimeBlogs";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";

type TabKey = "inbox" | "published" | "archived";
type SectionKey = "drafts" | "review";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "published", label: "Published" },
  { key: "archived", label: "Archived" },
];

const INBOX_SECTIONS: Array<{ key: SectionKey; title: string; statuses: string[] }> = [
  { key: "drafts", title: "Drafts", statuses: ["draft"] },
  { key: "review", title: "Ready to Review", statuses: ["ready_for_review"] },
];

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-500/20 text-slate-300",
  ready_for_review: "bg-yellow-500/20 text-yellow-300",
  live: "bg-green-500/20 text-green-300",
  archived: "bg-gray-500/20 text-gray-300",
};

function prettyStatus(status: string) {
  return status.replaceAll("_", " ");
}

function getPrimaryWorkItem(itemId: string, workItems: LinkedWorkItem[]) {
  const relevant = workItems.filter((item) => item.source_id === itemId || item.payload?.pipeline_item_id === itemId);
  const score = (item: LinkedWorkItem) => {
    if (item.payload?.action === "publish_blog") return 4;
    if (item.payload?.action === "localize_blog_to_en") return 3;
    if (item.payload?.action === "revise_blog_draft") return 2;
    if (item.payload?.action === "develop_blog_draft") return 1;
    return 0;
  };
  return [...relevant].sort((a, b) => {
    if (a.source_type !== b.source_type) return a.source_type === "pipeline_item" ? -1 : 1;
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  })[0] || null;
}

export function BlogsClient({ initialBlogs, initialWorkItems }: { initialBlogs: BlogItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const blogs = useRealtimeBlogs(initialBlogs);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("inbox");

  const inboxGrouped = useMemo(() => {
    return Object.fromEntries(
      INBOX_SECTIONS.map((section) => [
        section.key,
        blogs.filter((item) => section.statuses.includes(item.status)),
      ])
    ) as Record<SectionKey, BlogItem[]>;
  }, [blogs]);

  const publishedItems = useMemo(() => blogs.filter((item) => item.status === "live"), [blogs]);
  const archivedItems = useMemo(() => blogs.filter((item) => item.status === "archived"), [blogs]);

  async function runAction(action: string, item: BlogItem) {
    setBusyAction(`${item.id}:${action}`);
    try {
      const res = await fetch(`/api/blogs/${item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Action failed");
        return;
      }
      setSelectedId(null);
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">✍️ Blogs</h1>
      <p className="mt-1 text-sm text-gray-500">Clean drafts fast. Blogs reappear only when they are ready for review.</p>

      <div className="mt-6 flex gap-1 rounded-lg bg-[#0a0a0f] p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setSelectedId(null);
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === t.key ? "bg-[#1a1a24] text-white" : "text-gray-500 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "inbox" && (
        <div className="mt-6 space-y-6">
          {INBOX_SECTIONS.map((section) => {
            const items = inboxGrouped[section.key] || [];
            return (
              <section key={section.key} className="rounded-xl border border-gray-800 bg-[#111118] p-4">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-white">{section.title}</h2>
                  <span className="text-xs text-gray-500">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <p className="text-sm text-gray-600">No items</p>
                ) : (
                  <div className="space-y-3">
                    {items.map((item) => {
                      const intel = (item.metadata as any)?.intel;
                      const primaryWorkItem = getPrimaryWorkItem(item.id, workItems);
                      const isSelected = selectedId === item.id;
                      return (
                        <div
                          key={item.id}
                          onClick={() => setSelectedId(isSelected ? null : item.id)}
                          className={`cursor-pointer rounded-lg border p-4 transition ${isSelected ? "border-blue-500 bg-blue-500/5" : "border-gray-800 hover:border-gray-700 hover:bg-white/5"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="font-medium text-white">{item.title}</h3>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{prettyStatus(item.status)}</span>
                                {intel?.enriched_item_id && <span>enriched: {intel.enriched_item_id}</span>}
                                {primaryWorkItem && <span>task: {primaryWorkItem.owner_agent || "unknown"} · {primaryWorkItem.status}</span>}
                              </div>
                            </div>
                          </div>

                          {isSelected && (
                            <div className="mt-4 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                              {item.status === "draft" && (
                                <>
                                  <ActionButton label="Promote" busy={busyAction === `${item.id}:promote`} onClick={() => runAction("promote", item)} />
                                  <ActionButton label="Park" variant="secondary" busy={busyAction === `${item.id}:park`} onClick={() => runAction("park", item)} />
                                  <ActionButton label="Reject" variant="danger" busy={busyAction === `${item.id}:reject`} onClick={() => runAction("reject", item)} />
                                </>
                              )}
                              {item.status === "ready_for_review" && (
                                <>
                                  <ActionButton label="Approve" busy={busyAction === `${item.id}:approve`} onClick={() => runAction("approve", item)} />
                                  <ActionButton label="Request changes" variant="secondary" busy={busyAction === `${item.id}:request_changes`} onClick={() => runAction("request_changes", item)} />
                                  <ActionButton label="Reject" variant="danger" busy={busyAction === `${item.id}:reject`} onClick={() => runAction("reject", item)} />
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {tab === "published" && (
        <SimpleList title="Published" items={publishedItems} workItems={workItems} emptyLabel="No published blogs" />
      )}

      {tab === "archived" && (
        <SimpleList title="Archived" items={archivedItems} workItems={workItems} emptyLabel="No archived blogs" />
      )}
    </div>
  );
}

function SimpleList({ title, items, workItems, emptyLabel }: { title: string; items: BlogItem[]; workItems: LinkedWorkItem[]; emptyLabel: string }) {
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <span className="text-xs text-gray-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-600">{emptyLabel}</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const primaryWorkItem = getPrimaryWorkItem(item.id, workItems);
            return (
              <div key={item.id} className="rounded-lg border border-gray-800 p-4">
                <h3 className="font-medium text-white">{item.title}</h3>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{prettyStatus(item.status)}</span>
                  {item.current_url && (
                    <a className="text-blue-400 hover:text-blue-300" href={item.current_url} target="_blank" rel="noreferrer">open url</a>
                  )}
                  {primaryWorkItem && <span>task: {primaryWorkItem.owner_agent || "unknown"} · {primaryWorkItem.status}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActionButton({ label, onClick, variant = "primary", busy }: { label: string; onClick: () => void; variant?: "primary" | "secondary" | "danger"; busy?: boolean }) {
  const styles = {
    primary: "bg-blue-600 hover:bg-blue-500 text-white",
    secondary: "bg-white/10 hover:bg-white/15 text-white",
    danger: "bg-red-600 hover:bg-red-500 text-white",
  } as const;

  return (
    <button disabled={busy} onClick={onClick} className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}>
      {busy ? "Working..." : label}
    </button>
  );
}
