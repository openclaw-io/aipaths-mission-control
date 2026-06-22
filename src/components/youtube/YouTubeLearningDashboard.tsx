"use client";

import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { BarChart3, Pencil, Save, X } from "lucide-react";
import type { VideoPipelineItem } from "@/app/youtube/page";

type JsonRecord = Record<string, unknown>;
type LearningWindow = "7d" | "28d" | "lifetime";

type MetricSnapshot = {
  views?: number | null;
  impressions?: number | null;
  yt_ctr?: number | null;
  avg_view_duration?: string | null;
  avg_percent_viewed?: number | null;
  retention_30s?: number | null;
  watch_time_hours?: number | null;
  subs_gained?: number | null;
  leads?: number | null;
};

type CtaRow = {
  destination: string;
  clicks: number | null;
  leads: number | null;
  revenue: number | null;
  ref: string;
};

type LearningData = {
  format?: string | null;
  pillar?: string | null;
  video_type?: string | null;
  promise?: string | null;
  primary_cta?: string | null;
  hook_type?: string | null;
  title_angle?: string | null;
  thumbnail_angle?: string | null;
  manual_result?: string | null;
  what_worked?: string | null;
  what_failed?: string | null;
  hypothesis?: string | null;
  next_test?: string | null;
  snapshots?: Partial<Record<LearningWindow, MetricSnapshot>>;
  ctas?: CtaRow[];
  updated_at?: string | null;
  updated_by?: string | null;
};

type LearningFormState = Omit<LearningData, "snapshots" | "ctas"> & {
  views?: string | number | null;
  impressions?: string | number | null;
  yt_ctr?: string | number | null;
  avg_view_duration?: string | null;
  avg_percent_viewed?: string | number | null;
  retention_30s?: string | number | null;
  watch_time_hours?: string | number | null;
  subs_gained?: string | number | null;
  leads?: string | number | null;
  ctaLines: string;
};

type ScoreBundle = {
  click: number | null;
  retention: number | null;
  business: number | null;
  overall: number | null;
  ctaCtr: number | null;
  totalCtaClicks: number;
  totalLeads: number;
};

const WINDOWS: Array<{ key: LearningWindow; label: string; hint: string }> = [
  { key: "7d", label: "7 días", hint: "Lanzamiento / packaging" },
  { key: "28d", label: "28 días", hint: "Performance estable" },
  { key: "lifetime", label: "Lifetime", hint: "Referencia histórica" },
];

const EMPTY_STATE = "—";

