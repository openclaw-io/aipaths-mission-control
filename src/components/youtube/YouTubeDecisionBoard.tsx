"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { LinkedWorkItem, VideoPipelineItem } from "@/app/youtube/page";
import { useRealtimeWorkItems } from "@/hooks/useRealtimeWorkItems";
import { useRealtimeYouTube } from "@/hooks/useRealtimeYouTube";
import {
  YOUTUBE_GATE_META,
  YOUTUBE_GATE_ORDER,
  type JsonRecord,
  type YouTubeBoardBucketKey,
  type YouTubeGateEntry,
  type YouTubeGateKey,
  type YouTubeResponsibility,
  derivePipelineItemStatus,
  deriveYouTubeResponsibility,
  gateNeedsHumanReview,
  getAgentDeliverableLabel,
  getGateEntry,
  getGateStatus,
  getHumanDecisionLabel,
  getHumanReviewReason,
  getPrimaryGateWorkItem,
  getScores,
  getTopLevelNextAction,
  getYouTubeMetadata,
} from "@/lib/youtube-pipeline";

const GATE_STATUS_STYLES: Record<string, string> = {
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

const RESPONSIBILITY_BADGES: Record<YouTubeBoardBucketKey, { label: string; className: string }> = {
  needs_gonza: { label: "Needs Gonza", className: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300" },
  agent_working: { label: "Agent work", className: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
  agent_next: { label: "Agent next", className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300" },
  ready_for_gonza_review: { label: "Ready for review", className: "border-purple-500/30 bg-purple-500/10 text-purple-300" },
  ready_to_record: { label: "Ready to record", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
  learning_published: { label: "Learning", className: "border-lime-500/30 bg-lime-500/10 text-lime-300" },
  killed_archived: { label: "Killed / archived", className: "border-gray-500/30 bg-gray-500/10 text-gray-300" },
};

const BOARD_GROUPS: Array<{ key: YouTubeBoardBucketKey; title: string; description: string }> = [
  { key: "needs_gonza", title: "Needs Gonza", description: "Explicit human calls requested by the agent." },
  { key: "agent_working", title: "Agent Working", description: "The YouTube Director already has an open task on these." },
  { key: "agent_next", title: "Agent Next", description: "Automation should move these forward next; no questionnaire needed from Gonza." },
  { key: "ready_for_gonza_review", title: "Ready for Gonza Review", description: "Agent output is ready: recommendation, evidence, and next decision." },
  { key: "ready_to_record", title: "Ready to Record / Approved", description: "Pre-production is strong enough to move into filming or recording." },
  { key: "learning_published", title: "Learning / Published", description: "Published items and postmortem review." },
  { key: "killed_archived", title: "Killed / Archived", description: "Ideas that were killed or fully archived." },
];

type QuickAction = "approve" | "request_rework" | "kill" | "send_to_agent";

type DrawerState = {
  gateKey: YouTubeGateKey;
  note: string;
  workItemRelationType: string;
};

type BoardItemModel = {
  item: VideoPipelineItem;
  metadata: ReturnType<typeof getYouTubeMetadata>;
  responsibility: YouTubeResponsibility;
  currentGateKey: YouTubeGateKey;
  currentGate: YouTubeGateEntry;
  openWorkItem: YouTubeResponsibility["openWorkItem"];
  scores: ReturnType<typeof getScores>;
};

export function YouTubeDecisionBoard({ initialItems, initialWorkItems }: { initialItems: VideoPipelineItem[]; initialWorkItems: LinkedWorkItem[] }) {
  const router = useRouter();
  const [items, setItems] = useRealtimeYouTube(initialItems);
  const workItems = useRealtimeWorkItems(initialWorkItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);

  const boardItems = useMemo(() => (
    items.map((item) => {
      const metadata = getYouTubeMetadata(item.metadata);
      const responsibility = deriveYouTubeResponsibility({
        itemId: item.id,
        metadata,
        status: item.status,
        publishedAt: item.published_at,
        workItems,
      });
      const currentGateKey = responsibility.currentGateKey;
      const currentGate = getGateEntry(metadata, currentGateKey);
      const openWorkItem = responsibility.openWorkItem || getPrimaryGateWorkItem(item.id, currentGateKey, workItems, { openOnly: true });
      return {
        item,
        metadata,
        responsibility,
        currentGateKey,
        currentGate,
        openWorkItem,
        scores: getScores(metadata),
      };
    })
  ), [items, workItems]);

  const groupedItems = useMemo(() => {
    const groups = Object.fromEntries(BOARD_GROUPS.map((group) => [group.key, [] as BoardItemModel[]])) as Record<YouTubeBoardBucketKey, BoardItemModel[]>;

    for (const model of boardItems) {
      groups[model.responsibility.bucket].push(model);
    }

    for (const group of BOARD_GROUPS) {
      groups[group.key].sort((a, b) => {
        const priorityDiff = b.scores.priority - a.scores.priority;
        if (priorityDiff !== 0) return priorityDiff;
        return new Date(b.item.updated_at).getTime() - new Date(a.item.updated_at).getTime();
      });
    }

    return groups;
  }, [boardItems]);

  const selectedItem = useMemo(() => boardItems.find((item) => item.item.id === selectedId) || null, [boardItems, selectedId]);

  useEffect(() => {
    if (!selectedItem) {
      setDrawerState(null);
      return;
    }

    setDrawerState({
      gateKey: selectedItem.currentGateKey,
      note: "",
      workItemRelationType: selectedItem.currentGateKey,
    });
  }, [selectedItem]);

  async function submitQuickAction(model: BoardItemModel, action: QuickAction) {
    const actionState = drawerState && selectedId === model.item.id
      ? drawerState
      : { gateKey: model.currentGateKey, note: "", workItemRelationType: model.currentGateKey };

    setBusyAction(`${model.item.id}:${action}`);
    try {
      const response = await fetch(`/api/youtube/${model.item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          gateKey: actionState.gateKey,
          note: actionState.note,
          workItemRelationType: actionState.workItemRelationType,
          createWorkItem: action === "request_rework" || action === "send_to_agent",
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        alert(error.error || "Action failed");
        return;
      }

      const payload = (await response.json()) as { item: VideoPipelineItem };
      setItems((current) => current.map((existing) => (existing.id === model.item.id ? payload.item : existing)));
      router.refresh();
    } finally {
      setBusyAction(null);
    }
  }

  const counts = useMemo(
    () => Object.fromEntries(BOARD_GROUPS.map((group) => [group.key, groupedItems[group.key].length])) as Record<YouTubeBoardBucketKey, number>,
    [groupedItems],
  );
  const activeItems = items.filter((item) => !["rejected", "archived"].includes(item.status)).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">YouTube</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            Concept first. Gonza only sees the idea, the reason it might matter, and one primary action to move it forward.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm text-gray-400">
          <StatCard label="Open videos" value={String(activeItems)} />
          <StatCard label="Needs Gonza" value={String(counts.needs_gonza || 0)} />
          <StatCard label="Agent Working" value={String(counts.agent_working || 0)} />
          <StatCard label="Agent Next" value={String(counts.agent_next || 0)} />
          <StatCard label="Review" value={String(counts.ready_for_gonza_review || 0)} />
        </div>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        {BOARD_GROUPS.map((group) => {
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
                <p className="mt-4 rounded-xl border border-dashed border-gray-800 bg-black/10 px-4 py-6 text-sm text-gray-600">Nothing in this queue.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {groupItems.map((model) => (
                    <CardButton
                      key={model.item.id}
                      model={model}
                      selected={selectedId === model.item.id}
                      busyAction={busyAction}
                      onSelect={() => setSelectedId(model.item.id)}
                      onQuickAction={(action) => submitQuickAction(model, action)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {selectedItem && drawerState && (
        <DetailDrawer
          model={selectedItem}
          workItems={workItems}
          state={drawerState}
          busyAction={busyAction}
          onClose={() => setSelectedId(null)}
          onStateChange={(patch) => setDrawerState((current) => (current ? { ...current, ...patch } : current))}
          onQuickAction={(action) => submitQuickAction(selectedItem, action)}
        />
      )}
    </div>
  );
}

function CardButton({
  model,
  selected,
  busyAction,
  onSelect,
  onQuickAction,
}: {
  model: BoardItemModel;
  selected: boolean;
  busyAction: string | null;
  onSelect: () => void;
  onQuickAction: (action: QuickAction) => void;
}) {
  const { item, metadata, responsibility, currentGateKey, openWorkItem } = model;
  const badge = RESPONSIBILITY_BADGES[responsibility.bucket];
  const concept = stringOrFallback(metadata.concept || metadata.overview?.concept || metadata.decision_summary, "No concept saved yet.");
  const why = stringOrFallback(metadata.overview?.why_it_matters || metadata.evidence?.why_it_matters || metadata.next_action, "Needs first validation.");
  const isBusy = (action: QuickAction) => busyAction === `${item.id}:${action}`;

  return (
    <article
      className={`w-full rounded-2xl border p-4 transition ${
        selected ? "border-blue-500 bg-blue-500/5" : "border-gray-800 bg-black/15 hover:border-gray-700 hover:bg-white/5"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {metadata.pillar && <span>{metadata.pillar}</span>}
            <span className={`rounded-full border px-2 py-0.5 ${badge.className}`}>{badge.label}</span>
            {openWorkItem && <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">working</span>}
          </div>
          <h3 className="mt-2 text-base font-semibold text-white">{item.title}</h3>
          <p className="mt-2 text-sm leading-6 text-gray-300">{concept}</p>
          <p className="mt-3 text-sm leading-6 text-gray-500">{why}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-gray-500">{formatDate(item.updated_at)}</div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-800 pt-4">
        <button type="button" onClick={onSelect} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">
          Ver detalles
        </button>

        <div className="flex flex-wrap gap-2">
          {responsibility.bucket === "agent_working" && (
            <span className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-300">En progreso</span>
          )}

          {(responsibility.bucket === "agent_next" || responsibility.bucket === "needs_gonza") && (
            <>
              <ActionButton label="Descartar" variant="danger" busy={isBusy("kill")} onClick={() => onQuickAction("kill")} />
              <ActionButton label="Avanzar" variant="primary" busy={isBusy("send_to_agent")} onClick={() => onQuickAction("send_to_agent")} />
            </>
          )}

          {responsibility.bucket === "ready_for_gonza_review" && (
            <>
              <ActionButton label="Pedir rework" variant="warning" busy={isBusy("request_rework")} onClick={() => onQuickAction("request_rework")} />
              <ActionButton label="Descartar" variant="danger" busy={isBusy("kill")} onClick={() => onQuickAction("kill")} />
              <ActionButton label="Aprobar" variant="success" busy={isBusy("approve")} onClick={() => onQuickAction("approve")} />
            </>
          )}

          {responsibility.bucket === "ready_to_record" && (
            <ActionButton label="Aprobar siguiente" variant="success" busy={isBusy("approve")} onClick={() => onQuickAction("approve")} />
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-600">Internal step: {YOUTUBE_GATE_META[currentGateKey].label}</p>
    </article>
  );
}

function DetailDrawer({
  model,
  workItems,
  state,
  busyAction,
  onClose,
  onStateChange,
  onQuickAction,
}: {
  model: BoardItemModel;
  workItems: LinkedWorkItem[];
  state: DrawerState;
  busyAction: string | null;
  onClose: () => void;
  onStateChange: (patch: Partial<DrawerState>) => void;
  onQuickAction: (action: QuickAction) => void;
}) {
  const { item, metadata, responsibility, currentGateKey, scores } = model;
  const selectedGate = getGateEntry(metadata, state.gateKey);
  const selectedGateStatus = getGateStatus(metadata, state.gateKey);
  const selectedGateWorkItem = getPrimaryGateWorkItem(item.id, state.gateKey, workItems, { openOnly: true });
  const badge = RESPONSIBILITY_BADGES[responsibility.bucket];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-5xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {metadata.pillar && <span>{metadata.pillar}</span>}
                {metadata.target_viewer && <span>{metadata.target_viewer}</span>}
                <span className={`rounded-full border px-2 py-0.5 ${badge.className}`}>{badge.label}</span>
                <span className={`rounded-full px-2 py-0.5 ${GATE_STATUS_STYLES[selectedGateStatus]}`}>{formatGateStatus(selectedGateStatus)}</span>
                <span className={`rounded-full px-2 py-0.5 ${ITEM_STATUS_STYLES[item.status] || "bg-gray-500/20 text-gray-300"}`}>{formatItemStatus(item.status)}</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
              <p className="mt-2 text-sm text-gray-400">Current gate: {YOUTUBE_GATE_META[currentGateKey].label}</p>
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
          <SectionCard title="What's Needed">
            <div className="grid gap-3 md:grid-cols-2">
              {getCardNeedRows(model).map((row) => (
                <NeedRow key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          </SectionCard>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <SectionCard title="Quick Actions">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-gray-400">Use one action. Notes are optional and mainly useful for history or extra agent context.</p>
                </div>
                {selectedGateWorkItem && (
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-300">
                    open work: {selectedGateWorkItem.title || "YouTube task"} · {selectedGateWorkItem.status}
                  </span>
                )}
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Action focus">
                  <select
                    value={state.gateKey}
                    onChange={(event) => {
                      const gateKey = event.target.value as YouTubeGateKey;
                      onStateChange({
                        gateKey,
                        workItemRelationType: state.workItemRelationType === "investigate" ? "investigate" : gateKey,
                      });
                    }}
                    className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                  >
                    {YOUTUBE_GATE_ORDER.map((gateKey) => (
                      <option key={gateKey} value={gateKey}>
                        {YOUTUBE_GATE_META[gateKey].label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Send to Agent as">
                  <select
                    value={state.workItemRelationType}
                    onChange={(event) => onStateChange({ workItemRelationType: event.target.value })}
                    className="w-full rounded-xl border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500"
                  >
                    <option value={state.gateKey}>Current gate task</option>
                    <option value="investigate">Investigation</option>
                  </select>
                </Field>
              </div>

              <div className="mt-4">
                <Field label="Optional note">
                  <textarea
                    value={state.note}
                    onChange={(event) => onStateChange({ note: event.target.value })}
                    placeholder="Small note for the decision history or agent context."
                    className="h-24 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
                  />
                </Field>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <ActionButton label="Approve" variant="success" busy={busyAction === `${item.id}:approve`} onClick={() => onQuickAction("approve")} />
                <ActionButton
                  label="Request Rework"
                  variant="warning"
                  busy={busyAction === `${item.id}:request_rework`}
                  onClick={() => onQuickAction("request_rework")}
                />
                <ActionButton label="Kill" variant="danger" busy={busyAction === `${item.id}:kill`} onClick={() => onQuickAction("kill")} />
                <ActionButton
                  label="Send to Agent"
                  variant="primary"
                  busy={busyAction === `${item.id}:send_to_agent`}
                  onClick={() => onQuickAction("send_to_agent")}
                />
              </div>

              {(selectedGate.reason || selectedGate.evidence_summary || selectedGate.next_action) && (
                <div className="mt-5 rounded-xl border border-gray-800 bg-black/20 p-4 text-sm text-gray-300">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Saved on this gate</p>
                  {selectedGate.reason && <p className="mt-2"><span className="text-gray-500">Recommendation:</span> {selectedGate.reason}</p>}
                  {selectedGate.evidence_summary && <p className="mt-2"><span className="text-gray-500">Evidence:</span> {selectedGate.evidence_summary}</p>}
                  {selectedGate.next_action && <p className="mt-2"><span className="text-gray-500">Next action:</span> {selectedGate.next_action}</p>}
                </div>
              )}
            </SectionCard>

            <SectionCard title="Gate Snapshot">
              <SectionGrid>
                <Detail label="Focus gate" value={YOUTUBE_GATE_META[state.gateKey].label} />
                <Detail label="Gate status" value={formatGateStatus(selectedGateStatus)} />
                <Detail label="Human review" value={gateNeedsHumanReview(metadata, state.gateKey) ? "Required" : "Not required by default"} />
                <Detail label="Agent deliverable" value={getAgentDeliverableLabel(state.gateKey)} />
              </SectionGrid>
              <LongText label="Suggested action" value={selectedGate.next_action || getTopLevelNextAction(metadata)} />
            </SectionCard>
          </div>

          <div className="mt-6 space-y-4">
            <SectionCard title="Overview">
              <SectionGrid>
                <Detail label="Concept" value={stringOrFallback(metadata.concept || metadata.overview?.concept)} />
                <Detail label="Pillar" value={stringOrFallback(metadata.pillar || metadata.overview?.pillar)} />
                <Detail label="Target viewer" value={stringOrFallback(metadata.target_viewer || metadata.overview?.target_viewer)} />
                <Detail label="Pipeline status" value={formatItemStatus(derivePipelineItemStatus(metadata, { currentStatus: item.status, publishedAt: item.published_at }))} />
              </SectionGrid>
              <LongText label="Decision summary" value={stringOrFallback(metadata.decision_summary)} />
              <LongText label="Top-level next action" value={getTopLevelNextAction(metadata)} />
            </SectionCard>

            <SectionCard title="Gates / Scores">
              <div className="grid gap-3 md:grid-cols-2">
                {YOUTUBE_GATE_ORDER.map((gateKey) => {
                  const gate = getGateEntry(metadata, gateKey);
                  const gateWorkItem = getPrimaryGateWorkItem(item.id, gateKey, workItems, { openOnly: true });
                  return (
                    <div key={gateKey} className="rounded-xl border border-gray-800 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-white">{YOUTUBE_GATE_META[gateKey].label}</p>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${GATE_STATUS_STYLES[getGateStatus(metadata, gateKey)]}`}>{formatGateStatus(getGateStatus(metadata, gateKey))}</span>
                      </div>
                      {gate.reason && <p className="mt-2 text-sm text-gray-300">{gate.reason}</p>}
                      {gate.next_action && <p className="mt-2 text-sm text-gray-500">Next: {gate.next_action}</p>}
                      {gateWorkItem && <p className="mt-2 text-xs text-sky-300">Open work: {gateWorkItem.status}</p>}
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

            <SectionCard title="Postmortem">
              <StructuredValue value={metadata.postmortem} emptyLabel="No postmortem data saved yet." />
            </SectionCard>
          </div>
        </div>
      </aside>
    </div>
  );
}

function getCardNeedRows(model: BoardItemModel) {
  const { metadata, responsibility, currentGate, currentGateKey, item, openWorkItem } = model;
  const recommendation = currentGate.reason || stringOrNull(metadata.decision_summary) || "No agent recommendation saved yet.";
  const evidence = currentGate.evidence_summary || "No evidence summary saved yet.";
  const suggestedAction = currentGate.next_action || getTopLevelNextAction(metadata);

  switch (responsibility.bucket) {
    case "needs_gonza":
      return [
        { label: "Decision needed", value: getHumanDecisionLabel(currentGateKey) },
        { label: "Why human is needed", value: getHumanReviewReason(currentGateKey, responsibility.humanReviewRequested) },
        { label: "Agent recommendation", value: recommendation },
        { label: "Evidence summary", value: evidence },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "agent_working":
      return [
        { label: "Agent work", value: `Advance ${YOUTUBE_GATE_META[currentGateKey].label.toLowerCase()}.` },
        { label: "Artefact needed", value: getAgentDeliverableLabel(currentGateKey) },
        { label: "Open work item", value: openWorkItem ? `${openWorkItem.title || "YouTube task"} · ${openWorkItem.status}` : "Task is in progress." },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "agent_next":
      return [
        { label: "Agent work", value: `Start ${YOUTUBE_GATE_META[currentGateKey].label.toLowerCase()}.` },
        { label: "Artefact needed", value: getAgentDeliverableLabel(currentGateKey) },
        { label: "Work item status", value: "No open work item yet." },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "ready_for_gonza_review":
      return [
        { label: "Review needed", value: getHumanDecisionLabel(currentGateKey) },
        { label: "Agent recommendation", value: recommendation },
        { label: "Evidence summary", value: evidence },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "ready_to_record":
      return [
        { label: "Status", value: currentGateKey === "film_ready" ? "Pre-production is assembled and ready for the final recording call." : "This item is ready to move through recording, publishing, or closeout." },
        { label: "Current focus", value: currentGateKey === "film_ready" ? "Final filming package and record." : "Record, publish, or keep momentum into postmortem." },
        { label: "Agent recommendation", value: recommendation },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "learning_published":
      return [
        { label: "Status", value: item.status === "published" ? "Published and waiting for learning review." : "In the learning loop." },
        { label: "Current focus", value: currentGateKey === "postmortem" ? "Review what worked, what missed, and what changes next." : "Carry forward the learning." },
        { label: "Evidence summary", value: evidence },
        { label: "Suggested action", value: suggestedAction },
      ];
    case "killed_archived":
      return [
        { label: "Outcome", value: item.status === "archived" ? "Archived." : "Killed or rejected." },
        { label: "Last gate", value: YOUTUBE_GATE_META[currentGateKey].label },
        { label: "Reason", value: currentGate.reason || "No reason saved." },
        { label: "Suggested action", value: suggestedAction },
      ];
  }
}

function formatGateStatus(status: string) {
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

function stringOrNull(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function NeedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#101018] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 text-sm leading-6 text-gray-300">{value}</p>
    </div>
  );
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

function ActionButton({
  label,
  onClick,
  variant = "primary",
  busy,
}: {
  label: string;
  onClick: () => void;
  variant?: "primary" | "success" | "warning" | "danger";
  busy?: boolean;
}) {
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-500",
    success: "bg-emerald-600 text-white hover:bg-emerald-500",
    warning: "bg-amber-500 text-black hover:bg-amber-400",
    danger: "bg-red-600 text-white hover:bg-red-500",
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
