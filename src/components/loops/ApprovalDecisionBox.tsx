"use client";

import { useRef, useState } from "react";

export function ApprovalDecisionBox({
  loopId,
  onDone,
}: {
  loopId: string;
  onDone?: () => void;
}) {
  const [loading, setLoading] = useState<"approve" | "rework" | null>(null);
  const [comment, setComment] = useState("");
  const [stepTitle, setStepTitle] = useState("");
  const [stepNotes, setStepNotes] = useState("");
  const decisionIds = useRef(new Map<string, string>());

  async function submit(action: "approve" | "rework") {
    const planOperations = action === "rework"
      ? [{ type: "append_step", title: stepTitle.trim(), notes: stepNotes.trim() || null }]
      : undefined;
    if (action === "rework" && !planOperations?.[0].title) {
      alert("Add the title of the plan step to append.");
      return;
    }
    const decisionPayload = {
      queue: action === "approve",
      action,
      comment: comment.trim() || null,
      ...(planOperations ? { plan_operations: planOperations } : {}),
    };
    const fingerprint = JSON.stringify(decisionPayload);
    const decisionId = decisionIds.current.get(fingerprint) || crypto.randomUUID();
    decisionIds.current.set(fingerprint, decisionId);

    setLoading(action);
    try {
      const res = await fetch(`/api/loops/${loopId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, ...decisionPayload }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to update approval state");
      }

      decisionIds.current.delete(fingerprint);
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
        placeholder="Optional decision context (not interpreted as a plan operation)..."
        className="min-h-[72px] w-full rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white outline-none placeholder:text-gray-500 focus:border-gray-600"
      />
      <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
        <p className="text-xs text-amber-200">Structured plan rework: append one explicit step</p>
        <input
          value={stepTitle}
          onChange={(event) => setStepTitle(event.target.value)}
          placeholder="Step title (required for rework)"
          className="w-full rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white outline-none placeholder:text-gray-500 focus:border-gray-600"
        />
        <input
          value={stepNotes}
          onChange={(event) => setStepNotes(event.target.value)}
          placeholder="Step notes (optional)"
          className="w-full rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2 text-sm text-white outline-none placeholder:text-gray-500 focus:border-gray-600"
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          onClick={() => submit("rework")}
          disabled={loading !== null || !stepTitle.trim()}
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {loading === "rework" ? "Sending..." : "Append step and rework plan"}
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
