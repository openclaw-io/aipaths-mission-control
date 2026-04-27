"use client";

import { useState } from "react";

export function SubmitClarificationBox({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone?: () => void;
}) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!value.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: value.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to submit clarification");
      }

      setValue("");
      onDone?.();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : "Failed to submit clarification");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
      <label className="mb-2 block text-sm font-medium text-amber-100">Your Clarification</label>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={5}
        placeholder="Write one clarification response that addresses the open questions..."
        className="w-full rounded-lg border border-gray-700 bg-[#0d0d14] px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
      />
      <div className="mt-3 flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={loading || !value.trim()}
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Submitting..." : "Submit Clarification"}
        </button>
      </div>
    </div>
  );
}
