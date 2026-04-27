"use client";

import { useState } from "react";

export function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: input.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to create project");
      }

      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">New Project</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 transition hover:text-white">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe the project you want to start..."
            required
            autoFocus
            rows={5}
            className="w-full rounded-lg border border-gray-800 bg-[#111118] px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none"
          />

          <p className="text-xs text-gray-500">
            We’ll auto-fill title, summary, priority, and owner so it enters the workflow directly.
          </p>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-gray-800 pt-4">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 transition hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !input.trim()}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
