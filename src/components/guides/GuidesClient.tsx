"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GuideItem, LinkedWorkItem } from "@/app/guides/page";
import { useRealtimeGuides } from "@/hooks/useRealtimeGuides";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";

type TabKey = "inbox" | "scheduled" | "published" | "archived";
type SectionKey = "drafts" | "review";

type GuideMetadata = {
  intel?: { enriched_item_id?: string | number };
  draft_markdown?: string;
  draft_summary?: string;
  seo?: { meta_description?: string; primary_keyword?: string; secondary_keywords?: string[] };
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "scheduled", label: "Scheduled" },
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
  scheduled: "bg-purple-500/20 text-purple-300",
  live: "bg-green-500/20 text-green-300",
  archived: "bg-gray-500/20 text-gray-300",
};

function prettyStatus(status: string) {
  return status.replaceAll("_", " ");
}

function getMetadata(item: GuideItem): GuideMetadata {
  return (item.metadata || {}) as GuideMetadata;
}

function getPrimaryWorkItem(itemId: string, workItems: LinkedWorkItem[]) {
  const relevant = workItems.filter((item) => item.source_id === itemId || item.payload?.pipeline_item_id === itemId);
  const score = (item: LinkedWorkItem) => {
    if (item.payload?.action === "publish_guide") return 4;
    if (item.payload?.action === "localize_guide_to_en") return 3;
    if (item.payload?.action === "revise_guide_draft") return 2;
    if (item.payload?.action === "develop_guide_draft") return 1;
    return 0;
  };
  return [...relevant].sort((a, b) => {
    if (a.source_type !== b.source_type) return a.source_type === "pipeline_item" ? -1 : 1;
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  })[0] || null;
}

