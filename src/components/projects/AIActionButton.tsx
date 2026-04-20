"use client";

import { useState } from "react";

/**
 * Reusable button that creates a task for an agent via a server-side route.
 * Used for: "AI: Create Epics", "AI: Create Tasks", etc.
 */
export function AIActionButton({
  label,
  projectId,
  projectTitle,
  agent,
  instruction,
  className,
}: {
  label: string;
  projectId: string;
  projectTitle: string;
  agent: string;
  instruction: string;
  className?: string;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [clickCount, setClickCount] = useState(0);

  async function handleClick() {
    if (sent || sending) return;
    setClickCount((c) => c + 1);
    if (clickCount > 0) return;
    setSending(true);

    try {
      const res = await fetch("/api/projects/ai-action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          label,
          projectId,
          projectTitle,
          instruction,
          agent,
        }),
      });

      if (res.ok) {
        setSent(true);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={sending || sent}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
        sent
          ? "border border-green-600/50 bg-green-600/10 text-green-400"
          : "border border-purple-600/50 bg-purple-600/10 text-purple-400 hover:bg-purple-600/20"
      } ${className || ""}`}
    >
      {sent ? "✅ Sent" : sending ? "⏳..." : `🤖 ${label}`}
    </button>
  );
}
