"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { INTEL_DESTINATION_OPTIONS } from "@/lib/intel-destinations";
import type { IntelInboxDetail } from "@/lib/intel-inbox";

function formatScore(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getSourceLabel(detail: IntelInboxDetail | null) {
  const url = detail?.rawSource?.canonicalUrl || detail?.rawSource?.url || null;
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  return detail?.rawSource?.sourceContext || detail?.item.sourceLabel || detail?.item.lane || "Intel source";
}

const SOURCE_BADGE = {
  youtube: "border-red-400/30 bg-red-500/10 text-red-100",
  reddit: "border-orange-400/30 bg-orange-500/10 text-orange-100",
  web: "border-sky-400/30 bg-sky-500/10 text-sky-100",
  producthunt: "border-purple-400/30 bg-purple-500/10 text-purple-100",
  github: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  hackernews: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  other: "border-gray-600 bg-white/5 text-gray-300",
} as const;

export function IntelInboxDetail({
  detail,
  loading,
  onClose,
  onAction,
}: {
  detail: IntelInboxDetail | null;
  loading: boolean;
  onClose: () => void;
  onAction: (action: "promote" | "park" | "discard", payload?: { comment?: string; destinations?: string[]; ownerAgent?: string; collaborators?: string[] }) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedDestinations, setSelectedDestinations] = useState<string[]>([]);
  const [comment, setComment] = useState<string>("");

  const item = detail?.item ?? null;
  const sourceUrl = detail?.rawSource?.canonicalUrl || detail?.rawSource?.url || null;
  const sourceLabel = getSourceLabel(detail);
  const sourceBadgeClass = item ? SOURCE_BADGE[item.sourceKind] || SOURCE_BADGE.other : SOURCE_BADGE.other;

  useEffect(() => {
    if (!detail?.item) return;
    const nextDestinations =
      detail.review?.selectedDestinations?.length
        ? detail.review.selectedDestinations
        : detail.item.suggestedDestinations?.length
          ? detail.item.suggestedDestinations
          : [];
    setSelectedDestinations(nextDestinations);
    setComment(detail.review?.notes || "");
  }, [detail]);

  async function submit(action: "promote" | "park" | "discard") {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(action);
    setErrorMessage(null);
    try {
      await onAction(
        action,
        action === "promote"
          ? { comment, destinations: selectedDestinations }
          : { comment },
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `No se pudo completar la acción ${action}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  }

  function toggleDestination(key: string) {
    setSelectedDestinations((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
    );
  }

  if (loading) {
    return (
      <IntelDrawerShell onClose={onClose}>
        <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400">
          Loading intel detail...
        </div>
      </IntelDrawerShell>
    );
  }

  if (!detail || !item) return null;

  return (
    <IntelDrawerShell onClose={onClose}>
      <div className="border-b border-gray-800 bg-[#101018]/95 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className="rounded-full border border-sky-400/30 bg-sky-500/10 px-2.5 py-1 font-semibold uppercase tracking-wide text-sky-200">
                Intel Inbox
              </span>
              <span className={`rounded-full border px-2.5 py-1 font-semibold uppercase tracking-wide ${sourceBadgeClass}`}>
                {item.sourceLabel}
              </span>
              {item.discussionContext ? (
                <span className="rounded-full border border-orange-400/25 bg-orange-500/10 px-2.5 py-1 font-medium uppercase tracking-wide text-orange-100">
                  {item.discussionContext}
                </span>
              ) : null}
              {item.isLatestRun ? (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-medium uppercase tracking-wide text-emerald-200">
                  Latest run
                </span>
              ) : null}
              {item.reviewStatus !== "new" ? (
                <span className="rounded-full border border-gray-700 px-2.5 py-1 uppercase tracking-wide text-gray-300">
                  {item.reviewStatus}
                </span>
              ) : null}
            </div>
            <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{item.title}</h2>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-300">
              <MetaPill label="Fuente" value={sourceLabel} />
              <MetaPill label="Fecha" value={formatDate(detail.rawSource?.publishedAt || item.createdAt)} />
              <MetaPill label="Score" value={formatScore(item.overallScore)} />
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg bg-white/10 px-3 py-2 text-sm text-white transition hover:bg-white/15">
            Close
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <section className="rounded-2xl border border-gray-800 bg-[#15151d] p-6 shadow-xl">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">Resumen</div>
            <p className="whitespace-pre-wrap text-[15px] leading-7 text-gray-200">
              {item.summary || "Sin resumen"}
            </p>
            {item.whyItMatters ? (
              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Why it matters</div>
                <p className="mt-2 text-sm leading-6 text-gray-300">{item.whyItMatters}</p>
              </div>
            ) : null}
          </section>

          <section className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white">Destino de promoción</div>
                <p className="mt-1 text-xs text-gray-500">Seleccioná uno o más destinos. Cada uno crea su propio pipeline item.</p>
              </div>
              {selectedDestinations.length > 0 ? (
                <div className="text-xs text-gray-400">{selectedDestinations.length} seleccionado{selectedDestinations.length !== 1 ? "s" : ""}</div>
              ) : null}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {INTEL_DESTINATION_OPTIONS.map((option) => {
                const active = selectedDestinations.includes(option.key);
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => toggleDestination(option.key)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      active
                        ? "border-sky-400/40 bg-sky-500/10 text-white shadow-[0_0_0_1px_rgba(56,189,248,0.15)]"
                        : "border-gray-800 bg-[#0d0d14] text-gray-300 hover:border-gray-700 hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">{option.label}</div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${active ? "bg-sky-300/15 text-sky-100" : "bg-white/5 text-gray-400"}`}>
                        {option.pipelineType}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-gray-400">Director: {option.director}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
            <div className="text-sm font-medium text-white">Notas</div>
            <p className="mt-1 text-xs text-gray-500">Contexto útil para explicar por qué se promueve, guarda o descarta.</p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              placeholder="Ej: buena para blog y email, demasiado repetida, útil para comunidad, falta validar la fuente..."
              className="mt-3 w-full rounded-xl border border-gray-800 bg-[#0a0a0f] p-3 text-sm text-white outline-none transition placeholder:text-gray-600 focus:border-sky-500"
            />
          </section>

          <section className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
            <div className="text-sm font-medium text-white">Fuente</div>
            <div className="mt-3 space-y-3 text-sm text-gray-300">
              {detail.rawSource?.title ? <p className="font-medium text-white">{detail.rawSource.title}</p> : null}
              {detail.rawSource?.sourceContext ? <p className="text-gray-400">{detail.rawSource.sourceContext}</p> : null}
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex rounded-full border border-gray-700 px-3 py-1.5 text-xs text-sky-300 underline-offset-4 hover:underline"
                >
                  Ver fuente
                </a>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <div className="border-t border-gray-800 bg-[#111118]/95 p-5 shadow-[0_-20px_45px_rgba(0,0,0,0.25)]">
        {errorMessage ? (
          <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {errorMessage}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => submit("promote")}
            disabled={!!submitting || selectedDestinations.length === 0}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === "promote" ? "Working..." : "Promote selected"}
          </button>
          <button
            onClick={() => submit("park")}
            disabled={!!submitting}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/5 disabled:opacity-50"
          >
            {submitting === "park" ? "Working..." : "Save"}
          </button>
          <button
            onClick={() => submit("discard")}
            disabled={!!submitting}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/5 disabled:opacity-50"
          >
            {submitting === "discard" ? "Working..." : "Dismiss"}
          </button>
        </div>
      </div>
    </IntelDrawerShell>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-gray-700 bg-white/5 px-3 py-1">
      <span className="text-gray-500">{label}:</span> {value}
    </span>
  );
}

function IntelDrawerShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-y-0 right-0 left-64 z-50 flex justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-4xl min-w-0 flex-col border-l border-gray-800 bg-[#0f0f16] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  );
}
