"use client";

import { useState } from "react";

export function ApprovalDecisionBox({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone?: () => void;
}) {
  const [loading, setLoading] = useState<"approve" | "rework" | null>(null);
  const [comment, setComment] = useState("");

  async function submit(action: "approve" | "rework") {
    setLoading(action);
    try {
      const res = await fetch(`/api/projects/${projectId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queue: action === "approve",
          action,
          comment: comment.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to update approval state");
      }

      onDone?.();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Failed to update approval state");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment for approval or rework..."
        className="min-h-[88px] w-full rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white outline-none placeholder:text-gray-500 focus:border-gray-600"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <button
          onClick={() => submit("rework")}
          disabled={loading !== null}
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {loading === "rework" ? "Sending..." : "Rework plan"}
        </button>
        <button
          onClick={() => submit("approve")}
          disabled={loading !== null}
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {loading === "approve" ? "Approving..." : "Approve and continue"}
        </button>
      </div>
    </div>
  );
}
