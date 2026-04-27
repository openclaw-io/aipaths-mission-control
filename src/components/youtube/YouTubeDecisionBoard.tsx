"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { LinkedWorkItem, VideoPipelineItem } from "@/app/youtube/page";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";
import { useRealtimeYouTube } from "@/hooks/useRealtimeYouTube";
import {
  YOUTUBE_GATE_META,
  YOUTUBE_GATE_ORDER,
  YOUTUBE_GATE_STATUSES,
  type JsonRecord,
  type YouTubeGateKey,
  type YouTubeGateStatus,
  derivePipelineItemStatus,
  getGateEntry,
  getGateStatus,
  getNextDecision,
  getScores,
  getTopLevelNextAction,
  getYouTubeMetadata,
} from "@/lib/youtube-pipeline";

type DecisionGroupKey = YouTubeGateKey | "killed" | "completed";

const STATUS_STYLES: Record<YouTubeGateStatus, string> = {
  not_started: "bg-slate-500/20 text-slate-300",
  in_progress: "bg-sky-500/20 text-sky-300",
  pass: "bg-emerald-500/20 text-emerald-300",
  rework: "bg-amber-500/20 text-amber-300",
  kill: "bg-red-500/20 text-red-300",
  experiment: "bg-fuchsia-500/20 text-fuchsia-300",
  blocked: "bg-orange-500/20 text-orange-300",
};

const ITEM_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-500/20 text-slate-300",
  researching: "bg-sky-500/20 text-sky-300",
  changes_requested: "bg-amber-500/20 text-amber-300",
  preparing_production: "bg-violet-500/20 text-violet-300",
  ready_to_record: "bg-emerald-500/20 text-emerald-300",
  published: "bg-green-500/20 text-green-300",
  archived: "bg-gray-500/20 text-gray-300",
  rejected: "bg-red-500/20 text-red-300",
  parked: "bg-slate-500/20 text-slate-300",
};

const DECISION_GROUPS: Array<{ key: DecisionGroupKey; title: string; description: string }> = [
  { key: "strategic_fit", title: "Strategic Fit", description: "Should this video exist in AIPaths?" },
  { key: "demand_validation", title: "Demand Validation", description: "Is there evidence people already want this?" },
  { key: "supply_gap", title: "Supply Gap", description: "Do we have a real angle or differentiated gap?" },
  { key: "promise", title: "Promise", description: "Can the viewer outcome be stated clearly and proven?" },
  { key: "packaging", title: "Packaging", description: "Do title, thumbnail, and hook create a click reason?" },
  { key: "retention_design", title: "Retention Design", description: "Will the viewer stay once they click?" },
  { key: "conversion_fit", title: "Conversion Fit", description: "Does the video connect naturally to the business?" },
  { key: "film_ready", title: "Film Ready", description: "Is production prepared enough to record?" },
  { key: "postmortem", title: "Post-mortem", description: "Compare prediction vs reality and close the loop." },
  { key: "killed", title: "Killed", description: "Ideas that failed a gate and should not continue." },
  { key: "completed", title: "Completed", description: "Videos that passed the learning loop." },
];

type TransitionFormState = {
  gateKey: YouTubeGateKey;
  gateStatus: YouTubeGateStatus;
  reason: string;
  evidenceSummary: string;
  nextAction: string;
  workItemRelationType: string;
};

