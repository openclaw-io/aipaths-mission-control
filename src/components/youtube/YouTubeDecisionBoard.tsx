"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import type { LinkedWorkItem, VideoPipelineItem } from "@/app/youtube/page";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";
import { useRealtimeYouTube } from "@/hooks/useRealtimeYouTube";

type JsonRecord = Record<string, unknown>;

type WorkflowColumnKey =
  | "idea_bank"
  | "title_thumbnail"
  | "research"
  | "bullets"
  | "ready_to_record"
  | "editing"
  | "published"
  | "learning"
  | "parked_archived";

type WorkflowViewKey = "prep" | "production" | "learning";

type StageOption = {
  status: string;
  label: string;
};

type WorkflowColumn = {
  key: WorkflowColumnKey;
  title: string;
  hint: string;
  statuses: string[];
};

type ItemDetails = {
  sourceLabel: string | null;
  selectedTitle: string | null;
  youtubeUrl: string | null;
  videoId: string | null;
  nextAction: string | null;
  shortDescription: string | null;
  ideaSection: JsonRecord | null;
  titleSection: JsonRecord | null;
  thumbnailSection: JsonRecord | null;
  opportunityBrief: unknown;
  researchSection: JsonRecord | null;
  bulletsSection: JsonRecord | null;
  publicationSection: JsonRecord | null;
  learningSection: JsonRecord | null;
};

type StageForm = {
  status: string;
  note: string;
  youtubeUrl: string;
  videoId: string;
};

type BoardItemModel = {
  item: VideoPipelineItem;
  details: ItemDetails;
  workItems: LinkedWorkItem[];
};

const WORKFLOW_COLUMNS: WorkflowColumn[] = [
  { key: "idea_bank", title: "Ideas", hint: "Idea bank and loose drafts.", statuses: ["idea", "draft"] },
  { key: "title_thumbnail", title: "Titles", hint: "Title and thumbnail packaging.", statuses: ["title_thumbnail"] },
  { key: "research", title: "Research", hint: "Signals, competitors, report.", statuses: ["research", "researching"] },
  { key: "bullets", title: "Bullets", hint: "Chapters and recording bullets.", statuses: ["bullets"] },
  { key: "ready_to_record", title: "Ready to Record", hint: "Approved package for recording.", statuses: ["ready_to_record"] },
  { key: "editing", title: "Editing", hint: "Recorded footage or active edit.", statuses: ["recorded", "editing"] },
  { key: "published", title: "Published", hint: "Live videos and snapshots.", statuses: ["published"] },
  { key: "learning", title: "Learning", hint: "Review notes and postmortems.", statuses: ["learning"] },
  { key: "parked_archived", title: "Parked / Archived", hint: "Parked, rejected, or closed out.", statuses: ["parked", "rejected", "archived"] },
];

const WORKFLOW_VIEWS: Array<{ key: WorkflowViewKey; title: string; hint: string; columns: WorkflowColumnKey[] }> = [
  { key: "prep", title: "1. Ideas → Titles → Research", hint: "Elegir y probar antes de producir.", columns: ["idea_bank", "title_thumbnail", "research"] },
  { key: "production", title: "2. Bullets → Ready", hint: "Convertir en pieza filmable.", columns: ["bullets", "ready_to_record"] },
  { key: "learning", title: "3. Editing → Published → Learning", hint: "Salida, métricas y aprendizaje.", columns: ["editing", "published", "learning"] },
];

const STAGE_OPTIONS: StageOption[] = [
  { status: "idea", label: "Idea" },
  { status: "draft", label: "Idea Bank" },
  { status: "title_thumbnail", label: "Title / Thumbnail" },
  { status: "research", label: "Research" },
  { status: "researching", label: "Researching" },
  { status: "bullets", label: "Bullets" },
  { status: "ready_to_record", label: "Ready to Record" },
  { status: "recorded", label: "Recorded" },
  { status: "editing", label: "Editing" },
  { status: "published", label: "Published" },
  { status: "learning", label: "Learning" },
  { status: "parked", label: "Parked" },
  { status: "archived", label: "Archived" },
  { status: "rejected", label: "Rejected" },
];

const SELECTABLE_STAGE_STATUSES = new Set(STAGE_OPTIONS.map((option) => option.status));

