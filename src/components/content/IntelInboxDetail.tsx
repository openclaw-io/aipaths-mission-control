"use client";

import { useEffect, useState } from "react";
import type { IntelInboxDetail } from "@/lib/intel-inbox";

export function IntelInboxDetail({
  detail,
  loading,
  onClose,
  onAction,
}: {
  detail: IntelInboxDetail | null;
  loading: boolean;
  onClose: () => void;
  onAction: (action: "promote" | "park" | "discard", payload?: { comment?: string; ownerAgent?: string; collaborators?: string[] }) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);

  const item = detail?.item ?? null;
  const sourceUrl = detail?.rawSource?.canonicalUrl || detail?.rawSource?.url || null;
  const [ownerAgent, setOwnerAgent] = useState<string>("");
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [comment, setComment] = useState<string>("");

  const agentOptions = ["content", "marketing", "youtube", "community", "strategist"];

  useEffect(() => {
    if (!detail?.item) return;
    setOwnerAgent(detail.review?.selectedOwnerAgent || detail.item.promoteOwner || detail.item.suggestedOwner || "content");
    setCollaborators(detail.review?.selectedCollaborators || detail.item.promoteCollaborators || []);
    setComment(detail.review?.notes || "");
  }, [detail]);

  async function submit(action: "promote" | "park" | "discard") {
    setSubmitting(action);
    try {
      await onAction(
        action,
        action === "promote"
          ? { ownerAgent, collaborators, comment }
          : { comment },
      );
    } finally {
      setSubmitting(null);
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-gray-800 bg-[#111118] p-6 text-sm text-gray-400 shadow-2xl">
          Loading intel detail...
        </div>
      </div>
    );
  }

  if (!detail || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-800 bg-[#111118] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-800 px-6 py-5">
          <h2 className="min-w-0 text-xl font-semibold text-white">{item.title}</h2>
          <button onClick={onClose} className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">
            Close
          </button>
        </div>

        <div className="px-6 py-6">
          <div className="rounded-xl border border-gray-800 bg-[#0d0d14] p-5">
            <p className="whitespace-pre-wrap text-sm leading-7 text-gray-200">
              {item.summary || "Sin resumen"}
            </p>

            {sourceUrl ? (
              <div className="mt-4 border-t border-gray-800 pt-4">
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-blue-300 underline-offset-4 hover:underline"
                >
                  Ver fuente
                </a>
              </div>
            ) : null}
          </div>

          <div className="mt-5 rounded-xl border border-gray-800 bg-[#0d0d14] p-4">
            <div className="text-sm font-medium text-white">Comentario de decisión</div>
            <div className="mt-3">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Ej: buena para blog, muy técnica, repetida, útil para email, no encaja con AIPaths..."
                className="w-full rounded-lg border border-gray-700 bg-[#111118] px-3 py-2 text-sm text-white placeholder:text-gray-500"
              />
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-gray-800 bg-[#0d0d14] p-4">
            <div className="text-sm font-medium text-white">Promote settings</div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <label className="block text-sm text-gray-300">
                <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">Owner principal</div>
                <select
                  value={ownerAgent}
                  onChange={(e) => setOwnerAgent(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-[#111118] px-3 py-2 text-sm text-white"
                >
                  {agentOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>

              <div>
                <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">También enviar a</div>
                <div className="flex flex-wrap gap-2">
                  {agentOptions.filter((option) => option !== ownerAgent).map((option) => {
                    const active = collaborators.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setCollaborators((current) => active ? current.filter((value) => value !== option) : [...current, option])}
                        className={`rounded-full border px-3 py-1 text-xs ${active ? "border-blue-500 bg-blue-500/15 text-blue-200" : "border-gray-700 text-gray-300 hover:bg-white/5"}`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button
              onClick={() => submit("promote")}
              disabled={!!submitting}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting === "promote" ? "Working..." : "Promote"}
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
              className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950/50 disabled:opacity-50"
            >
              {submitting === "discard" ? "Working..." : "Dismiss"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
