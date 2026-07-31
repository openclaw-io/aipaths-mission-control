"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type JsonObject = Record<string, unknown>;
type TabKey = "topics" | "drafts" | "approved";

export interface AudienceSnapshot {
  configured: boolean;
  activeNewsletterContacts?: number | null;
  waitlistedContacts?: number | null;
  legacyActiveSubscribers?: number | null;
  topTags: Array<{ tag: string; count: number }>;
}

export interface CampaignMetric {
  id: string;
  title_en?: string | null;
  title_es?: string | null;
  subject_en?: string | null;
  subject_es?: string | null;
  status?: string | null;
  scheduled_for?: string | null;
  sent_at?: string | null;
  total_recipients?: number | null;
  total_sent?: number | null;
  total_delivered?: number | null;
  total_opens?: number | null;
  total_clicks?: number | null;
  total_bounces?: number | null;
  total_complaints?: number | null;
}

export interface EmailCampaignPipelineItem {
  id: string;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  pipeline_type?: string | null;
  scheduled_for?: string | null;
  metadata?: JsonObject | null;
  payload?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface EmailCampaignWorkItem {
  id: string;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  action?: string | null;
  scheduled_for?: string | null;
  source_id?: string | null;
  payload?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface EmailCampaignPageData {
  pipelineItems: EmailCampaignPipelineItem[];
  workItems: EmailCampaignWorkItem[];
  audienceSnapshot: AudienceSnapshot;
  campaignMetrics: CampaignMetric[];
  errors: string[];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeLabel(value: string | null | undefined, fallback = "Sin estado") {
  if (!value) return fallback;
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatForDatetimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getMetadata(item: EmailCampaignPipelineItem) {
  return asObject(item.metadata);
}

function isIntelEmailTopic(item: EmailCampaignPipelineItem) {
  const metadata = getMetadata(item);
  const status = (item.status || "").toLowerCase();
  return (
    metadata.intel_source_type === "intel_inbox" &&
    metadata.intel_destination_key === "email" &&
    !["archived", "expired", "sent", "published", "done", "ready_for_review", "used_in_newsletter"].includes(status) &&
    metadata.kind !== "weekly_newsletter" &&
    metadata.kind !== "video_announcement"
  );
}

function isDraftCampaign(item: EmailCampaignPipelineItem) {
  if (isIntelEmailTopic(item)) return false;
  const metadata = getMetadata(item);
  const status = (item.status || "").toLowerCase();
  const isEmailCampaign = metadata.kind === "weekly_newsletter" || metadata.kind === "video_announcement";
  const isReadyForReview = ["ready_for_review", "ready_to_review", "review"].includes(status);

  // Drafts should be an actionable review queue, not a list of work that is
  // currently assigned to Marketing. Items in drafting/needs_changes stay out
  // until the linked Work Queue finishes and moves them back to ready_for_review.
  return isEmailCampaign && isReadyForReview;
}

function isApprovedCampaign(item: EmailCampaignPipelineItem) {
  const status = (item.status || "").toLowerCase();
  return ["approved", "scheduled", "sent"].includes(status);
}

function workItemsFor(item: EmailCampaignPipelineItem, workItems: EmailCampaignWorkItem[]) {
  return workItems.filter((workItem) => {
    const payload = asObject(workItem.payload);
    return workItem.source_id === item.id || payload.pipeline_item_id === item.id || payload.source_id === item.id;
  });
}

function statusClasses(status: string | null | undefined) {
  const normalized = (status || "").toLowerCase();
  if (normalized === "ready_for_review" || normalized === "ready_to_review" || normalized === "review") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200";
  if (normalized === "needs_changes") return "border-rose-500/25 bg-rose-500/10 text-rose-200";
  if (normalized === "approved") return "border-violet-500/25 bg-violet-500/10 text-violet-200";
  if (normalized === "scheduled") return "border-sky-500/25 bg-sky-500/10 text-sky-200";
  if (normalized === "sent") return "border-gray-500/25 bg-gray-500/10 text-gray-300";
  return "border-amber-500/25 bg-amber-500/10 text-amber-200";
}

function getDraftPreview(item: EmailCampaignPipelineItem) {
  const metadata = getMetadata(item);
  const draft = asObject(metadata.draft);
  return {
    kind: readString(metadata.kind),
    subject: readString(draft.subject) || readString(draft.subject_es) || readString(metadata.subject),
    previewText: readString(draft.preview_text) || readString(draft.previewText),
    bodyMarkdown: readString(draft.body_markdown) || readString(draft.body) || readString(draft.text),
    versions: Array.isArray(metadata.draft_versions) ? metadata.draft_versions.length : 0,
    review: asObject(metadata.review),
  };
}

function TabButton({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
        active ? "border-white/30 bg-white text-black" : "border-white/10 bg-[#111118] text-gray-300 hover:border-white/20 hover:text-white"
      }`}
    >
      {label} <span className={active ? "text-black/60" : "text-gray-500"}>({count})</span>
    </button>
  );
}

function DraftCard({
  item,
  workItems,
  feedback,
  busy,
  onFeedbackChange,
  onRequestChanges,
  onApprove,
}: {
  item: EmailCampaignPipelineItem;
  workItems: EmailCampaignWorkItem[];
  feedback: string;
  busy: boolean;
  onFeedbackChange: (value: string) => void;
  onRequestChanges: () => void;
  onApprove: () => void;
}) {
  const draft = getDraftPreview(item);
  const linked = workItemsFor(item, workItems);
  const canReview = ["ready_for_review", "ready_to_review", "review", "needs_changes"].includes((item.status || "").toLowerCase());

  return (
    <article className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.18em] text-gray-500">
            {draft.kind === "video_announcement" ? "Anuncio de video" : "Newsletter jueves"}
          </p>
          <h3 className="mt-2 text-lg font-semibold text-white">{item.title || "Email sin título"}</h3>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClasses(item.status)}`}>
          {normalizeLabel(item.status, "Drafting")}
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-white/8 bg-[#0d0d13] p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-gray-500">Preview</p>
        <p className="mt-3 text-sm font-semibold text-white">{draft.subject || "Sin subject todavía"}</p>
        {draft.previewText && <p className="mt-1 text-sm text-gray-400">{draft.previewText}</p>}
        {draft.bodyMarkdown && (
          <div className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-black/25 p-3 text-sm leading-relaxed text-gray-300">
            {draft.bodyMarkdown}
          </div>
        )}
        {!draft.bodyMarkdown && <p className="mt-3 text-sm text-gray-500">El draft todavía se está generando en Work Queue.</p>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-500">
        {formatDate(item.updated_at) && <span>Actualizado {formatDate(item.updated_at)}</span>}
        {draft.versions > 0 && <span>• {draft.versions} versión{draft.versions === 1 ? "" : "es"}</span>}
        {linked.length > 0 && <span>• Work Queue: {normalizeLabel(linked[0]?.status, "ready")}</span>}
      </div>

      {canReview && (
        <div className="mt-5 rounded-xl border border-white/8 bg-black/20 p-4">
          <label className="text-xs uppercase tracking-[0.18em] text-gray-500" htmlFor={`feedback-${item.id}`}>
            Correcciones
          </label>
          <textarea
            id={`feedback-${item.id}`}
            value={feedback}
            onChange={(event) => onFeedbackChange(event.target.value)}
            placeholder="Qué cambiarías del subject, ángulo, CTA, tono, longitud..."
            className="mt-3 min-h-24 w-full rounded-xl border border-white/10 bg-[#0d0d13] px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-white/30 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRequestChanges}
              disabled={busy || !feedback.trim()}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-gray-200 transition hover:border-rose-400/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rehacer con feedback
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="rounded-lg bg-emerald-300 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {draft.kind === "video_announcement" ? "Aprobar y programar" : "Aprobar"}
            </button>
          </div>
        </div>
      )}

      {readString(draft.review.feedback) && (
        <p className="mt-3 text-xs text-rose-200/80">Último feedback: {readString(draft.review.feedback)}</p>
      )}
    </article>
  );
}

function ApprovedCard({
  item,
  workItems,
  scheduledForDraft,
  busy,
  onScheduledForChange,
  onSchedule,
}: {
  item: EmailCampaignPipelineItem;
  workItems: EmailCampaignWorkItem[];
  scheduledForDraft: string;
  busy: boolean;
  onScheduledForChange: (value: string) => void;
  onSchedule: () => void;
}) {
  const draft = getDraftPreview(item);
  const linked = workItemsFor(item, workItems);
  const metadata = getMetadata(item);
  const schedule = asObject(metadata.schedule);
  const canonicalScheduledFor = readString(item.scheduled_for) || readString(schedule.scheduled_for);
  const isScheduled = (item.status || "").toLowerCase() === "scheduled";
  const isSent = (item.status || "").toLowerCase() === "sent";

  return (
    <article className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-gray-500">
            {draft.kind === "video_announcement" ? "Anuncio de video" : "Newsletter"}
          </p>
          <h3 className="mt-2 text-lg font-semibold text-white">{item.title || "Email sin título"}</h3>
          <p className="mt-2 text-sm text-gray-300">{draft.subject || "Sin subject"}</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClasses(item.status)}`}>
          {normalizeLabel(item.status, "Approved")}
        </span>
      </div>

      <div className="mt-4 rounded-xl border border-white/8 bg-black/20 p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-gray-500">Programación</p>
        {isScheduled || isSent ? (
          <p className="mt-3 text-sm text-gray-300">
            {isSent ? "Enviado" : "Programado"}: {formatDate(canonicalScheduledFor) || "fecha no disponible"}
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-gray-500">
              Igual que blogs/guías: al programarlo se crea un Work Queue con `scheduled_for` y la card pasa a `scheduled`.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="datetime-local"
                value={scheduledForDraft}
                onChange={(event) => onScheduledForChange(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0d0d13] px-3 py-2 text-sm text-white focus:border-white/30 focus:outline-none"
              />
              <button
                type="button"
                onClick={onSchedule}
                disabled={busy || !scheduledForDraft}
                className="rounded-lg bg-sky-300 px-3 py-2 text-sm font-semibold text-sky-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Programar envío
              </button>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-500">
        {formatDate(item.updated_at) && <span>Actualizado {formatDate(item.updated_at)}</span>}
        {linked.length > 0 && <span>• Work Queue: {normalizeLabel(linked[0]?.status, "done")}</span>}
      </div>
    </article>
  );
}

export function EmailCampaignsClient({ data }: { data: EmailCampaignPageData }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("topics");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [feedbackById, setFeedbackById] = useState<Record<string, string>>({});
  const [scheduledForById, setScheduledForById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { topics, drafts, approved } = useMemo(() => {
    const sorted = [...data.pipelineItems].sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || "") || 0;
      const rightTime = Date.parse(right.updated_at || right.created_at || "") || 0;
      return rightTime - leftTime;
    });

    return {
      topics: sorted.filter(isIntelEmailTopic),
      drafts: sorted.filter(isDraftCampaign),
      approved: sorted.filter(isApprovedCampaign),
    };
  }, [data.pipelineItems]);

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]);
  }

  async function assembleNewsletter() {
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/email-campaigns/assemble-newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicIds: selectedIds }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(payload.error || "No se pudo crear la tarea de newsletter");

      setSelectedIds([]);
      setActiveTab("drafts");
      setMessage("Draft creado en Work Queue. Cuando Marketing lo complete, queda listo para revisar en Drafts.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error creando newsletter");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function reviewAction(itemId: string, action: "request_changes" | "approve" | "schedule") {
    setBusyId(itemId);
    setMessage(null);

    try {
      const scheduledFor = scheduledForById[itemId]
        ? new Date(scheduledForById[itemId]).toISOString()
        : null;
      const response = await fetch(`/api/email-campaigns/${itemId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, feedback: feedbackById[itemId] || "", scheduled_for: scheduledFor }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "No se pudo actualizar el draft");

      if (action === "approve") {
        setActiveTab("approved");
        setMessage(payload.workItem
          ? "Email aprobado y programado. Se creó/actualizó el Work Queue con scheduled_for."
          : "Email aprobado. Queda listo para programar si no tenía fecha de launch."
        );
      } else if (action === "schedule") {
        setActiveTab("approved");
        setMessage("Email programado. Se creó/actualizó el Work Queue con scheduled_for.");
      } else {
        setMessage("Feedback enviado. Se creó una tarea en Work Queue para rehacer el draft.");
      }
      setFeedbackById((current) => ({ ...current, [itemId]: "" }));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Error actualizando draft");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">📧 Email Campaigns</h1>
          <p className="mt-2 max-w-3xl text-sm text-gray-400">
            Flujo simple: temas → drafts con revisión → aprobados/listos para enviar.
          </p>
        </div>
        {activeTab === "topics" && (
          <button
            type="button"
            onClick={assembleNewsletter}
            disabled={selectedIds.length === 0 || isSubmitting}
            className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
          >
            {isSubmitting ? "Creando…" : `Armar draft${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
          </button>
        )}
      </header>

      <nav className="flex flex-wrap gap-2">
        <TabButton active={activeTab === "topics"} label="Temas" count={topics.length} onClick={() => setActiveTab("topics")} />
        <TabButton active={activeTab === "drafts"} label="Drafts" count={drafts.length} onClick={() => setActiveTab("drafts")} />
        <TabButton active={activeTab === "approved"} label="Aprobados / Programados" count={approved.length} onClick={() => setActiveTab("approved")} />
      </nav>

      {data.errors.length > 0 && (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
          {data.errors.map((error) => <p key={error}>{error}</p>)}
        </div>
      )}

      {message && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-gray-200">
          {message}
        </div>
      )}

      {activeTab === "topics" && (
        <section className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">Temas para newsletter</h2>
              <p className="mt-1 text-sm text-gray-500">Solo títulos. Seleccioná 2–3 y armá el draft del jueves.</p>
            </div>
          </div>

          <div className="mt-5 divide-y divide-white/8">
            {topics.length > 0 ? topics.map((topic) => (
              <label key={topic.id} className="flex cursor-pointer items-start gap-3 py-3">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(topic.id)}
                  onChange={() => toggleSelected(topic.id)}
                  className="mt-1 h-4 w-4 rounded border-gray-700 bg-black text-white focus:ring-white"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">{topic.title || "Tema sin título"}</span>
                </span>
              </label>
            )) : (
              <div className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-sm text-gray-500">
                No hay temas promovidos a Email desde Intel Inbox.
              </div>
            )}
          </div>
        </section>
      )}

      {activeTab === "drafts" && (
        <section>
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white">Drafts</h2>
            <p className="mt-1 text-sm text-gray-500">Revisá el email, dejá correcciones, mandalo a rehacer o aprobalo.</p>
          </div>
          {drafts.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {drafts.map((draft) => (
                <DraftCard
                  key={draft.id}
                  item={draft}
                  workItems={data.workItems}
                  feedback={feedbackById[draft.id] || ""}
                  busy={busyId === draft.id}
                  onFeedbackChange={(value) => setFeedbackById((current) => ({ ...current, [draft.id]: value }))}
                  onRequestChanges={() => reviewAction(draft.id, "request_changes")}
                  onApprove={() => reviewAction(draft.id, "approve")}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-[#111118] px-5 py-8 text-sm text-gray-500">
              No hay drafts para revisar.
            </div>
          )}
        </section>
      )}

      {activeTab === "approved" && (
        <section>
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white">Aprobados / Programados</h2>
            <p className="mt-1 text-sm text-gray-500">Aprobados para elegir fecha, o ya programados vía Work Queue.</p>
          </div>
          {approved.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {approved.map((item) => (
                <ApprovedCard
                  key={item.id}
                  item={item}
                  workItems={data.workItems}
                  scheduledForDraft={scheduledForById[item.id] ?? formatForDatetimeLocal(item.scheduled_for)}
                  busy={busyId === item.id}
                  onScheduledForChange={(value) => setScheduledForById((current) => ({ ...current, [item.id]: value }))}
                  onSchedule={() => reviewAction(item.id, "schedule")}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-[#111118] px-5 py-8 text-sm text-gray-500">
              No hay emails aprobados todavía.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