const STATUS_STYLES: Record<string, string> = {
  idea: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  draft: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  title_thumbnail: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
  research: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  researching: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  bullets: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  ready_to_record: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  recorded: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  editing: "border-orange-500/30 bg-orange-500/10 text-orange-300",
  published: "border-green-500/30 bg-green-500/10 text-green-300",
  learning: "border-lime-500/30 bg-lime-500/10 text-lime-300",
  parked: "border-gray-500/30 bg-gray-500/10 text-gray-300",
  rejected: "border-red-500/30 bg-red-500/10 text-red-300",
  archived: "border-gray-600/30 bg-gray-600/10 text-gray-400",
};

const OPEN_WORK_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);

export function YouTubeDecisionBoard({ initialItems, initialWorkItems }: { initialItems: VideoPipelineItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const [items, setItems] = useRealtimeYouTube(initialItems);
  const realtimeWorkItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stageForm, setStageForm] = useState<StageForm>({ status: "draft", note: "", youtubeUrl: "", videoId: "" });
  const [activeView, setActiveView] = useState<WorkflowViewKey>("prep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoWorkItems = useMemo(() => {
    return realtimeWorkItems.filter((workItem) => {
      const payload = toRecord(workItem.payload);
      return payload.pipeline_type === "video";
    });
  }, [realtimeWorkItems]);

  const itemModels = useMemo<BoardItemModel[]>(() => {
    return items.map((item) => ({
      item,
      details: getItemDetails(item),
      workItems: getLinkedWorkItems(item, videoWorkItems),
    }));
  }, [items, videoWorkItems]);

  const groupedItems = useMemo(() => {
    const groups = WORKFLOW_COLUMNS.reduce((acc, column) => {
      acc[column.key] = [];
      return acc;
    }, {} as Record<WorkflowColumnKey, BoardItemModel[]>);

    for (const model of itemModels) {
      groups[getColumnKey(model.item)].push(model);
    }

    for (const column of WORKFLOW_COLUMNS) {
      groups[column.key].sort((a, b) => new Date(b.item.updated_at).getTime() - new Date(a.item.updated_at).getTime());
    }

    return groups;
  }, [itemModels]);

  const selectedModel = useMemo(() => itemModels.find((model) => model.item.id === selectedId) || null, [itemModels, selectedId]);
  const activeViewConfig = WORKFLOW_VIEWS.find((view) => view.key === activeView) || WORKFLOW_VIEWS[0];
  const activeCount = items.filter((item) => !["parked", "rejected", "archived"].includes(item.status)).length;
  const publishedCount = items.filter((item) => ["published", "learning"].includes(item.status)).length;
  const openWorkCount = videoWorkItems.filter((workItem) => OPEN_WORK_STATUSES.has(workItem.status)).length;

  useEffect(() => {
    if (!selectedModel) return;
    setStageForm({
      status: getSelectableStageStatus(selectedModel.item.status),
      note: "",
      youtubeUrl: selectedModel.details.youtubeUrl || "",
      videoId: selectedModel.details.videoId || "",
    });
    setError(null);
  }, [selectedModel]);

  async function submitStageChange() {
    if (!selectedModel) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/youtube/${selectedModel.item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_stage",
          stage: stageForm.status,
          note: stageForm.note,
          youtube_url: stageForm.youtubeUrl,
          video_id: stageForm.videoId,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(typeof payload.error === "string" ? payload.error : "Stage update failed");
        return;
      }

      const payload = (await response.json()) as { item?: VideoPipelineItem };
      const updatedItem = payload.item;
      if (updatedItem) {
        setItems((current) => current.map((existing) => (existing.id === updatedItem.id ? updatedItem : existing)));
      }
      setSelectedId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">YouTube</h1>
        </div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <StatCard label="Active" value={String(activeCount)} />
          <StatCard label="Published" value={String(publishedCount)} />
          <StatCard label="Open Work" value={String(openWorkCount)} />
        </div>
      </header>

      <div className="mt-6 rounded-2xl border border-gray-800 bg-[#101018] p-2">
        <div className="grid gap-2 md:grid-cols-3">
          {WORKFLOW_VIEWS.map((view) => {
            const count = view.columns.reduce((total, columnKey) => total + groupedItems[columnKey].length, 0);
            const selected = view.key === activeView;
            return (
              <button
                key={view.key}
                type="button"
                onClick={() => setActiveView(view.key)}
                className={`rounded-xl border px-4 py-3 text-left transition ${
                  selected ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-black/20 hover:border-gray-700 hover:bg-white/5"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{view.title}</p>
                    <p className="mt-1 text-xs text-gray-500">{view.hint}</p>
                  </div>
                  <span className="rounded-full border border-gray-700 bg-black/30 px-2 py-0.5 text-xs text-gray-400">{count}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {activeView === "prep" ? (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <WorkflowLane columnKey="title_thumbnail" groupedItems={groupedItems} selectedId={selectedId} onSelect={setSelectedId} />
            <WorkflowLane columnKey="research" groupedItems={groupedItems} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          <WorkflowLane columnKey="idea_bank" groupedItems={groupedItems} selectedId={selectedId} onSelect={setSelectedId} compactGrid />
        </div>
      ) : (
        <div className="mt-6 grid gap-4" style={{ gridTemplateColumns: `repeat(${activeViewConfig.columns.length}, minmax(0, 1fr))` }}>
          {activeViewConfig.columns.map((columnKey) => (
            <WorkflowLane key={columnKey} columnKey={columnKey} groupedItems={groupedItems} selectedId={selectedId} onSelect={setSelectedId} />
          ))}
        </div>
      )}

      {groupedItems.parked_archived.length > 0 && (
        <details className="mt-4 rounded-xl border border-gray-800 bg-[#111118] p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-300">Parked / Archived · {groupedItems.parked_archived.length}</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {groupedItems.parked_archived.map((model) => (
              <VideoCard
                key={model.item.id}
                item={model.item}
                details={model.details}
                selected={model.item.id === selectedId}
                openWorkCount={model.workItems.filter((workItem) => OPEN_WORK_STATUSES.has(workItem.status)).length}
                onSelect={() => setSelectedId(model.item.id)}
              />
            ))}
          </div>
        </details>
      )}

      {selectedModel && (
        <DetailDrawer
          item={selectedModel.item}
          details={selectedModel.details}
          workItems={selectedModel.workItems}
          form={stageForm}
          busy={busy}
          error={error}
          onClose={() => setSelectedId(null)}
          onFormChange={(patch) => setStageForm((current) => ({ ...current, ...patch }))}
          onSubmit={submitStageChange}
        />
      )}
    </div>
  );
}

function WorkflowLane({
  columnKey,
  groupedItems,
  selectedId,
  onSelect,
  compactGrid = false,
}: {
  columnKey: WorkflowColumnKey;
  groupedItems: Record<WorkflowColumnKey, BoardItemModel[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  compactGrid?: boolean;
}) {
  const column = WORKFLOW_COLUMNS.find((entry) => entry.key === columnKey)!;
  const columnItems = groupedItems[column.key];

  return (
    <section className="rounded-xl border border-gray-800 bg-[#111118] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">{column.title}</h2>
          <p className="mt-1 text-xs leading-5 text-gray-600">{column.hint}</p>
        </div>
        <span className="shrink-0 rounded-full border border-gray-800 bg-black/30 px-2 py-0.5 text-xs text-gray-400">{columnItems.length}</span>
      </div>

      <div className={`mt-3 gap-3 ${compactGrid ? "grid md:grid-cols-2 xl:grid-cols-3" : "space-y-3"}`}>
        {columnItems.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-800 bg-black/10 px-3 py-5 text-center text-xs text-gray-600">Empty</p>
        ) : (
          columnItems.map((model) => (
            <VideoCard
              key={model.item.id}
              item={model.item}
              details={model.details}
              selected={model.item.id === selectedId}
              openWorkCount={model.workItems.filter((workItem) => OPEN_WORK_STATUSES.has(workItem.status)).length}
              onSelect={() => onSelect(model.item.id)}
              compact={compactGrid}
            />
          ))
        )}
      </div>
    </section>
  );
}

function VideoCard({
  item,
  details,
  selected,
  openWorkCount,
  onSelect,
  compact = false,
}: {
  item: VideoPipelineItem;
  details: ItemDetails;
  selected: boolean;
  openWorkCount: number;
  onSelect: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border p-3 text-left transition ${
        selected ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-black/20 hover:border-gray-700 hover:bg-white/5"
      }`}
    >
      {compact ? (
        <>
          <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-white">{item.title}</h3>
          {details.shortDescription && <p className="mt-2 line-clamp-3 text-xs leading-5 text-gray-400">{details.shortDescription}</p>}
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[item.status] || "border-gray-700 bg-gray-700/10 text-gray-300"}`}>
              {formatStatus(item.status)}
            </span>
            <span className="shrink-0 text-[11px] text-gray-600">{formatDate(item.updated_at)}</span>
          </div>
          <h3 className="mt-3 line-clamp-3 text-sm font-semibold leading-5 text-white">{item.title}</h3>

          <div className="mt-3 space-y-2 text-xs leading-5 text-gray-400">
            {details.shortDescription && <p className="line-clamp-3">{details.shortDescription}</p>}
            {details.sourceLabel && <InfoLine label="Source" value={details.sourceLabel} />}
            {details.selectedTitle && <InfoLine label="Selected" value={details.selectedTitle} />}
            {["published", "learning"].includes(item.status) && details.youtubeUrl && <InfoLine label="YouTube" value={details.youtubeUrl} />}
            {details.nextAction && <InfoLine label="Next" value={details.nextAction} />}
            {openWorkCount > 0 && <InfoLine label="Work" value={`${openWorkCount} open item${openWorkCount === 1 ? "" : "s"}`} />}
          </div>
        </>
      )}
    </button>
  );
}

function DetailDrawer({
  item,
  details,
  workItems,
  form,
  busy,
  error,
  onClose,
  onFormChange,
  onSubmit,
}: {
  item: VideoPipelineItem;
  details: ItemDetails;
  workItems: LinkedWorkItem[];
  form: StageForm;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onFormChange: (patch: Partial<StageForm>) => void;
  onSubmit: () => void;
}) {
  const showPublishFields = form.status === "published";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-4xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status] || "border-gray-700 bg-gray-700/10 text-gray-300"}`}>
                  {formatStatus(item.status)}
                </span>
                {details.sourceLabel && <span className="text-xs text-gray-500">{details.sourceLabel}</span>}
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
              {details.selectedTitle && <p className="mt-2 text-sm text-gray-400">Selected title: {details.selectedTitle}</p>}
            </div>
            <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/15" aria-label="Close details">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <section className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-white">Move Stage</h3>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={onSubmit}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
              >
                <ArrowRight className="h-4 w-4" />
                {busy ? "Moving..." : "Move"}
              </button>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Stage">
                <select
                  value={form.status}
                  onChange={(event) => onFormChange({ status: event.target.value })}
                  className="w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                >
                  {STAGE_OPTIONS.map((option) => (
                    <option key={option.status} value={option.status}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Note">
                <input
                  value={form.note}
                  onChange={(event) => onFormChange({ note: event.target.value })}
                  placeholder="Optional stage note"
                  className="w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                />
              </Field>
            </div>

            {showPublishFields && (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="YouTube URL">
                  <input
                    value={form.youtubeUrl}
                    onChange={(event) => onFormChange({ youtubeUrl: event.target.value })}
                    placeholder="https://youtube.com/watch?v=..."
                    className="w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                  />
                </Field>
                <Field label="Video ID">
                  <input
                    value={form.videoId}
                    onChange={(event) => onFormChange({ videoId: event.target.value })}
                    placeholder="Optional if URL is present"
                    className="w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                  />
                </Field>
              </div>
            )}

            {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
          </section>

          <div className="mt-6 space-y-4">
            <CurrentStagePanel item={item} details={details} />

            {workItems.length > 0 && (
              <details className="rounded-xl border border-gray-800 bg-[#14141c] p-4">
                <summary className="cursor-pointer text-base font-semibold text-white">Work Items · {workItems.length}</summary>
                <div className="mt-3 space-y-2">
                  {workItems.slice(0, 8).map((workItem) => (
                    <div key={workItem.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-800 pt-2 text-sm">
                      <span className="text-gray-300">{workItem.title}</span>
                      <span className="text-xs text-gray-500">{formatStatus(workItem.status)}{workItem.scheduled_for ? ` - ${formatDate(workItem.scheduled_for)}` : ""}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <details className="rounded-xl border border-gray-800 bg-[#14141c] p-4">
              <summary className="cursor-pointer text-base font-semibold text-white">Ver metadata completa</summary>
              <div className="mt-4 space-y-4">
                <PracticalSection title="Idea / Intel" value={details.ideaSection} />
                <PracticalSection title="Titles" value={details.titleSection} />
                <PracticalSection title="Thumbnail" value={details.thumbnailSection} />
                <PracticalSection title="Research" value={details.researchSection} />
                <PracticalSection title="Bullets / Recording" value={details.bulletsSection} />
                <PracticalSection title="Publication" value={details.publicationSection} />
                <PracticalSection title="Learning" value={details.learningSection} />
              </div>
            </details>
          </div>
        </div>
      </aside>
    </div>
  );
}

function getColumnKey(item: VideoPipelineItem): WorkflowColumnKey {
  const matched = WORKFLOW_COLUMNS.find((column) => column.statuses.includes(item.status));
  if (matched) return matched.key;
  if (item.published_at || item.current_url) return "published";
  return "idea_bank";
}

function getSelectableStageStatus(status: string) {
  if (SELECTABLE_STAGE_STATUSES.has(status)) return status;
  if (status === "preparing_production") return "bullets";
  if (status === "changes_requested") return "research";
  if (status === "publishing") return "editing";
  if (status === "live") return "published";
  return "draft";
}

function getItemDetails(item: VideoPipelineItem): ItemDetails {
  const metadata = toRecord(item.metadata);
  const youtubeV0 = toRecord(metadata.youtube_v0);
  const selectedTitle = firstStringFromPaths([youtubeV0, metadata], [
    ["selected_title"],
    ["title_lab", "selected_title"],
    ["title", "selected"],
    ["title", "selected_title"],
    ["packaging", "selected_title"],
    ["packaging", "title"],
    ["title_packaging", "selected_title"],
  ]);
  const youtubeUrl = firstStringFromPaths([youtubeV0, metadata], [
    ["youtube_url"],
    ["url"],
    ["publication", "youtube_url"],
    ["publication", "url"],
    ["published", "youtube_url"],
    ["video", "youtube_url"],
  ]) || item.current_url;
  const videoId = firstStringFromPaths([youtubeV0, metadata], [
    ["video_id"],
    ["youtube_video_id"],
    ["publication", "video_id"],
    ["published", "video_id"],
    ["video", "id"],
  ]) || extractYouTubeVideoId(youtubeUrl);
  const nextAction = firstStringFromPaths([youtubeV0, metadata], [
    ["next_action"],
    ["next"],
    ["action_needed"],
    ["stage_next_action"],
  ]);
  const sourceLabel = getSourceLabel(item, metadata, youtubeV0);
  const shortDescription = getShortDescription(metadata, youtubeV0);

  const ideaSection = compactRecord({
    concept: firstPresent(youtubeV0.concept, metadata.concept, getValueAt(metadata, ["overview", "concept"])),
    summary: firstPresent(youtubeV0.summary, youtubeV0.idea_summary, metadata.decision_summary, metadata.summary, metadata.raw_intel_summary, metadata.intel_summary),
    raw_intel: firstPresent(youtubeV0.raw_intel, metadata.raw_intel, metadata.intel),
    source: firstPresent(youtubeV0.source, metadata.source, sourceLabel),
  });

  const titleSection = compactRecord({
    selected_title: selectedTitle,
    candidates: firstPresent(
      getValueAt(youtubeV0, ["title_lab", "candidates"]),
      getValueAt(youtubeV0, ["title_lab", "recommended_shortlist"]),
      youtubeV0.title_candidates,
      youtubeV0.titles,
      metadata.title_candidates,
      metadata.titles,
      getValueAt(metadata, ["packaging", "title_candidates"]),
      getValueAt(metadata, ["packaging", "titles"]),
      getValueAt(metadata, ["title_packaging", "candidates"]),
    ),
    notes: firstPresent(getValueAt(youtubeV0, ["title_lab", "notes"]), youtubeV0.title_notes, metadata.title_notes, getValueAt(metadata, ["packaging", "title_notes"])),
  });

  const thumbnailSection = compactRecord({
    notes: firstPresent(youtubeV0.thumbnail_notes, metadata.thumbnail_notes, getValueAt(metadata, ["packaging", "thumbnail_notes"])),
    thumbnail: firstPresent(getValueAt(youtubeV0, ["title_lab", "thumbnail_directions"]), youtubeV0.thumbnail, metadata.thumbnail, getValueAt(metadata, ["packaging", "thumbnail"])),
    upload: firstPresent(youtubeV0.thumbnail_upload, metadata.thumbnail_upload, metadata.thumbnail_fields, getValueAt(metadata, ["production", "thumbnail_upload"])),
  });

  const opportunityBrief = firstPresent(
    youtubeV0.opportunity_brief_md,
    youtubeV0.opportunity_brief,
    getValueAt(youtubeV0, ["light_research", "opportunity_brief_md"]),
    getValueAt(youtubeV0, ["light_research", "opportunity_brief"]),
  );

  const researchSection = compactRecord({
    opportunity_brief: opportunityBrief,
    light_research: firstPresent(youtubeV0.light_research, metadata.light_research),
    deep_research: firstPresent(youtubeV0.deep_research, metadata.deep_research),
    report: firstPresent(youtubeV0.report, metadata.report, metadata.research_report),
    research: firstPresent(youtubeV0.research, metadata.research, metadata.evidence),
  });

  const bulletsSection = compactRecord({
    chapters: firstPresent(youtubeV0.chapters, metadata.chapters, getValueAt(metadata, ["retention", "chapters"])),
    recording_bullets: firstPresent(
      youtubeV0.recording_bullets,
      youtubeV0.bullets,
      metadata.recording_bullets,
      metadata.bullets,
      getValueAt(metadata, ["production", "recording_bullets"]),
    ),
    structure: firstPresent(youtubeV0.structure, metadata.structure, metadata.retention),
  });

  const publicationSection = compactRecord({
    youtube_url: youtubeUrl,
    video_id: videoId,
    published_at: item.published_at,
    current_url: item.current_url,
    publication: firstPresent(youtubeV0.publication, metadata.publication, metadata.published),
  });

  const learningSection = compactRecord({
    notes: firstPresent(youtubeV0.learning_notes, metadata.learning_notes, metadata.post_publication_notes),
    learning: firstPresent(youtubeV0.learning, metadata.learning, metadata.post_publication, metadata.postmortem),
  });

  return {
    sourceLabel,
    selectedTitle,
    youtubeUrl,
    videoId,
    nextAction,
    shortDescription,
    ideaSection,
    titleSection,
    thumbnailSection,
    opportunityBrief,
    researchSection,
    bulletsSection,
    publicationSection,
    learningSection,
  };
}


function getShortDescription(metadata: JsonRecord, youtubeV0: JsonRecord) {
  const intel = toRecord(metadata.intel);
  const analysis = toRecord(metadata.analysis);
  const description = firstStringFromPaths([youtubeV0, metadata, intel, analysis], [
    ["short_description"],
    ["description"],
    ["summary"],
    ["idea_summary"],
    ["summary_short"],
    ["why_it_matters"],
    ["core_hypothesis"],
    ["notes"],
  ]);
  if (!description) return null;
  return description.length > 260 ? `${description.slice(0, 257).trim()}...` : description;
}

function getLinkedWorkItems(item: VideoPipelineItem, workItems: LinkedWorkItem[]) {
  return workItems.filter((workItem) => {
    const payload = toRecord(workItem.payload);
    return workItem.source_id === item.id || payload.pipeline_item_id === item.id;
  });
}

function getSourceLabel(item: VideoPipelineItem, metadata: JsonRecord, youtubeV0: JsonRecord) {
  const fromMetadata = firstStringFromPaths([youtubeV0, metadata], [
    ["source_label"],
    ["source_title"],
    ["source_url"],
    ["intel_title"],
    ["intel_url"],
    ["intel", "title"],
    ["intel", "url"],
    ["source", "title"],
    ["source", "url"],
    ["destination_label"],
  ]);
  if (fromMetadata) return fromMetadata;
  if (item.source_type && item.source_id) return `${item.source_type}: ${item.source_id}`;
  if (item.source_type) return item.source_type;
  return null;
}


function CurrentStagePanel({ item, details }: { item: VideoPipelineItem; details: ItemDetails }) {
  const section = getCurrentStageSection(item, details);

  return (
    <section className="rounded-xl border border-gray-800 bg-[#14141c] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-blue-300">Ahora importa</p>
          <h3 className="mt-1 text-lg font-semibold text-white">{section.title}</h3>
          <p className="mt-1 text-sm text-gray-500">{section.hint}</p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status] || "border-gray-700 bg-gray-700/10 text-gray-300"}`}>
          {formatStatus(item.status)}
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {section.blocks.map((block) => (
          <MiniBlock key={block.label} label={block.label} value={block.value} wide={block.wide} />
        ))}
      </div>
    </section>
  );
}

function MiniBlock({ label, value, wide }: { label: string; value: unknown; wide?: boolean }) {
  if (!hasContent(value)) return null;

  return (
    <div className={`rounded-xl border border-gray-800 bg-black/20 p-3 ${wide ? "md:col-span-2" : ""}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</p>
      <div className="mt-2 text-sm leading-6 text-gray-300">
        <StructuredValue value={value} />
      </div>
    </div>
  );
}

function getCurrentStageSection(item: VideoPipelineItem, details: ItemDetails) {
  const metadata = toRecord(item.metadata);
  const intel = toRecord(metadata.intel);
  const packaging = toRecord(metadata.packaging);
  const recording = toRecord(metadata.recording);
  const production = toRecord(metadata.production);
  const publication = toRecord(metadata.publication);

  if (["idea", "draft"].includes(item.status)) {
    return {
      title: "Decidir si vale la pena desarrollar la idea",
      hint: "Solo lo necesario para decidir si pasa a títulos/research liviano.",
      blocks: [
        { label: "Resumen", value: firstPresent(getValueAt(intel, ["summary_short"]), metadata.notes, details.ideaSection), wide: true },
        { label: "Por qué importa", value: firstPresent(getValueAt(intel, ["why_it_matters"]), getValueAt(metadata, ["analysis", "core_hypothesis"])), wide: true },
        { label: "Fuente", value: firstPresent(getValueAt(intel, ["source_url"]), details.sourceLabel) },
        { label: "Tags", value: getValueAt(intel, ["tags"]) },
      ],
    };
  }

  if (item.status === "title_thumbnail") {
    return {
      title: "Resumen para decidir package",
      hint: "Brief corto para priorizar: persona, promesa, riesgo, score y recomendación.",
      blocks: [
        { label: "Video Opportunity Brief", value: details.opportunityBrief || details.researchSection || details.titleSection, wide: true },
      ],
    };
  }

  if (["research", "researching"].includes(item.status)) {
    return {
      title: "Validar research y ángulo AIPaths",
      hint: "Evidencia, gap y razón para hacer este video.",
      blocks: [
        { label: "Hipótesis", value: getValueAt(metadata, ["analysis", "core_hypothesis"]), wide: true },
        { label: "Evidencia", value: getValueAt(metadata, ["analysis", "evidence"]), wide: true },
        { label: "Research", value: details.researchSection, wide: true },
      ],
    };
  }

  if (item.status === "bullets") {
    return {
      title: "Convertir en estructura filmable",
      hint: "Bullets cronológicos, capítulos y flujo de grabación.",
      blocks: [
        { label: "Intro", value: firstPresent(recording.intro_locked, recording.intro_v2, recording.intro_v1), wide: true },
        { label: "Bullets", value: firstPresent(recording.bullet_points_locked, recording.film_bullets_v2, recording.film_bullets, recording.bullets, details.bulletsSection), wide: true },
      ],
    };
  }

  if (item.status === "ready_to_record") {
    return {
      title: "Checklist final antes de grabar",
      hint: "Lo mínimo que necesitás tener a mano al grabar.",
      blocks: [
        { label: "Título final", value: details.selectedTitle },
        { label: "Hook / intro", value: firstPresent(packaging.hook, recording.intro_locked, recording.intro_v2), wide: true },
        { label: "Bullets locked", value: firstPresent(recording.bullet_points_locked, recording.film_bullets_v2, recording.film_bullets), wide: true },
        { label: "CTA", value: recording.cta },
      ],
    };
  }

  if (["recorded", "editing"].includes(item.status)) {
    return {
      title: "Editar y cerrar assets",
      hint: "Notas de edición, links y estado de producción.",
      blocks: [
        { label: "Estado edición", value: firstPresent(production.edit_status, production.status) },
        { label: "Assets", value: production.asset_links, wide: true },
        { label: "Notas", value: firstPresent(production.notes, metadata.notes), wide: true },
      ],
    };
  }

  if (item.status === "published") {
    return {
      title: "Confirmar publicación y snapshots",
      hint: "URL, ID y tareas de medición post-publicación.",
      blocks: [
        { label: "YouTube URL", value: firstPresent(details.youtubeUrl, publication.url) },
        { label: "Video ID", value: details.videoId },
        { label: "Published at", value: item.published_at },
        { label: "Notas publicación", value: publication.note, wide: true },
      ],
    };
  }

  if (item.status === "learning") {
    return {
      title: "Extraer aprendizajes",
      hint: "Performance, comentarios, objeciones y qué hacemos distinto la próxima vez.",
      blocks: [
        { label: "Learning notes", value: details.learningSection, wide: true },
        { label: "Publication", value: details.publicationSection, wide: true },
      ],
    };
  }

  return {
    title: "Estado actual",
    hint: "Resumen mínimo del item.",
    blocks: [
      { label: "Idea", value: details.ideaSection, wide: true },
      { label: "Publication", value: details.publicationSection, wide: true },
    ],
  };
}

function PracticalSection({ title, value }: { title: string; value: unknown }) {
  if (!hasContent(value)) return null;

  return (
    <section className="rounded-xl border border-gray-800 bg-[#14141c] p-4">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <div className="mt-3 text-sm leading-6 text-gray-300">
        <StructuredValue value={value} />
      </div>
    </section>
  );
}

function StructuredValue({ value }: { value: unknown }): ReactNode {
  if (!hasContent(value)) return null;
  if (typeof value === "string") {
    return looksLikeMarkdown(value) ? <MarkdownBrief value={value} /> : <p className="whitespace-pre-wrap">{value.trim()}</p>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p>{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="space-y-2">
        {value.filter(hasContent).map((entry, index) => (
          <li key={index} className="border-t border-gray-800 pt-2 first:border-t-0 first:pt-0">
            <StructuredValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }

  const entries = Object.entries(toRecord(value)).filter(([, entry]) => hasContent(entry));
  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      {entries.map(([key, entry]) => (
        <div key={key} className="border-t border-gray-800 pt-3 first:border-t-0 first:pt-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{formatKeyLabel(key)}</p>
          <div className="mt-1">
            <StructuredValue value={entry} />
          </div>
        </div>
      ))}
    </div>
  );
}


function looksLikeMarkdown(value: string) {
  return /^#{1,3}\s+/m.test(value) || /^-\s+/m.test(value) || /^\d+\.\s+/m.test(value);
}

function MarkdownBrief({ value }: { value: string }) {
  const lines = value.trim().split(/\r?\n/);
  const elements: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    elements.push(
      <ul key={`list-${elements.length}`} className="ml-5 list-disc space-y-1 text-gray-300">
        {items.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      return;
    }

    if (line.startsWith("### ")) {
      flushList();
      elements.push(<h4 key={`h4-${elements.length}`} className="pt-3 text-sm font-semibold text-blue-200">{renderInlineMarkdown(line.slice(4))}</h4>);
      return;
    }
    if (line.startsWith("## ")) {
      flushList();
      elements.push(<h3 key={`h3-${elements.length}`} className="text-base font-semibold text-white">{renderInlineMarkdown(line.slice(3))}</h3>);
      return;
    }
    if (line.startsWith("# ")) {
      flushList();
      elements.push(<h3 key={`h3-${elements.length}`} className="text-lg font-semibold text-white">{renderInlineMarkdown(line.slice(2))}</h3>);
      return;
    }
    if (line.startsWith("- ")) {
      listItems.push(line.slice(2));
      return;
    }

    flushList();
    elements.push(<p key={`p-${elements.length}`} className="text-gray-300">{renderInlineMarkdown(line)}</p>);
  });
  flushList();

  return <div className="space-y-2">{elements}</div>;
}

function renderInlineMarkdown(value: string): ReactNode {
  const parts = value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  if (parts.length === 1) return value;
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <p className="mb-2 text-sm font-medium text-white">{label}</p>
      {children}
    </label>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="text-gray-600">{label}:</span> <span className="break-words text-gray-300">{value}</span>
    </p>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#111118] px-4 py-3 text-right">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
    </div>
  );
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function getValueAt(record: JsonRecord, path: string[]) {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonRecord)[key];
  }
  return current;
}

function firstStringFromPaths(records: JsonRecord[], paths: string[][]) {
  for (const record of records) {
    for (const path of paths) {
      const value = getValueAt(record, path);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => hasContent(value)) ?? null;
}

function compactRecord(record: JsonRecord) {
  const entries = Object.entries(record).filter(([, value]) => hasContent(value));
  return entries.length ? Object.fromEntries(entries) : null;
}

function hasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value as JsonRecord).some(hasContent);
  return true;
}

function extractYouTubeVideoId(url: string | null) {
  if (!url) return null;
  const watchMatch = url.match(/[?&]v=([^&]+)/);
  if (watchMatch?.[1]) return watchMatch[1];
  const shortMatch = url.match(/youtu\.be\/([^?&/]+)/);
  if (shortMatch?.[1]) return shortMatch[1];
  return null;
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

function formatKeyLabel(key: string) {
  return key.replaceAll("_", " ");
}

function formatDate(value: string | null) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value));
}
