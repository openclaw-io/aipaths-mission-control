"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BlogItem, LinkedWorkItem } from "@/app/blogs/page";
import { useRealtimeBlogs } from "@/hooks/useRealtimeBlogs";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";

type TabKey = "inbox" | "final_check" | "scheduled" | "published" | "archived";
type SectionKey = "drafts" | "review";

type BlogMetadata = {
  intel?: { enriched_item_id?: string | number };
  draft_markdown?: string;
  draft_summary?: string;
  seo?: { meta_description?: string; primary_keyword?: string; secondary_keywords?: string[] };
  localization?: {
    en?: { title?: string; slug?: string; content_path?: string; draft_markdown?: string; markdown?: string; content?: string; body?: string; meta_description?: string };
    en_ready?: boolean;
    translated_at?: string;
  };
  hero_image?: { url?: string; media_path?: string; local_path?: string; path?: string; prompt?: string; status?: string; updated_at?: string; width?: number; height?: number; aspect_ratio?: string };
  cover_image?: { url?: string; media_path?: string; local_path?: string; path?: string; prompt?: string; status?: string; updated_at?: string; width?: number; height?: number; aspect_ratio?: string };
  final_check?: { status?: string; notes?: string; ready_at?: string; approved_at?: string };
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "final_check", label: "Final Check" },
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
  final_check: "bg-cyan-500/20 text-cyan-300",
  localizing: "bg-blue-500/20 text-blue-300",
  scheduled: "bg-purple-500/20 text-purple-300",
  live: "bg-green-500/20 text-green-300",
  archived: "bg-gray-500/20 text-gray-300",
};

function prettyStatus(status: string) {
  return status.replaceAll("_", " ");
}