export function GuidesClient({ initialGuides, initialWorkItems }: { initialGuides: GuideItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const [guides, setGuides] = useRealtimeGuides(initialGuides);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("inbox");

  const inboxGrouped = useMemo(() => {
    return Object.fromEntries(
      INBOX_SECTIONS.map((section) => [
        section.key,
        guides.filter((item) => section.statuses.includes(item.status)),
      ])
    ) as Record<SectionKey, GuideItem[]>;
  }, [guides]);

  const selectedReviewItem = useMemo(() => guides.find((item) => item.id === reviewId) || null, [guides, reviewId]);
  const scheduledItems = useMemo(() => {
    return guides
      .filter((item) => item.status === "scheduled")
      .sort((a, b) => getScheduleTime(a, workItems) - getScheduleTime(b, workItems));
  }, [guides, workItems]);
  const publishedItems = useMemo(() => guides.filter((item) => item.status === "live"), [guides]);
  const archivedItems = useMemo(() => guides.filter((item) => item.status === "archived"), [guides]);

  function openReview(item: GuideItem) {
    setSelectedId(null);
    setReviewId(item.id);
    setReviewNotes("");
  }

  function closeReview() {
    setReviewId(null);
    setReviewNotes("");
  }

  async function runAction(action: string, item: GuideItem, options?: { reviewNotes?: string }) {
    setBusyAction(`${item.id}:${action}`);
    try {
      const res = await fetch(`/api/guides/${item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewNotes: options?.reviewNotes }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Action failed");
        return;
      }
      const updatedItem = (await res.json()) as Partial<GuideItem>;
      setGuides((prev) => prev.map((guide) => (guide.id === item.id ? { ...guide, ...updatedItem } : guide)));
      setSelectedId(null);
      closeReview();
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function requestChanges(item: GuideItem) {
    const notes = reviewNotes.trim();
    if (!notes) {
      alert("Add review notes before requesting changes.");
      return;
    }
    await runAction("request_changes", item, { reviewNotes: notes });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📚 Guías</h1>
      <p className="mt-1 text-sm text-gray-500">Gestiona guías y documentos con el mismo flujo editorial de blogs.</p>

      <div className="mt-6 flex gap-1 rounded-lg bg-[#0a0a0f] p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setSelectedId(null);
              closeReview();
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
                      const metadata = getMetadata(item);
                      const primaryWorkItem = getPrimaryWorkItem(item.id, workItems);
                      const isSelected = selectedId === item.id;
                      const isReview = item.status === "ready_for_review";
                      return (
                        <div
                          key={item.id}
                          onClick={() => (isReview ? openReview(item) : setSelectedId(isSelected ? null : item.id))}
                          className={`cursor-pointer rounded-lg border p-4 transition ${isSelected || reviewId === item.id ? "border-blue-500 bg-blue-500/5" : "border-gray-800 hover:border-gray-700 hover:bg-white/5"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="font-medium text-white">{item.title}</h3>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{prettyStatus(item.status)}</span>
                                {metadata.intel?.enriched_item_id && <span>enriched: {metadata.intel.enriched_item_id}</span>}
                                {primaryWorkItem && <span>task: {primaryWorkItem.owner_agent || "unknown"} · {primaryWorkItem.status}</span>}
                              </div>
                            </div>
                            {isReview && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openReview(item);
                                }}
                                className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/15"
                              >
                                Review
                              </button>
                            )}
                          </div>

                          {isSelected && item.status === "draft" && (
                            <div className="mt-4 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                              <ActionButton label="Promote" busy={busyAction === `${item.id}:promote`} onClick={() => runAction("promote", item)} />
                              <ActionButton label="Park" variant="secondary" busy={busyAction === `${item.id}:park`} onClick={() => runAction("park", item)} />
                              <ActionButton label="Reject" variant="danger" busy={busyAction === `${item.id}:reject`} onClick={() => runAction("reject", item)} />
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

      {tab === "scheduled" && (
        <ScheduledList items={scheduledItems} workItems={workItems} />
      )}

      {tab === "published" && (
        <SimpleList title="Published" items={publishedItems} workItems={workItems} emptyLabel="No published guides" />
      )}

      {tab === "archived" && (
        <SimpleList title="Archived" items={archivedItems} workItems={workItems} emptyLabel="No archived guides" />
      )}

      {selectedReviewItem && (
        <ReviewDrawer
          item={selectedReviewItem}
          notes={reviewNotes}
          busyAction={busyAction}
          onNotesChange={setReviewNotes}
          onClose={closeReview}
          onApprove={() => runAction("approve", selectedReviewItem)}
          onReject={() => runAction("reject", selectedReviewItem)}
          onRequestChanges={() => requestChanges(selectedReviewItem)}
        />
      )}
    </div>
  );
}

function ReviewDrawer({
  item,
  notes,
  busyAction,
  onNotesChange,
  onClose,
  onApprove,
  onRequestChanges,
  onReject,
}: {
  item: GuideItem;
  notes: string;
  busyAction: string | null;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
}) {
  const metadata = getMetadata(item);
  const markdown = metadata.draft_markdown || metadata.draft_summary || "No draft content found on this guide item yet.";
  const cleanBody = markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
  const wordCount = cleanBody ? cleanBody.split(/\s+/).length : 0;
  const readMinutes = Math.max(1, Math.round(wordCount / 220));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-5xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-yellow-300">Ready to review</span>
                <span className="text-xs text-gray-500">{wordCount.toLocaleString()} words · {readMinutes} min read</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
            </div>
            <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <MarkdownPreview markdown={markdown} />
        </div>

        <div className="border-t border-gray-800 bg-[#111118]/95 p-5 shadow-[0_-20px_45px_rgba(0,0,0,0.25)]">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label className="text-sm font-medium text-white" htmlFor="review-notes">Review notes</label>
              <p className="mt-1 text-xs text-gray-500">Only required when requesting changes. These notes go to Content.</p>
              <textarea
                id="review-notes"
                value={notes}
                onChange={(event) => onNotesChange(event.target.value)}
                placeholder="Example: tighten the intro, add concrete examples, fix weak section..."
                className="mt-2 h-24 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <ActionButton label="Approve" busy={busyAction === `${item.id}:approve`} onClick={onApprove} />
              <ActionButton label="Request changes" variant="secondary" busy={busyAction === `${item.id}:request_changes`} onClick={onRequestChanges} />
              <ActionButton label="Reject" variant="danger" busy={busyAction === `${item.id}:reject`} onClick={onReject} />
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const body = markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
  const lines = body.split("\n");

  return (
    <article className="mx-auto max-w-4xl space-y-3 rounded-2xl border border-gray-800 bg-[#15151d] px-10 py-10 text-[17px] leading-7 text-gray-300 shadow-xl">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} className="h-2" />;
        if (trimmed === "---") return <hr key={index} className="my-8 border-gray-800" />;
        if (trimmed.startsWith("# ")) return <h1 key={index} className="mb-5 text-3xl font-bold leading-tight text-white">{renderInline(trimmed.slice(2))}</h1>;
        if (trimmed.startsWith("## ")) return <h2 key={index} className="border-t border-gray-800 pt-6 text-2xl font-semibold leading-tight text-white">{renderInline(trimmed.slice(3))}</h2>;
        if (trimmed.startsWith("### ")) return <h3 key={index} className="pt-3 text-xl font-semibold text-white">{renderInline(trimmed.slice(4))}</h3>;
        if (trimmed.startsWith("> ")) return <blockquote key={index} className="border-l-2 border-blue-500 pl-4 italic text-gray-400">{renderInline(trimmed.slice(2))}</blockquote>;
        if (trimmed.startsWith("- ")) return <p key={index} className="pl-4 text-gray-300">• {renderInline(trimmed.slice(2))}</p>;
        return <p key={index}>{renderInline(trimmed)}</p>;
      })}
    </article>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-black/40 px-1.5 py-0.5 text-blue-200">{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-blue-400 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-300">{link[1]}</a>;
    }
    return part;
  });
}

