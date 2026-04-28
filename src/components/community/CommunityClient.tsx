"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CommunityItem, LinkedWorkItem } from "@/app/community/page";
import { useRealtimeCommunity } from "@/hooks/useRealtimeCommunity";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";

type TabKey = "review" | "scheduled" | "published" | "parked";

type CommunityMetadata = {
  kind?: string;
  channel?: string;
  target?: { platform?: string; channel_id?: string; channel_name?: string };
  copy?: { text?: string; poll_options?: string[] };
  source?: { type?: string; title?: string; url?: string; slug?: string; pipeline_item_id?: string };
  legacy?: { status?: string; notes?: string; source?: string };
  review?: { notes?: string; last_requested_at?: string; approved_at?: string; approved_by?: string };
  runtime_feedback?: { last_status?: string; last_work_item_id?: string; notes?: string };
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "review", label: "Ready to Review" },
  { key: "scheduled", label: "Scheduled" },
  { key: "published", label: "Published" },
  { key: "parked", label: "Parked" },
];

function prettyKind(kind?: string) {
  if (!kind) return "community post";
  return kind.replaceAll("_", " ");
}

function getMetadata(item: CommunityItem): CommunityMetadata {
  return (item.metadata || {}) as CommunityMetadata;
}

function getChannelLabel(metadata: CommunityMetadata) {
  return metadata.target?.channel_name || metadata.channel || metadata.target?.channel_id || "Discord";
}

function getCopy(metadata: CommunityMetadata) {
  return metadata.copy?.text || metadata.legacy?.notes || "";
}

function getCopyPreview(metadata: CommunityMetadata) {
  const text = getCopy(metadata) || "No copy saved yet.";
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
}