function getMetadata(item: BlogItem): BlogMetadata {
  return (item.metadata || {}) as BlogMetadata;
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
  const [blogs, setBlogs] = useRealtimeBlogs(initialBlogs);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [finalCheckId, setFinalCheckId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [finalCheckNotes, setFinalCheckNotes] = useState("");
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

  const selectedReviewItem = useMemo(() => blogs.find((item) => item.id === reviewId) || null, [blogs, reviewId]);
  const selectedFinalCheckItem = useMemo(() => blogs.find((item) => item.id === finalCheckId) || null, [blogs, finalCheckId]);
  const finalCheckItems = useMemo(() => blogs.filter((item) => item.status === "final_check"), [blogs]);
  const scheduledItems = useMemo(() => {
    return blogs
      .filter((item) => item.status === "scheduled")
      .sort((a, b) => getScheduleTime(a, workItems) - getScheduleTime(b, workItems));
  }, [blogs, workItems]);
  const publishedItems = useMemo(() => blogs.filter((item) => item.status === "live"), [blogs]);
  const archivedItems = useMemo(() => blogs.filter((item) => item.status === "archived"), [blogs]);

  function openReview(item: BlogItem) {
    setSelectedId(null);
    setFinalCheckId(null);
    setReviewId(item.id);
    setReviewNotes("");
  }

  function closeReview() {
    setReviewId(null);
    setReviewNotes("");
  }

  function openFinalCheck(item: BlogItem) {
    setSelectedId(null);
    setReviewId(null);
    setFinalCheckId(item.id);
    setFinalCheckNotes("");
  }

  function closeFinalCheck() {
    setFinalCheckId(null);
    setFinalCheckNotes("");
  }

  async function runAction(action: string, item: BlogItem, options?: { reviewNotes?: string }) {
    setBusyAction(`${item.id}:${action}`);
    try {
      const res = await fetch(`/api/blogs/${item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewNotes: options?.reviewNotes }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Action failed");
        return;
      }
      const updatedItem = (await res.json()) as Partial<BlogItem>;
      setBlogs((prev) => prev.map((blog) => (blog.id === item.id ? { ...blog, ...updatedItem } : blog)));
      setSelectedId(null);
      closeReview();
      closeFinalCheck();
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function requestChanges(item: BlogItem) {
    const notes = reviewNotes.trim();
    if (!notes) {
      alert("Add review notes before requesting changes.");
      return;
    }
    await runAction("request_changes", item, { reviewNotes: notes });
  }

  async function requestFinalChanges(item: BlogItem) {
    const notes = finalCheckNotes.trim();
    if (!notes) {
      alert("Add final-check notes before requesting changes.");
      return;
    }
    await runAction("request_final_changes", item, { reviewNotes: notes });
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
              closeReview();
              closeFinalCheck();
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

      {tab === "final_check" && (
        <FinalCheckList items={finalCheckItems} workItems={workItems} onOpen={openFinalCheck} />
      )}

      {tab === "scheduled" && (
        <ScheduledList items={scheduledItems} workItems={workItems} />
      )}

      {tab === "published" && (
        <SimpleList title="Published" items={publishedItems} workItems={workItems} emptyLabel="No published blogs" />
      )}

      {tab === "archived" && (
        <SimpleList title="Archived" items={archivedItems} workItems={workItems} emptyLabel="No archived blogs" />
      )}

      {selectedFinalCheckItem && (
        <FinalCheckDrawer
          item={selectedFinalCheckItem}
          notes={finalCheckNotes}
          busyAction={busyAction}
          onNotesChange={setFinalCheckNotes}
          onClose={closeFinalCheck}
          onApprove={() => runAction("approve_final", selectedFinalCheckItem)}
          onRequestChanges={() => requestFinalChanges(selectedFinalCheckItem)}
          onReject={() => runAction("reject", selectedFinalCheckItem)}
        />
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

function FinalCheckList({ items, workItems, onOpen }: { items: BlogItem[]; workItems: LinkedWorkItem[]; onOpen: (item: BlogItem) => void }) {
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Final Check</h2>
          <p className="text-xs text-gray-500">Approved blogs with EN localization and hero image ready for final publication approval.</p>
        </div>
        <span className="text-xs text-gray-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-600">No blogs waiting for final check</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const metadata = getMetadata(item);
            const primaryWorkItem = getPrimaryWorkItem(item.id, workItems);
            const hero = getHeroImage(metadata);
            const heroSrc = getHeroImageSrc(item, metadata);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item)}
                className="w-full rounded-lg border border-gray-800 p-3 text-left transition hover:border-gray-700 hover:bg-white/5 focus:outline-none focus:ring-1 focus:ring-cyan-500/60"
              >
                <div className="grid gap-4 md:grid-cols-[220px_1fr] md:items-center">
                  <div className="overflow-hidden rounded-lg border border-gray-800 bg-black/30">
                    {hero && heroSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={heroSrc} alt="Blog thumbnail candidate" className="aspect-[1.91/1] w-full object-cover" />
                    ) : (
                      <div className="flex aspect-[1.91/1] items-center justify-center px-4 text-center text-xs text-gray-600">No thumbnail yet</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-white">{item.title}</h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{prettyStatus(item.status)}</span>
                      <span>EN: {metadata.localization?.en_ready || metadata.localization?.en ? "ready" : "missing"}</span>
                      <span>Thumbnail: {hero ? "ready" : "missing"}</span>
                      {metadata.hero_image?.width && metadata.hero_image?.height && <span>{metadata.hero_image.width}×{metadata.hero_image.height}</span>}
                      {primaryWorkItem && <span>task: {primaryWorkItem.owner_agent || "unknown"} · {primaryWorkItem.status}</span>}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FinalCheckDrawer({
  item,
  notes,
  busyAction,
  onNotesChange,
  onClose,
  onApprove,
  onRequestChanges,
  onReject,
}: {
  item: BlogItem;
  notes: string;
  busyAction: string | null;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
}) {
  const metadata = getMetadata(item);
  const esMarkdown = metadata.draft_markdown || metadata.draft_summary || "No Spanish draft content found.";
  const enMarkdown = getEnglishMarkdown(metadata);
  const hero = getHeroImage(metadata);
  const heroSrc = getHeroImageSrc(item, metadata);
  const [contentTab, setContentTab] = useState<"es" | "en">("en");
  const currentMarkdown = contentTab === "es" ? esMarkdown : enMarkdown;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-6xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">Final check</span>
                <span className="text-xs text-gray-500">EN localization + hero image before scheduling</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                {item.slug && <MetadataPill label="Slug" value={item.slug} />}
                {metadata.localization?.en?.slug && <MetadataPill label="EN slug" value={metadata.localization.en.slug} />}
                {metadata.hero_image?.status && <MetadataPill label="Hero" value={metadata.hero_image.status} />}
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">Close</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
            <section className="rounded-2xl border border-gray-800 bg-[#15151d] p-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Thumbnail</h3>
              {hero ? (
                heroSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={heroSrc} alt="Blog thumbnail candidate" className="mt-4 aspect-[1.91/1] w-full rounded-xl border border-gray-800 object-cover" />
                ) : (
                  <div className="mt-4 rounded-xl border border-gray-800 bg-black/30 p-3 text-xs text-gray-400 break-all">{hero}</div>
                )
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-gray-700 p-6 text-sm text-gray-500">No thumbnail stored yet.</div>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                {metadata.hero_image?.width && metadata.hero_image?.height && <MetadataPill label="Size" value={`${metadata.hero_image.width}×${metadata.hero_image.height}`} />}
                {metadata.hero_image?.aspect_ratio && <MetadataPill label="Ratio" value={metadata.hero_image.aspect_ratio} />}
                {metadata.hero_image?.status && <MetadataPill label="Status" value={metadata.hero_image.status} />}
              </div>
              {metadata.hero_image?.prompt && (
                <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Prompt</p>
                  <p className="mt-1 text-sm leading-6 text-gray-300">{metadata.hero_image.prompt}</p>
                </div>
              )}
            </section>
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Content preview</h3>
                <div className="rounded-lg border border-gray-800 bg-[#111118] p-1">
                  <button type="button" onClick={() => setContentTab("es")} className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${contentTab === "es" ? "bg-white/10 text-white" : "text-gray-500 hover:text-white"}`}>ES</button>
                  <button type="button" onClick={() => setContentTab("en")} className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${contentTab === "en" ? "bg-white/10 text-white" : "text-gray-500 hover:text-white"}`}>EN</button>
                </div>
              </div>
              <MarkdownPreview markdown={currentMarkdown} />
            </section>
          </div>
        </div>

        <div className="border-t border-gray-800 bg-[#111118]/95 p-5 shadow-[0_-20px_45px_rgba(0,0,0,0.25)]">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label className="text-sm font-medium text-white" htmlFor="final-check-notes">Final-check notes</label>
              <p className="mt-1 text-xs text-gray-500">Required only when sending the translation/thumbnail back for changes.</p>
              <textarea id="final-check-notes" value={notes} onChange={(event) => onNotesChange(event.target.value)} placeholder="Example: regenerate thumbnail simpler, tighten EN title..." className="mt-2 h-24 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500" />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <ActionButton label="Approve final" busy={busyAction === `${item.id}:approve_final`} onClick={onApprove} />
              <ActionButton label="Request changes" variant="secondary" busy={busyAction === `${item.id}:request_final_changes`} onClick={onRequestChanges} />
              <ActionButton label="Reject" variant="danger" busy={busyAction === `${item.id}:reject`} onClick={onReject} />
            </div>
          </div>
        </div>
      </aside>
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
  item: BlogItem;
  notes: string;
  busyAction: string | null;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
}) {
  const metadata = getMetadata(item);
  const markdown = metadata.draft_markdown || metadata.draft_summary || "No draft content found on this blog item yet.";
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

function MetadataPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-gray-800 bg-white/5 px-2.5 py-1">
      <span className="text-gray-600">{label}:</span> <span className="text-gray-400">{value}</span>
    </span>
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

function getEnglishMarkdown(metadata: BlogMetadata) {
  return (
    metadata.localization?.en?.draft_markdown ||
    metadata.localization?.en?.markdown ||
    metadata.localization?.en?.content ||
    metadata.localization?.en?.body ||
    "No English localization found yet."
  );
}

function getHeroImage(metadata: BlogMetadata) {
  return (
    metadata.hero_image?.url ||
    metadata.cover_image?.url ||
    metadata.hero_image?.media_path ||
    metadata.cover_image?.media_path ||
    metadata.hero_image?.local_path ||
    metadata.cover_image?.local_path ||
    metadata.hero_image?.path ||
    metadata.cover_image?.path ||
    null
  );
}

function getHeroImageSrc(item: BlogItem, metadata: BlogMetadata) {
  const directUrl = metadata.hero_image?.url || metadata.cover_image?.url;
  if (directUrl) return directUrl;
  const localPath = metadata.hero_image?.media_path || metadata.cover_image?.media_path || metadata.hero_image?.local_path || metadata.cover_image?.local_path || metadata.hero_image?.path || metadata.cover_image?.path;
  return localPath ? `/api/blogs/${item.id}/hero-image` : null;
}

function getPublishWorkItem(item: BlogItem, workItems: LinkedWorkItem[]) {
  return workItems.find((workItem) => {
    const payload = workItem.payload || {};
    return payload.action === "publish_blog" && payload.pipeline_item_id === item.id;
  });
}

function getPublishSchedule(item: BlogItem, workItems: LinkedWorkItem[]) {
  return getPublishWorkItem(item, workItems)?.scheduled_for || item.scheduled_for;
}

function getScheduleTime(item: BlogItem, workItems: LinkedWorkItem[]) {
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

function ScheduledList({ items, workItems }: { items: BlogItem[]; workItems: LinkedWorkItem[] }) {
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Scheduled</h2>
        <span className="text-xs text-gray-500">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-600">No scheduled blogs</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const metadata = getMetadata(item);
            const hero = getHeroImage(metadata);
            const heroSrc = getHeroImageSrc(item, metadata);
            const publishWorkItem = getPublishWorkItem(item, workItems);
            return (
              <div key={item.id} className="grid gap-4 rounded-lg border border-gray-800 p-3 md:grid-cols-[180px_1fr] md:items-center">
                <div className="overflow-hidden rounded-lg border border-gray-800 bg-black/30">
                  {hero && heroSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={heroSrc} alt="Scheduled blog thumbnail" className="aspect-[1.91/1] w-full object-cover" />
                  ) : (
                    <div className="flex aspect-[1.91/1] items-center justify-center px-4 text-center text-xs text-gray-600">No thumbnail yet</div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-purple-300">{formatScheduledDate(getPublishSchedule(item, workItems))}</p>
                  <h3 className="mt-1 text-base font-semibold text-white">{item.title}</h3>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                    <span>Thumbnail: {hero ? "ready" : "missing"}</span>
                    {publishWorkItem && <span>publish task: {publishWorkItem.owner_agent || "dev"} · {publishWorkItem.status}</span>}
                    {publishWorkItem?.scheduled_for && <span>queued: {new Date(publishWorkItem.scheduled_for).toLocaleString("es-ES", { timeZone: "Europe/London" })}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
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