function getPublishWorkItem(item: GuideItem, workItems: LinkedWorkItem[]) {
  return workItems.find((workItem) => {
    const payload = workItem.payload || {};
    return payload.action === "publish_guide" && payload.pipeline_item_id === item.id;
  });
}

function getPublishSchedule(item: GuideItem, workItems: LinkedWorkItem[]) {
  return getPublishWorkItem(item, workItems)?.scheduled_for || item.scheduled_for;
}

function getScheduleTime(item: GuideItem, workItems: LinkedWorkItem[]) {
  const scheduledFor = getPublishSchedule(item, workItems);
  return scheduledFor ? new Date(scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
}

function formatScheduledDate(value: string | null) {
  if (!value) return "Fecha sin definir";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha sin definir";
  const formatted = new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function ScheduledList({ items, workItems }: { items: GuideItem[]; workItems: LinkedWorkItem[] }) {
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Scheduled</h2>
        <span className="text-xs text-gray-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-600">No scheduled guides</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const publishWorkItem = getPublishWorkItem(item, workItems);
            return (
              <div key={item.id} className="rounded-lg border border-gray-800 p-4">
                <p className="text-sm font-medium text-purple-300">{formatScheduledDate(getPublishSchedule(item, workItems))}</p>
                <h3 className="mt-1 text-base font-semibold text-white">{item.title}</h3>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                  {publishWorkItem && <span>publish task: {publishWorkItem.owner_agent || "dev"} · {publishWorkItem.status}</span>}
                  {publishWorkItem?.scheduled_for && <span>queued: {new Date(publishWorkItem.scheduled_for).toLocaleString("es-ES", { timeZone: "Europe/London" })}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SimpleList({ title, items, workItems, emptyLabel }: { title: string; items: GuideItem[]; workItems: LinkedWorkItem[]; emptyLabel: string }) {
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