function getOneLineCopyPreview(metadata: CommunityMetadata) {
  const text = (getCopy(metadata) || "No copy saved yet.").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function getPrimaryWorkItem(itemId: string, workItems: LinkedWorkItem[]) {
  return [...workItems]
    .filter((item) => item.source_id === itemId || item.payload?.pipeline_item_id === itemId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;
}

function getPublishWorkItem(itemId: string, workItems: LinkedWorkItem[]) {
  return [...workItems]
    .filter((item) => {
      const payload = item.payload || {};
      const isLinked = item.source_id === itemId || payload.pipeline_item_id === itemId;
      const isPublish = payload.action === "publish_community_post" || payload.relation_type === "publish";
      const isOpen = ["draft", "ready", "blocked", "in_progress"].includes(item.status);
      return isLinked && isPublish && isOpen;
    })
    .sort((a, b) => new Date(a.scheduled_for || a.created_at).getTime() - new Date(b.scheduled_for || b.created_at).getTime())[0] || null;
}

function getScheduledDate(item: CommunityItem, workItems: LinkedWorkItem[]) {
  return getPublishWorkItem(item.id, workItems)?.scheduled_for || null;
}

function inferCommunityChannel(metadata: CommunityMetadata) {
  const destinationKey = typeof (metadata as Record<string, unknown>).intel_destination_key === "string" ? (metadata as Record<string, string>).intel_destination_key : null;
  const destinationLabel = typeof (metadata as Record<string, unknown>).destination_label === "string" ? String((metadata as Record<string, unknown>).destination_label).toLowerCase() : "";
  const sourceType = metadata.source?.type;
  const kind = metadata.kind;

  if (destinationKey === "poll" || destinationLabel.includes("encuesta") || kind === "poll") return "#📔_encuestas";
  if (destinationKey === "tool" || destinationLabel.includes("tool") || destinationLabel.includes("herramienta") || kind === "tool_of_day") return "#🦿_ai_tools";
  if (destinationKey === "startup" || destinationLabel.includes("startup") || kind === "startup_of_day") return "#📢_presenta_tu_proyecto";
  if (["blog", "guide", "doc", "video"].includes(String(sourceType || destinationKey || kind || ""))) return "#_📣anuncios";
  if (destinationKey === "news" || destinationLabel === "news" || kind === "news" || (metadata as Record<string, unknown>).intel) return "#🛰️_radar_ia";
  return "#🛰️_radar_ia";
}

function getPublishChannelLabel(workItem: LinkedWorkItem | null, metadata: CommunityMetadata) {
  const payload = workItem?.payload || {};
  if (typeof payload.target_channel_name === "string") return `#${payload.target_channel_name}`;
  return inferCommunityChannel(metadata);
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function dateGroupLabel(value: string | null) {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  const now = new Date();
  const londonDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", dateStyle: "short" }).format(d);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (londonDay(date) === londonDay(now)) return "Today";
  if (londonDay(date) === londonDay(tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "Europe/London" }).format(date);
}

function getTabDate(item: CommunityItem, tab: TabKey, workItems: LinkedWorkItem[]) {
  if (tab === "scheduled") return getScheduledDate(item, workItems);
  if (tab === "published") return item.published_at;
  return null;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function hasCopy(item: CommunityItem) {
  return Boolean(getCopy(getMetadata(item)).trim());
}

function tabItems(items: CommunityItem[], tab: TabKey, workItems: LinkedWorkItem[]) {
  if (tab === "review") return items.filter((item) => item.status === "ready_for_review");
  if (tab === "scheduled") {
    return items
      .filter((item) => item.status === "scheduled" && getPublishWorkItem(item.id, workItems)?.scheduled_for)
      .sort((a, b) => new Date(getScheduledDate(a, workItems) || a.updated_at).getTime() - new Date(getScheduledDate(b, workItems) || b.updated_at).getTime());
  }
  if (tab === "published") return items.filter((item) => ["published", "live"].includes(item.status));
  return items.filter((item) => ["parked", "rejected", "archived"].includes(item.status));
}

export function CommunityClient({ initialItems, initialWorkItems }: { initialItems: CommunityItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const [items, setItems] = useRealtimeCommunity(initialItems);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [tab, setTab] = useState<TabKey>("review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const visibleItems = useMemo(() => tabItems(items, tab, workItems), [items, tab, workItems]);
  const selectedReviewItem = useMemo(() => items.find((item) => item.id === reviewId) || null, [items, reviewId]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, tabItems(items, t.key, workItems).length])) as Record<TabKey, number>, [items, workItems]);

  function openReview(item: CommunityItem) {
    setSelectedId(null);
    setReviewId(item.id);
    setReviewNotes("");
  }

  function closeReview() {
    setReviewId(null);
    setReviewNotes("");
  }

  async function runAction(action: string, item: CommunityItem, options?: { reviewNotes?: string }) {
    setBusyAction(`${item.id}:${action}`);
    try {
      const res = await fetch(`/api/community/${item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewNotes: options?.reviewNotes }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Action failed");
        return;
      }
      const updatedItem = (await res.json()) as Partial<CommunityItem>;
      setItems((prev) => prev.map((communityItem) => (communityItem.id === item.id ? { ...communityItem, ...updatedItem } : communityItem)));
      setSelectedId(null);
      closeReview();
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function requestChanges(item: CommunityItem) {
    const notes = reviewNotes.trim();
    if (!notes) {
      alert("Add review notes before requesting changes.");
      return;
    }
    await runAction("request_changes", item, { reviewNotes: notes });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">🏘️ Community</h1>
      <p className="mt-1 text-sm text-gray-500">Discord announcements, engagement polls, and community updates. Approval-first, no auto-publish yet.</p>

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
            {t.label} <span className="ml-1 text-xs text-gray-600">{counts[t.key] || 0}</span>
          </button>
        ))}
      </div>

      <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{TABS.find((t) => t.key === tab)?.label}</h2>
          <span className="text-xs text-gray-500">{visibleItems.length}</span>
        </div>

        {visibleItems.length === 0 ? (
          <p className="text-sm text-gray-600">No community items here.</p>
        ) : (
          <div className="space-y-3">
            {visibleItems.map((item, index) => {
              const metadata = getMetadata(item);
              const primaryWorkItem = getPrimaryWorkItem(item.id, workItems);
              const publishWorkItem = getPublishWorkItem(item.id, workItems);
              const isSelected = selectedId === item.id;
              const displayDate = getTabDate(item, tab, workItems);
              const group = dateGroupLabel(displayDate);
              const previousGroup = index > 0 ? dateGroupLabel(getTabDate(visibleItems[index - 1], tab, workItems)) : null;
              const shouldGroup = tab === "scheduled" || tab === "published";

              return (
                <div key={item.id}>
                  {shouldGroup && group !== previousGroup && <p className="pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 first:pt-0">{group}</p>}
                  <CommunityQueueCard
                    tab={tab}
                    item={item}
                    workItem={primaryWorkItem}
                    publishWorkItem={publishWorkItem}
                    expanded={isSelected}
                    onToggle={() => setSelectedId(isSelected ? null : item.id)}
                    onReview={() => openReview(item)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selectedReviewItem && (
        <ReviewDrawer
          item={selectedReviewItem}
          workItem={getPrimaryWorkItem(selectedReviewItem.id, workItems)}
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
  workItem,
  notes,
  busyAction,
  onNotesChange,
  onClose,
  onApprove,
  onRequestChanges,
  onReject,
}: {
  item: CommunityItem;
  workItem: LinkedWorkItem | null;
  notes: string;
  busyAction: string | null;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReject: () => void;
}) {
  const metadata = getMetadata(item);
  const copy = getCopy(metadata).trim();
  const pollOptions = metadata.copy?.poll_options || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-4xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-yellow-500/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-yellow-300">Ready to review</span>
                <span className="text-xs text-gray-500">{prettyKind(metadata.kind)} · {getChannelLabel(metadata)}</span>
                {workItem && <span className="text-xs text-gray-500">task: {workItem.status}</span>}
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                {metadata.source?.type && <MetadataPill label="Source" value={metadata.source.type} />}
                {metadata.source?.slug && <MetadataPill label="Slug" value={metadata.source.slug} />}
                {metadata.target?.platform && <MetadataPill label="Platform" value={metadata.target.platform} />}
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">
              Close
            </button>
          </div>
          {metadata.source?.url && (
            <a href={metadata.source.url} target="_blank" rel="noreferrer" className="mt-4 inline-flex text-sm text-blue-400 hover:text-blue-300">
              Open source →
            </a>
          )}
          {metadata.review?.notes && (
            <div className="mt-4 rounded-xl border border-orange-500/20 bg-orange-500/10 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-orange-300">Previous review notes</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-orange-100/90">{metadata.review.notes}</p>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <article className="mx-auto max-w-3xl rounded-2xl border border-gray-800 bg-[#15151d] p-6 text-[16px] leading-7 text-gray-300 shadow-xl">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Draft copy</p>
            {copy ? <CopyPreview copy={copy} /> : <p className="mt-4 text-sm text-red-300">No copy saved yet. The Community work item may still be incomplete.</p>}
            {pollOptions.length > 0 && (
              <div className="mt-6 rounded-xl border border-gray-800 bg-black/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Poll options</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-400">
                  {pollOptions.map((option) => <li key={option}>{option}</li>)}
                </ul>
              </div>
            )}
          </article>
        </div>

        <div className="border-t border-gray-800 bg-[#111118]/95 p-5 shadow-[0_-20px_45px_rgba(0,0,0,0.25)]">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label className="text-sm font-medium text-white" htmlFor="community-review-notes">Review notes</label>
              <p className="mt-1 text-xs text-gray-500">Only required when requesting changes. These notes go back to Community.</p>
              <textarea
                id="community-review-notes"
                value={notes}
                onChange={(event) => onNotesChange(event.target.value)}
                placeholder="Example: make this more conversational, add a stronger reason to click, shorten the post..."
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

function CommunityQueueCard({
  tab,
  item,
  workItem,
  publishWorkItem,
  expanded,
  onToggle,
  onReview,
}: {
  tab: TabKey;
  item: CommunityItem;
  workItem: LinkedWorkItem | null;
  publishWorkItem: LinkedWorkItem | null;
  expanded: boolean;
  onToggle: () => void;
  onReview: () => void;
}) {
  const metadata = getMetadata(item);
  const channel = getPublishChannelLabel(publishWorkItem, metadata);
  const displayDate = tab === "scheduled" ? publishWorkItem?.scheduled_for || null : tab === "published" ? item.published_at : null;
  const taskStatus = publishWorkItem?.status || workItem?.status || item.status;
  const suppressPreviews = publishWorkItem?.payload?.suppress_link_previews === true;
  const copy = getCopy(metadata).trim();
  const borderClass = expanded ? "border-blue-500 bg-blue-500/5" : "border-gray-800 bg-black/10 hover:border-gray-700";

  return (
    <article onClick={onToggle} className={`cursor-pointer rounded-lg border p-4 transition ${borderClass}`}>
      <div className="grid gap-4 lg:grid-cols-[132px_1fr_auto] lg:items-center">
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-center">
          <p className="truncate text-sm font-semibold text-sky-200">{channel}</p>
          {displayDate ? (
            <p className="mt-1 text-xs text-sky-200/70">{formatTime(displayDate)} London</p>
          ) : (
            <p className="mt-1 text-xs text-sky-200/70">canal interno</p>
          )}
        </div>

        <div className="min-w-0">
          <h3 className="truncate font-medium text-white">{item.title}</h3>
          <p className="mt-1 truncate text-sm text-gray-500">{getOneLineCopyPreview(metadata)}</p>
        </div>

        <div className="hidden lg:block" />
      </div>

      {expanded && (
        <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{tab === "published" ? "Published copy" : tab === "review" ? "Draft copy" : "Approved copy"}</p>
          {copy ? <CopyPreview copy={copy} /> : <p className="mt-3 text-sm text-gray-500">No copy saved yet.</p>}
          <div className="mt-4 flex flex-wrap gap-2 text-sm" onClick={(event) => event.stopPropagation()}>
            {tab === "review" && (
              <button onClick={onReview} className="rounded-lg bg-blue-600 px-3 py-2 font-medium text-white transition hover:bg-blue-500">
                Abrir panel de aprobación
              </button>
            )}
            {metadata.source?.url && (
              <a href={metadata.source.url} target="_blank" rel="noreferrer" className="rounded-lg bg-white/10 px-3 py-2 font-medium text-white transition hover:bg-white/15">
                Abrir fuente
              </a>
            )}
            {item.current_url && (
              <a href={item.current_url} target="_blank" rel="noreferrer" className="rounded-lg bg-white/10 px-3 py-2 font-medium text-white transition hover:bg-white/15">
                Abrir post publicado
              </a>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
            <span>Task: {taskStatus}</span>
            {suppressPreviews && <span>No link previews</span>}
            {metadata.review?.notes && <span>Review notes saved</span>}
          </div>
        </div>
      )}
    </article>
  );
}

function CommunityDetails({ item, workItem, publishWorkItem }: { item: CommunityItem; workItem: LinkedWorkItem | null; publishWorkItem: LinkedWorkItem | null }) {
  const metadata = getMetadata(item);
  const pollOptions = metadata.copy?.poll_options || [];

  return (
    <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-4" onClick={(event) => event.stopPropagation()}>
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <Detail label="Type" value={prettyKind(metadata.kind)} />
        <Detail label="Channel" value={getChannelLabel(metadata)} />
        <Detail label="Scheduled" value={formatDate(publishWorkItem?.scheduled_for || null)} />
        <Detail label="Published" value={formatDate(item.published_at)} />
        {metadata.source?.type && <Detail label="Source" value={metadata.source.type} />}
        {publishWorkItem && <Detail label="Publish task" value={`${publishWorkItem.title} · ${publishWorkItem.status}`} />}
        {workItem && <Detail label="Latest work item" value={`${workItem.title} · ${workItem.status}`} />}
      </div>

      {metadata.source?.url && (
        <a href={metadata.source.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm text-blue-400 hover:text-blue-300">
          Open source →
        </a>
      )}
      {item.current_url && (
        <a href={item.current_url} target="_blank" rel="noreferrer" className="ml-4 mt-3 inline-flex text-sm text-blue-400 hover:text-blue-300">
          Open published post →
        </a>
      )}
      {pollOptions.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Poll options</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-400">
            {pollOptions.map((option) => <li key={option}>{option}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function CopyPreview({ copy }: { copy: string }) {
  return (
    <div className="mt-4 space-y-3 whitespace-pre-wrap text-gray-200">
      {copy.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} className="h-2" />;
        if (trimmed.startsWith("- ")) return <p key={index} className="pl-4 text-gray-300">• {renderInline(trimmed.slice(2))}</p>;
        return <p key={index}>{renderInline(trimmed)}</p>;
      })}
    </div>
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

function MetadataPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-gray-800 bg-white/5 px-2.5 py-1">
      <span className="text-gray-600">{label}:</span> <span className="text-gray-400">{value}</span>
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-1 text-gray-300">{value}</p>
    </div>
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
