"use client";

import { useRef, useState } from "react";

export function ApproveForQueueButton({
  loopId,
  disabled,
  onDone,
}: {
  loopId: string;
  disabled?: boolean;
  onDone?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const pendingDecisionId = useRef<string | null>(null);

  async function handleApprove() {
    const decisionId = pendingDecisionId.current || crypto.randomUUID();
    pendingDecisionId.current = decisionId;
    setLoading(true);
    try {
      const res = await fetch(`/api/loops/${loopId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision_id: decisionId, action: "approve", queue: true }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to approve loop");
      }

      pendingDecisionId.current = null;
      onDone?.();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Failed to approve loop");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleApprove}
      disabled={disabled || loading}
      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Approving..." : "Approve for Queue"}
    </button>
  );
}