export function YouTubeDecisionBoard({ initialItems, initialWorkItems }: { initialItems: VideoPipelineItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const [items, setItems] = useRealtimeYouTube(initialItems);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [transitionForm, setTransitionForm] = useState<TransitionFormState | null>(null);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId) || null, [items, selectedId]);

  const groupedItems = useMemo(() => {
    const groups = Object.fromEntries(DECISION_GROUPS.map((group) => [group.key, [] as VideoPipelineItem[]])) as Record<DecisionGroupKey, VideoPipelineItem[]>;

    for (const item of items) {
      const metadata = getYouTubeMetadata(item.metadata);
      const nextDecision = getNextDecision(metadata);

      if (nextDecision.type === "killed") {
        groups.killed.push(item);
      } else if (nextDecision.type === "completed") {
        groups.completed.push(item);
      } else {
        groups[nextDecision.gateKey].push(item);
      }
    }

    for (const group of DECISION_GROUPS) {
      groups[group.key].sort((a, b) => {
        const scoreDiff = getScores(getYouTubeMetadata(b.metadata)).priority - getScores(getYouTubeMetadata(a.metadata)).priority;
        if (scoreDiff !== 0) return scoreDiff;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
    }

    return groups;
  }, [items]);

  useEffect(() => {
    if (!selectedItem) {
      setTransitionForm(null);
      return;
    }

    const metadata = getYouTubeMetadata(selectedItem.metadata);
    const currentDecision = getNextDecision(metadata);
    const defaultGateKey = currentDecision.gateKey;
    const gateEntry = getGateEntry(metadata, defaultGateKey);

    setTransitionForm({
      gateKey: defaultGateKey,
      gateStatus: getGateStatus(metadata, defaultGateKey),
      reason: gateEntry.reason || "",
      evidenceSummary: gateEntry.evidence_summary || "",
      nextAction: gateEntry.next_action || metadata.next_action || "",
      workItemRelationType: defaultGateKey,
    });
  }, [selectedItem]);

  function selectItem(item: VideoPipelineItem) {
    setSelectedId(item.id);
  }

  function patchTransitionForm(patch: Partial<TransitionFormState>) {
    setTransitionForm((current) => (current ? { ...current, ...patch } : current));
  }

  function handleGateChange(item: VideoPipelineItem, gateKey: YouTubeGateKey) {
    const metadata = getYouTubeMetadata(item.metadata);
    const gateEntry = getGateEntry(metadata, gateKey);
    patchTransitionForm({
      gateKey,
      gateStatus: getGateStatus(metadata, gateKey),
      reason: gateEntry.reason || "",
      evidenceSummary: gateEntry.evidence_summary || "",
      nextAction: gateEntry.next_action || metadata.next_action || "",
      workItemRelationType: gateKey,
    });
  }

  async function submitTransition(item: VideoPipelineItem, options?: { createWorkItem?: boolean }) {
    if (!transitionForm) return;

    const actionKey = options?.createWorkItem ? "save_and_create_task" : "save_gate";
    setBusyAction(`${item.id}:${actionKey}`);
    try {
      const response = await fetch(`/api/youtube/${item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateKey: transitionForm.gateKey,
          gateStatus: transitionForm.gateStatus,
          reason: transitionForm.reason,
          evidenceSummary: transitionForm.evidenceSummary,
          nextAction: transitionForm.nextAction,
          createWorkItem: options?.createWorkItem === true,
          workItemRelationType: transitionForm.workItemRelationType,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Action failed");
        return;
      }

      const payload = (await response.json()) as { item: VideoPipelineItem };
      setItems((current) => current.map((existing) => (existing.id === item.id ? payload.item : existing)));
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  const counts = useMemo(() => Object.fromEntries(DECISION_GROUPS.map((group) => [group.key, groupedItems[group.key].length])) as Record<DecisionGroupKey, number>, [groupedItems]);
  const activeItems = items.filter((item) => !["rejected", "archived"].includes(item.status)).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">🎬 YouTube</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            Decision board for video ideas. Each card is grouped by the next unanswered gate, so the board shows what must be decided next instead of where production happens to be.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <StatCard label="Open videos" value={String(activeItems)} />
          <StatCard label="Killed" value={String(counts.killed || 0)} />
          <StatCard label="Completed" value={String(counts.completed || 0)} />
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {DECISION_GROUPS.map((group) => {
          const groupItems = groupedItems[group.key];
          return (
            <section key={group.key} className="rounded-2xl border border-gray-800 bg-[#111118] p-4 shadow-[0_10px_35px_rgba(0,0,0,0.18)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">{group.title}</h2>
                  <p className="mt-1 text-sm text-gray-500">{group.description}</p>
                </div>
                <span className="rounded-full border border-gray-800 bg-black/20 px-2.5 py-1 text-xs text-gray-400">{groupItems.length}</span>
              </div>

              {groupItems.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed border-gray-800 bg-black/10 px-4 py-6 text-sm text-gray-600">No videos in this decision bucket.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {groupItems.map((item) => {
                    const metadata = getYouTubeMetadata(item.metadata);
                    const scores = getScores(metadata);
                    const currentDecision = getNextDecision(metadata);
                    const currentGateKey = currentDecision.gateKey;
                    const currentGate = getGateEntry(metadata, currentGateKey);
                    const gateWorkItem = getPrimaryGateWorkItem(item.id, currentGateKey, workItems);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => selectItem(item)}
                        className={`w-full rounded-2xl border p-4 text-left transition ${
                          selectedId === item.id ? "border-blue-500 bg-blue-500/5" : "border-gray-800 bg-black/15 hover:border-gray-700 hover:bg-white/5"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                              {metadata.pillar && <span>{metadata.pillar}</span>}
                              <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[currentDecision.status]}`}>{formatGateStatus(currentDecision.status)}</span>
                              <span className={`rounded-full px-2 py-0.5 ${ITEM_STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{formatItemStatus(item.status)}</span>
                            </div>
                            <h3 className="mt-2 text-base font-semibold text-white">{item.title}</h3>
                            <p className="mt-2 text-sm text-gray-400">Current gate: {YOUTUBE_GATE_META[currentGateKey].label}</p>
                          </div>
                          <div className="shrink-0 text-right text-xs text-gray-500">
                            <div>{formatDate(item.updated_at)}</div>
                            {gateWorkItem && <div className="mt-2 text-sky-300">task: {gateWorkItem.status}</div>}
                          </div>
                        </div>

                        <div className="mt-4 grid gap-2 sm:grid-cols-5">
                          <ScorePill label="Reach" value={scores.reach} />
                          <ScorePill label="Retention" value={scores.retention} />
                          <ScorePill label="Conversion" value={scores.conversion} />
                          <ScorePill label="Confidence" value={scores.confidence} />
                          <ScorePill label="Priority" value={scores.priority} highlight />
                        </div>

                        <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Next action</p>
                          <p className="mt-1 text-sm text-gray-300">{currentGate.next_action || getTopLevelNextAction(metadata)}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {selectedItem && transitionForm && (
        <DetailDrawer
          item={selectedItem}
          workItems={workItems}
          form={transitionForm}
          busyAction={busyAction}
          onClose={() => setSelectedId(null)}
          onFormChange={patchTransitionForm}
          onGateChange={(gateKey) => handleGateChange(selectedItem, gateKey)}
          onSave={() => submitTransition(selectedItem)}
          onSaveAndCreateTask={() => submitTransition(selectedItem, { createWorkItem: true })}
        />
      )}
    </div>
  );
}

function DetailDrawer({
  item,
  workItems,
  form,
  busyAction,
  onClose,
  onFormChange,
  onGateChange,
  onSave,
  onSaveAndCreateTask,
}: {
  item: VideoPipelineItem;
  workItems: LinkedWorkItem[];
  form: TransitionFormState;
  busyAction: string | null;
  onClose: () => void;
  onFormChange: (patch: Partial<TransitionFormState>) => void;
  onGateChange: (gateKey: YouTubeGateKey) => void;
  onSave: () => void;
  onSaveAndCreateTask: () => void;
}) {
  const metadata = getYouTubeMetadata(item.metadata);
  const scores = getScores(metadata);
  const nextDecision = getNextDecision(metadata);
  const selectedGateEntry = getGateEntry(metadata, form.gateKey);
  const primaryWorkItem = getPrimaryGateWorkItem(item.id, form.gateKey, workItems);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-5xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {metadata.pillar && <span>{metadata.pillar}</span>}
                {metadata.target_viewer && <span>{metadata.target_viewer}</span>}
                <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[nextDecision.status]}`}>{formatGateStatus(nextDecision.status)}</span>
                <span className={`rounded-full px-2 py-0.5 ${ITEM_STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{formatItemStatus(item.status)}</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
              <p className="mt-2 text-sm text-gray-400">Current decision: {nextDecision.label}</p>
            </div>
            <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">
              Close
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            <ScorePill label="Reach" value={scores.reach} />
            <ScorePill label="Retention" value={scores.retention} />
            <ScorePill label="Conversion" value={scores.conversion} />
            <ScorePill label="Confidence" value={scores.confidence} />
            <ScorePill label="Priority" value={scores.priority} highlight />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <section className="rounded-2xl border border-gray-800 bg-[#14141c] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Gate decision</h3>
                <p className="mt-1 text-sm text-gray-500">Update the current gate verdict, save the reason, and optionally spawn a YouTube task for this gate.</p>
              </div>
              {primaryWorkItem && (
                <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-300">
                  open task: {primaryWorkItem.title} · {primaryWorkItem.status}
                </span>
              )}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Gate">
                <select
                  value={form.gateKey}
                  onChange={(event) => onGateChange(event.target.value as YouTubeGateKey)}
                  className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                >
                  {YOUTUBE_GATE_ORDER.map((gateKey) => (
                    <option key={gateKey} value={gateKey}>
                      {YOUTUBE_GATE_META[gateKey].label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Decision">
                <select
                  value={form.gateStatus}
                  onChange={(event) => onFormChange({ gateStatus: event.target.value as YouTubeGateStatus })}
                  className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                >
                  {YOUTUBE_GATE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {formatGateStatus(status)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Next action">
                <input
                  value={form.nextAction}
                  onChange={(event) => onFormChange({ nextAction: event.target.value })}
                  placeholder="What should happen next?"
                  className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                />
              </Field>

              <Field label="Task relation">
                <select
                  value={form.workItemRelationType}
                  onChange={(event) => onFormChange({ workItemRelationType: event.target.value })}
                  className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                >
                  <option value={form.gateKey}>Gate task ({YOUTUBE_GATE_META[form.gateKey].shortLabel})</option>
                  <option value="investigate">Investigation</option>
                </select>
              </Field>
            </div>

            <div className="mt-4 grid gap-4">
              <Field label="Reason">
                <textarea
                  value={form.reason}
                  onChange={(event) => onFormChange({ reason: event.target.value })}
                  placeholder="Why is this gate in this state?"
                  className="h-24 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                />
              </Field>
              <Field label="Evidence summary">
                <textarea
                  value={form.evidenceSummary}
                  onChange={(event) => onFormChange({ evidenceSummary: event.target.value })}
                  placeholder="What evidence supports this call?"
                  className="h-24 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                />
              </Field>
            </div>

            {(selectedGateEntry.reason || selectedGateEntry.evidence_summary) && (
              <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-4 text-sm text-gray-300">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Saved on this gate</p>
                {selectedGateEntry.reason && <p className="mt-2"><span className="text-gray-500">Reason:</span> {selectedGateEntry.reason}</p>}
                {selectedGateEntry.evidence_summary && <p className="mt-2"><span className="text-gray-500">Evidence:</span> {selectedGateEntry.evidence_summary}</p>}
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <ActionButton label="Save decision" busy={busyAction === `${item.id}:save_gate`} onClick={onSave} />
              <ActionButton
                label="Save + create task"
                variant="secondary"
                busy={busyAction === `${item.id}:save_and_create_task`}
                onClick={onSaveAndCreateTask}
              />
            </div>
          </section>

          <div className="mt-6 space-y-4">
            <SectionCard title="Overview">
              <SectionGrid>
                <Detail label="Concept" value={stringOrFallback(metadata.concept || metadata.overview?.concept)} />
                <Detail label="Pillar" value={stringOrFallback(metadata.pillar || metadata.overview?.pillar)} />
                <Detail label="Target viewer" value={stringOrFallback(metadata.target_viewer || metadata.overview?.target_viewer)} />
                <Detail label="Pipeline status" value={formatItemStatus(derivePipelineItemStatus(metadata, { currentStatus: item.status, publishedAt: item.published_at }))} />
              </SectionGrid>
              <LongText label="Decision summary" value={stringOrFallback(metadata.decision_summary)} />
              <LongText label="Next action" value={getTopLevelNextAction(metadata)} />
            </SectionCard>

            <SectionCard title="Gates / Scores">
              <div className="grid gap-3 md:grid-cols-2">
                {YOUTUBE_GATE_ORDER.map((gateKey) => {
                  const gate = getGateEntry(metadata, gateKey);
                  return (
                    <div key={gateKey} className="rounded-xl border border-gray-800 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-white">{YOUTUBE_GATE_META[gateKey].label}</p>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[getGateStatus(metadata, gateKey)]}`}>{formatGateStatus(getGateStatus(metadata, gateKey))}</span>
                      </div>
                      {gate.reason && <p className="mt-2 text-sm text-gray-300">{gate.reason}</p>}
                      {gate.next_action && <p className="mt-2 text-sm text-gray-500">Next: {gate.next_action}</p>}
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            <SectionCard title="Evidence">
              <StructuredValue value={metadata.evidence} emptyLabel="No evidence saved yet." />
            </SectionCard>

            <SectionCard title="Promise & Packaging">
              <div className="grid gap-4 lg:grid-cols-2">
                <StructuredPanel title="Promise" value={metadata.promise} emptyLabel="No promise notes saved." />
                <StructuredPanel title="Packaging" value={metadata.packaging} emptyLabel="No packaging notes saved." />
              </div>
            </SectionCard>

            <SectionCard title="Retention">
              <StructuredValue value={metadata.retention} emptyLabel="No retention design saved yet." />
            </SectionCard>

            <SectionCard title="Funnel">
              <StructuredValue value={metadata.funnel} emptyLabel="No funnel notes saved yet." />
            </SectionCard>

            <SectionCard title="Production">
              <StructuredValue value={metadata.production} emptyLabel="No production notes saved yet." />
            </SectionCard>

            <SectionCard title="Post-mortem">
              <StructuredValue value={metadata.postmortem} emptyLabel="No post-mortem data saved yet." />
            </SectionCard>
          </div>
        </div>
      </aside>
    </div>
  );
}

function getPrimaryGateWorkItem(itemId: string, gateKey: YouTubeGateKey, workItems: LinkedWorkItem[]) {
  const candidates = workItems.filter((workItem) => {
    const payload = workItem.payload || {};
    const linked = workItem.source_id === itemId || payload.pipeline_item_id === itemId;
    const relationType = payload.relation_type;
    return linked && (relationType === gateKey || relationType === "investigate");
  });

  return [...candidates].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;
}

function formatGateStatus(status: YouTubeGateStatus) {
  return status.replaceAll("_", " ");
}

function formatItemStatus(status: string) {
  return status.replaceAll("_", " ");
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value));
}

function stringOrFallback(value: unknown, fallback = "—") {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <p className="mb-2 text-sm font-medium text-white">{label}</p>
      {children}
    </label>
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

function ScorePill({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${highlight ? "border-blue-500/30 bg-blue-500/10" : "border-gray-800 bg-black/20"}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-base font-semibold ${highlight ? "text-blue-300" : "text-white"}`}>{value.toFixed(1)}</p>
    </div>
  );
}

function ActionButton({ label, onClick, variant = "primary", busy }: { label: string; onClick: () => void; variant?: "primary" | "secondary"; busy?: boolean }) {
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-500",
    secondary: "bg-white/10 text-white hover:bg-white/15",
  } as const;

  return (
    <button disabled={busy} onClick={onClick} className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}>
      {busy ? "Working..." : label}
    </button>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-800 bg-[#14141c] p-5">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2">{children}</div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-1 text-sm text-gray-300">{value}</p>
    </div>
  );
}

function LongText({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-800 bg-black/20 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-300">{value}</p>
    </div>
  );
}

function StructuredPanel({ title, value, emptyLabel }: { title: string; value: unknown; emptyLabel: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-black/20 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{title}</p>
      <div className="mt-3">
        <StructuredValue value={value} emptyLabel={emptyLabel} />
      </div>
    </div>
  );
}

function StructuredValue({ value, emptyLabel }: { value: unknown; emptyLabel: string }) {
  const node = renderStructuredValue(value);
  if (!node) return <p className="text-sm text-gray-500">{emptyLabel}</p>;
  return <div className="space-y-3 text-sm text-gray-300">{node}</div>;
}

function renderStructuredValue(value: unknown): ReactNode {
  if (value == null) return null;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    return <p className="whitespace-pre-wrap leading-6">{value}</p>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p>{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <ul className="space-y-2">
        {value.map((entry, index) => (
          <li key={index} className="rounded-lg border border-gray-800 bg-black/20 px-3 py-2">
            {renderStructuredValue(entry) || <span className="text-gray-500">—</span>}
          </li>
        ))}
      </ul>
    );
  }

  const record = value as JsonRecord;
  const entries = Object.entries(record).filter(([, entry]) => {
    if (entry == null) return false;
    if (typeof entry === "string") return entry.trim().length > 0;
    if (Array.isArray(entry)) return entry.length > 0;
    if (typeof entry === "object") return Object.keys(entry as JsonRecord).length > 0;
    return true;
  });

  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      {entries.map(([key, entry]) => (
        <div key={key} className="rounded-xl border border-gray-800 bg-black/20 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{formatKeyLabel(key)}</p>
          <div className="mt-2">{renderStructuredValue(entry)}</div>
        </div>
      ))}
    </div>
  );
}

function formatKeyLabel(key: string) {
  return key.replaceAll("_", " ");
}
