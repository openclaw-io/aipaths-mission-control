"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const AGENTS = [
  { id: "dev", name: "💻 Dev Director" },
  { id: "strategist", name: "🧠 Strategist" },
  { id: "youtube", name: "🎬 YouTube" },
  { id: "content", name: "✍️ Content" },
  { id: "marketing", name: "📣 Marketing" },
  { id: "community", name: "🌐 Community" },
  { id: "gonza", name: "👤 Gonza" },
];

export function CreateEpicModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState("dev");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const { error: insertError } = await supabase
      .from("agent_tasks")
      .insert({
        title: title.trim(),
        description: description.trim() || null,
        agent,
        status: "draft",
        priority: "medium",
        tags: ["epic"],
        depends_on: [],
      });

    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    window.location.reload();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-white">New Project</h2>
          <button onClick={onClose} className="rounded p-1 text-gray-500 hover:text-white transition">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Project name..."
            required
            autoFocus
            className="w-full border-0 bg-transparent text-lg text-white placeholder-gray-600 focus:outline-none"
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Describe the plan, goals, and considerations..."
            className="w-full border-0 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none resize-none"
          />

          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Lead:</span>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none"
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-gray-800 pt-4">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-white transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 transition disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