export function YouTubeLearningDashboard({ initialItems }: { initialItems: VideoPipelineItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [windowKey, setWindowKey] = useState<LearningWindow>("28d");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    return items
      .filter(isLongFormCandidate)
      .map((item) => {
        const learning = getLearningData(item);
        const snapshot = getSnapshot(learning, windowKey);
        const scores = calculateScores(snapshot, learning.ctas || []);
        return { item, learning, snapshot, scores };
      })
      .sort((a, b) => {
        const aScore = a.scores.overall ?? -1;
        const bScore = b.scores.overall ?? -1;
        if (aScore !== bScore) return bScore - aScore;
        return new Date(b.item.published_at || b.item.updated_at).getTime() - new Date(a.item.published_at || a.item.updated_at).getTime();
      });
  }, [items, windowKey]);

  const selectedRow = rows.find((row) => row.item.id === selectedId) || null;
  const rowsWithData = rows.filter((row) => hasAnySnapshotData(row.snapshot) || hasLearningData(row.learning));
  const avgOverall = average(rowsWithData.map((row) => row.scores.overall));
  const totalViews = rows.reduce((total, row) => total + numberOrZero(row.snapshot.views), 0);
  const totalClicks = rows.reduce((total, row) => total + row.scores.totalCtaClicks, 0);
  const totalLeads = rows.reduce((total, row) => total + row.scores.totalLeads, 0);

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#101018] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-blue-300">
            <BarChart3 className="h-4 w-4" />
            <p className="text-xs font-semibold uppercase tracking-wide">YouTube Learning Dashboard · V1 manual</p>
          </div>
          <h2 className="mt-2 text-xl font-bold text-white">Qué video funcionó y por qué</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-400">
            Long-form only. Métricas por ventana + review manual para separar packaging, retención y negocio.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <MiniStat label="Videos" value={String(rows.length)} />
          <MiniStat label="Views" value={formatCompact(totalViews)} />
          <MiniStat label="CTA clicks" value={formatCompact(totalClicks)} />
          <MiniStat label="Leads" value={formatCompact(totalLeads)} />
          <MiniStat label="Avg score" value={formatScore(avgOverall)} />
        </div>
      </div>

      <div className="mt-5 grid gap-2 md:grid-cols-3">
        {WINDOWS.map((entry) => {
          const selected = entry.key === windowKey;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setWindowKey(entry.key)}
              className={`rounded-xl border px-4 py-3 text-left transition ${selected ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-black/20 hover:border-gray-700 hover:bg-white/5"}`}
            >
              <p className="text-sm font-semibold text-white">{entry.label}</p>
              <p className="mt-1 text-xs text-gray-500">{entry.hint}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-5 overflow-x-auto rounded-xl border border-gray-800">
        <table className="min-w-[1500px] w-full border-collapse text-left text-sm">
          <thead className="bg-black/30 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <Th>Video</Th>
              <Th>Pilar / tipo</Th>
              <Th>Impr.</Th>
              <Th>YT CTR</Th>
              <Th>Views</Th>
              <Th>AVD</Th>
              <Th>% viewed</Th>
              <Th>30s ret.</Th>
              <Th>CTA clicks</Th>
              <Th>CTA CTR</Th>
              <Th>Leads</Th>
              <Th>Scores</Th>
              <Th>Diagnóstico</Th>
              <Th>Acción</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={14} className="px-4 py-8 text-center text-gray-500">No hay videos long-form publicados todavía.</td>
              </tr>
            ) : (
              rows.map(({ item, learning, snapshot, scores }) => (
                <tr key={item.id} className="border-t border-gray-800 bg-[#111118] align-top hover:bg-white/[0.03]">
                  <Td>
                    <div className="max-w-sm">
                      <p className="line-clamp-2 font-semibold text-white">{item.title}</p>
                      <p className="mt-1 text-xs text-gray-600">{formatDate(item.published_at || item.updated_at)}</p>
                    </div>
                  </Td>
                  <Td>
                    <p className="text-gray-300">{learning.pillar || EMPTY_STATE}</p>
                    <p className="mt-1 text-xs text-gray-500">{learning.video_type || EMPTY_STATE}</p>
                  </Td>
                  <Td>{formatNumber(snapshot.impressions)}</Td>
                  <Td>{formatPercent(snapshot.yt_ctr)}</Td>
                  <Td>{formatNumber(snapshot.views)}</Td>
                  <Td>{snapshot.avg_view_duration || EMPTY_STATE}</Td>
                  <Td>{formatPercent(snapshot.avg_percent_viewed)}</Td>
                  <Td>{formatPercent(snapshot.retention_30s)}</Td>
                  <Td>{formatNumber(scores.totalCtaClicks)}</Td>
                  <Td>{formatPercent(scores.ctaCtr)}</Td>
                  <Td>{formatNumber(scores.totalLeads || snapshot.leads)}</Td>
                  <Td>
                    <div className="grid min-w-44 grid-cols-2 gap-1 text-xs">
                      <ScorePill label="Click" value={scores.click} />
                      <ScorePill label="Ret" value={scores.retention} />
                      <ScorePill label="Biz" value={scores.business} />
                      <ScorePill label="All" value={scores.overall} strong />
                    </div>
                  </Td>
                  <Td>
                    <div className="max-w-sm text-xs leading-5 text-gray-400">
                      <p><span className="text-gray-600">Resultado:</span> {learning.manual_result || EMPTY_STATE}</p>
                      {learning.hypothesis && <p className="mt-1 line-clamp-2"><span className="text-gray-600">Hipótesis:</span> {learning.hypothesis}</p>}
                    </div>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-700 bg-black/20 px-2 py-1 text-xs text-gray-300 transition hover:border-blue-500 hover:text-white"
                    >
                      <Pencil className="h-3 w-3" /> Editar
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedRow && (
        <LearningDrawer
          row={selectedRow}
          windowKey={windowKey}
          onClose={() => setSelectedId(null)}
          onSaved={(updated) => {
            setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
            setSelectedId(null);
          }}
        />
      )}
    </section>
  );
}

function LearningDrawer({
  row,
  windowKey,
  onClose,
  onSaved,
}: {
  row: { item: VideoPipelineItem; learning: LearningData; snapshot: MetricSnapshot; scores: ScoreBundle };
  windowKey: LearningWindow;
  onClose: () => void;
  onSaved: (item: VideoPipelineItem) => void;
}) {
  const [form, setForm] = useState<LearningFormState>(() => toFormState(row.learning, row.snapshot));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveLearning() {
    setBusy(true);
    setError(null);
    try {
      const ctas = parseCtaLines(form.ctaLines);
      const snapshot: MetricSnapshot = {
        views: toNullableNumber(form.views),
        impressions: toNullableNumber(form.impressions),
        yt_ctr: toNullableNumber(form.yt_ctr),
        avg_view_duration: trimToNull(form.avg_view_duration),
        avg_percent_viewed: toNullableNumber(form.avg_percent_viewed),
        retention_30s: toNullableNumber(form.retention_30s),
        watch_time_hours: toNullableNumber(form.watch_time_hours),
        subs_gained: toNullableNumber(form.subs_gained),
        leads: toNullableNumber(form.leads),
      };
      const learning: LearningData = {
        ...pickLearningFields(form),
        format: "long_form",
        snapshots: {
          ...(row.learning.snapshots || {}),
          [windowKey]: snapshot,
        },
        ctas,
      };

      const response = await fetch(`/api/youtube/${row.item.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_learning_review", learning }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "No se pudo guardar");
        return;
      }
      if (payload.item) onSaved(payload.item as VideoPipelineItem);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside className="flex h-full w-full max-w-4xl flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-300">Review manual · {windowKey}</p>
              <h3 className="mt-2 text-2xl font-bold leading-tight text-white">{row.item.title}</h3>
            </div>
            <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/15" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-4 md:grid-cols-3">
            <TextField label="Pilar" value={form.pillar} onChange={(value) => setFormField(setForm, "pillar", value)} placeholder="Ganar plata / Construir / Mentalidad" />
            <TextField label="Tipo" value={form.video_type} onChange={(value) => setFormField(setForm, "video_type", value)} placeholder="tutorial, caso, opinión..." />
            <TextField label="CTA principal" value={form.primary_cta} onChange={(value) => setFormField(setForm, "primary_cta", value)} placeholder="diagnostico, lead_magnet..." />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <TextArea label="Promesa" value={form.promise} onChange={(value) => setFormField(setForm, "promise", value)} />
            <TextArea label="Resultado manual" value={form.manual_result} onChange={(value) => setFormField(setForm, "manual_result", value)} placeholder="winner / promising / weak / misleading + por qué" />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <TextField label="Hook" value={form.hook_type} onChange={(value) => setFormField(setForm, "hook_type", value)} />
            <TextField label="Ángulo título" value={form.title_angle} onChange={(value) => setFormField(setForm, "title_angle", value)} />
            <TextField label="Ángulo thumbnail" value={form.thumbnail_angle} onChange={(value) => setFormField(setForm, "thumbnail_angle", value)} />
          </div>

          <section className="mt-5 rounded-xl border border-gray-800 bg-[#14141c] p-4">
            <h4 className="text-base font-semibold text-white">Métricas {windowKey}</h4>
            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <NumberField label="Impressions" value={form.impressions} onChange={(value) => setFormField(setForm, "impressions", value)} />
              <NumberField label="YT CTR %" value={form.yt_ctr} onChange={(value) => setFormField(setForm, "yt_ctr", value)} />
              <NumberField label="Views" value={form.views} onChange={(value) => setFormField(setForm, "views", value)} />
              <TextField label="AVD" value={form.avg_view_duration} onChange={(value) => setFormField(setForm, "avg_view_duration", value)} placeholder="8:32" />
              <NumberField label="% viewed" value={form.avg_percent_viewed} onChange={(value) => setFormField(setForm, "avg_percent_viewed", value)} />
              <NumberField label="30s retention %" value={form.retention_30s} onChange={(value) => setFormField(setForm, "retention_30s", value)} />
              <NumberField label="Watch hours" value={form.watch_time_hours} onChange={(value) => setFormField(setForm, "watch_time_hours", value)} />
              <NumberField label="Subs gained" value={form.subs_gained} onChange={(value) => setFormField(setForm, "subs_gained", value)} />
              <NumberField label="Leads" value={form.leads} onChange={(value) => setFormField(setForm, "leads", value)} />
            </div>
          </section>

          <section className="mt-5 rounded-xl border border-gray-800 bg-[#14141c] p-4">
            <h4 className="text-base font-semibold text-white">Varios CTA</h4>
            <p className="mt-1 text-xs text-gray-500">Una línea por CTA: destino | clicks | leads | revenue | ref</p>
            <textarea
              value={form.ctaLines}
              onChange={(event) => setFormField(setForm, "ctaLines", event.target.value)}
              rows={5}
              className="mt-3 w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
              placeholder="diagnostico | 34 | 5 | 0 | yt-video-diagnostico"
            />
          </section>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <TextArea label="Qué funcionó" value={form.what_worked} onChange={(value) => setFormField(setForm, "what_worked", value)} />
            <TextArea label="Qué falló" value={form.what_failed} onChange={(value) => setFormField(setForm, "what_failed", value)} />
            <TextArea label="Hipótesis" value={form.hypothesis} onChange={(value) => setFormField(setForm, "hypothesis", value)} />
            <TextArea label="Próximo test" value={form.next_test} onChange={(value) => setFormField(setForm, "next_test", value)} />
          </div>

          {error && <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-800 bg-[#101018] p-4">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-400 transition hover:bg-white/5 hover:text-white">Cancelar</button>
          <button type="button" disabled={busy} onClick={saveLearning} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {busy ? "Guardando..." : "Guardar review"}
          </button>
        </div>
      </aside>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-black/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-600">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th className="px-3 py-3 font-semibold">{children}</th>;
}

function Td({ children }: { children: ReactNode }) {
  return <td className="px-3 py-3 text-gray-300">{children}</td>;
}

function ScorePill({ label, value, strong = false }: { label: string; value: number | null; strong?: boolean }) {
  const display = formatScore(value);
  return (
    <span className={`rounded-md border px-2 py-1 ${strong ? "border-blue-500/40 bg-blue-500/10 text-blue-100" : "border-gray-800 bg-black/20 text-gray-400"}`}>
      {label}: {display}
    </span>
  );
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: unknown; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <input
        value={stringValue(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
      />
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: unknown; onChange: (value: string) => void }) {
  return <TextField label={label} value={value} onChange={onChange} />;
}

function TextArea({ label, value, onChange, placeholder }: { label: string; value: unknown; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <textarea
        value={stringValue(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="mt-1 w-full rounded-lg border border-gray-800 bg-[#0a0a0f] px-3 py-2 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-blue-500"
      />
    </label>
  );
}

function setFormField(setForm: Dispatch<SetStateAction<LearningFormState>>, key: keyof LearningFormState, value: string) {
  setForm((current) => ({ ...current, [key]: value }));
}

function getLearningData(item: VideoPipelineItem): LearningData {
  const metadata = toRecord(item.metadata);
  const direct = toRecord(metadata.youtube_learning_v1 || metadata.learning_dashboard);
  return {
    format: stringOrNull(direct.format) || stringOrNull(metadata.format),
    pillar: stringOrNull(direct.pillar || metadata.pillar),
    video_type: stringOrNull(direct.video_type || metadata.video_type),
    promise: stringOrNull(direct.promise || metadata.promise),
    primary_cta: stringOrNull(direct.primary_cta || direct.cta || metadata.primary_cta),
    hook_type: stringOrNull(direct.hook_type),
    title_angle: stringOrNull(direct.title_angle),
    thumbnail_angle: stringOrNull(direct.thumbnail_angle),
    manual_result: stringOrNull(direct.manual_result),
    what_worked: stringOrNull(direct.what_worked),
    what_failed: stringOrNull(direct.what_failed),
    hypothesis: stringOrNull(direct.hypothesis),
    next_test: stringOrNull(direct.next_test),
    snapshots: toSnapshots(direct.snapshots),
    ctas: toCtaRows(direct.ctas),
    updated_at: stringOrNull(direct.updated_at),
    updated_by: stringOrNull(direct.updated_by),
  };
}

function toFormState(learning: LearningData, snapshot: MetricSnapshot): LearningFormState {
  return {
    format: learning.format || "long_form",
    pillar: learning.pillar || "",
    video_type: learning.video_type || "",
    promise: learning.promise || "",
    primary_cta: learning.primary_cta || "",
    hook_type: learning.hook_type || "",
    title_angle: learning.title_angle || "",
    thumbnail_angle: learning.thumbnail_angle || "",
    manual_result: learning.manual_result || "",
    what_worked: learning.what_worked || "",
    what_failed: learning.what_failed || "",
    hypothesis: learning.hypothesis || "",
    next_test: learning.next_test || "",
    views: snapshot.views ?? "",
    impressions: snapshot.impressions ?? "",
    yt_ctr: snapshot.yt_ctr ?? "",
    avg_view_duration: snapshot.avg_view_duration || "",
    avg_percent_viewed: snapshot.avg_percent_viewed ?? "",
    retention_30s: snapshot.retention_30s ?? "",
    watch_time_hours: snapshot.watch_time_hours ?? "",
    subs_gained: snapshot.subs_gained ?? "",
    leads: snapshot.leads ?? "",
    ctaLines: ctaRowsToLines(learning.ctas || []),
  };
}

function pickLearningFields(form: LearningFormState): LearningData {
  return {
    pillar: trimToNull(form.pillar),
    video_type: trimToNull(form.video_type),
    promise: trimToNull(form.promise),
    primary_cta: trimToNull(form.primary_cta),
    hook_type: trimToNull(form.hook_type),
    title_angle: trimToNull(form.title_angle),
    thumbnail_angle: trimToNull(form.thumbnail_angle),
    manual_result: trimToNull(form.manual_result),
    what_worked: trimToNull(form.what_worked),
    what_failed: trimToNull(form.what_failed),
    hypothesis: trimToNull(form.hypothesis),
    next_test: trimToNull(form.next_test),
  };
}

function getSnapshot(learning: LearningData, windowKey: LearningWindow): MetricSnapshot {
  return normalizeSnapshot(learning.snapshots?.[windowKey]);
}

function calculateScores(snapshot: MetricSnapshot, ctas: CtaRow[]): ScoreBundle {
  const views = numberOrZero(snapshot.views);
  const impressions = numberOrZero(snapshot.impressions);
  const ytCtr = normalizePercent(snapshot.yt_ctr);
  const avgViewed = normalizePercent(snapshot.avg_percent_viewed);
  const retention30s = normalizePercent(snapshot.retention_30s);
  const totalCtaClicks = ctas.reduce((total, cta) => total + numberOrZero(cta.clicks), 0);
  const totalLeads = ctas.reduce((total, cta) => total + numberOrZero(cta.leads), 0) || numberOrZero(snapshot.leads);
  const ctaCtr = views > 0 ? (totalCtaClicks / views) * 100 : null;
  const leadRate = views > 0 ? (totalLeads / views) * 100 : null;

  const clickParts = [scoreRange(ytCtr, 2, 8, 65), impressions > 0 ? Math.min(35, Math.log10(impressions + 1) * 7) : null];
  const retentionParts = [avgViewed !== null ? avgViewed * 0.65 : null, retention30s !== null ? retention30s * 0.35 : null];
  const businessParts = [scoreRange(ctaCtr, 1, 8, 70), scoreRange(leadRate, 0.2, 2, 30)];

  const click = sumNullable(clickParts);
  const retention = sumNullable(retentionParts);
  const business = sumNullable(businessParts);
  const overall = average([click, retention, business]);

  return {
    click,
    retention,
    business,
    overall,
    ctaCtr,
    totalCtaClicks,
    totalLeads,
  };
}

function isLongFormCandidate(item: VideoPipelineItem) {
  const learning = getLearningData(item);
  const format = learning.format?.toLowerCase();
  if (format === "short" || format === "shorts") return false;
  return ["published", "learning"].includes(item.status) || Boolean(item.published_at || item.current_url || learning.updated_at);
}

function toSnapshots(value: unknown): Partial<Record<LearningWindow, MetricSnapshot>> {
  const record = toRecord(value);
  return {
    "7d": normalizeSnapshot(record["7d"]),
    "28d": normalizeSnapshot(record["28d"]),
    lifetime: normalizeSnapshot(record.lifetime),
  };
}

function normalizeSnapshot(value: unknown): MetricSnapshot {
  const record = toRecord(value);
  return {
    views: toNullableNumber(record.views),
    impressions: toNullableNumber(record.impressions),
    yt_ctr: toNullableNumber(record.yt_ctr),
    avg_view_duration: stringOrNull(record.avg_view_duration),
    avg_percent_viewed: toNullableNumber(record.avg_percent_viewed),
    retention_30s: toNullableNumber(record.retention_30s),
    watch_time_hours: toNullableNumber(record.watch_time_hours),
    subs_gained: toNullableNumber(record.subs_gained),
    leads: toNullableNumber(record.leads),
  };
}

function toCtaRows(value: unknown): CtaRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = toRecord(entry);
    return {
      destination: stringOrNull(record.destination) || "otro",
      clicks: toNullableNumber(record.clicks),
      leads: toNullableNumber(record.leads),
      revenue: toNullableNumber(record.revenue),
      ref: stringOrNull(record.ref) || "",
    };
  });
}

function parseCtaLines(value: string): CtaRow[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [destination = "otro", clicks = "", leads = "", revenue = "", ref = ""] = line.split("|").map((part) => part.trim());
      return {
        destination: destination || "otro",
        clicks: toNullableNumber(clicks),
        leads: toNullableNumber(leads),
        revenue: toNullableNumber(revenue),
        ref,
      };
    });
}

function ctaRowsToLines(rows: CtaRow[]) {
  return rows.map((row) => [row.destination, row.clicks ?? "", row.leads ?? "", row.revenue ?? "", row.ref].join(" | ")).join("\n");
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function trimToNull(value: unknown) {
  return stringOrNull(value);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).replace("%", "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrZero(value: unknown) {
  const numeric = toNullableNumber(value);
  return numeric ?? 0;
}

function normalizePercent(value: unknown) {
  const numeric = toNullableNumber(value);
  if (numeric === null) return null;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function scoreRange(value: number | null, low: number, high: number, weight: number) {
  if (value === null) return null;
  const normalized = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return normalized * weight;
}

function sumNullable(values: Array<number | null>) {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  return Math.round(usable.reduce((total, value) => total + value, 0));
}

function average(values: Array<number | null>) {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  return Math.round(usable.reduce((total, value) => total + value, 0) / usable.length);
}

function hasAnySnapshotData(snapshot: MetricSnapshot) {
  return Object.values(snapshot).some((value) => value !== null && value !== undefined && value !== "");
}

function hasLearningData(learning: LearningData) {
  return Boolean(learning.manual_result || learning.what_worked || learning.what_failed || learning.hypothesis || (learning.ctas && learning.ctas.length > 0));
}

function stringValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function formatDate(value: string | null) {
  if (!value) return EMPTY_STATE;
  return new Intl.DateTimeFormat("es", { month: "short", day: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatNumber(value: unknown) {
  const numeric = toNullableNumber(value);
  if (numeric === null) return EMPTY_STATE;
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(numeric);
}

function formatPercent(value: unknown) {
  const numeric = normalizePercent(value);
  if (numeric === null) return EMPTY_STATE;
  return `${Math.round(numeric * 10) / 10}%`;
}

function formatScore(value: number | null) {
  return value === null ? EMPTY_STATE : String(Math.max(0, Math.min(100, Math.round(value))));
}
