"use client";

import { useState } from "react";

export function ProjectReviewActions({
  projectId,
  status,
  onDone,
}: {
  projectId: string;
  status: string;
  onDone?: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState<string | null>(null);

  async function runAction(action: string) {
    setLoading(action);
    try {
      const res = await fetch(`/api/projects/${projectId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, feedback: feedback.trim() || null }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to update review state");
      }

      setFeedback("");
      onDone?.();
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to update review state");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-[#0d0d14] p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">Review Flow</h3>
        <p className="mt-1 text-xs text-gray-500">
          Move the project into review, approve the deliverable, or request changes with context.
        </p>
      </div>

      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={4}
        placeholder="Optional review notes or requested changes..."
        className="w-full rounded-lg border border-gray-700 bg-[#111118] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {status === "in_review" && (
          <>
            <button
              onClick={() => runAction("approve_deliverable")}
              disabled={!!loading}
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {loading === "approve_deliverable" ? "Approving..." : "Approve Deliverable"}
            </button>
            <button
              onClick={() => runAction("request_changes")}
              disabled={!!loading}
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
            >
              {loading === "request_changes" ? "Sending..." : "Request Changes"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
