"use client";

import { useState } from "react";

/**
 * Reusable button that creates a task for an agent via the agent API.
 * Used for: "AI: Create Epics", "AI: Create Tasks", etc.
 */
export function AIActionButton({
  label,
  projectId,
  projectTitle,
  projectDescription,
  agent,
  instruction,
  className,
}: {
  label: string;
  projectId: string;
  projectTitle: string;
  projectDescription: string | null;
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
    if (clickCount > 0) return; // Prevent double-click
    setSending(true);

    try {
      const res = await fetch("/api/agent/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.NEXT_PUBLIC_AGENT_API_KEY}`,
        },
        body: JSON.stringify({
          title: `${label}: ${projectTitle}`,
          instruction,
          agent,
          created_by: "gonza",
          parent_id: projectId,
          status: "new",
        }),
      });

      if (res.ok) {
        setSent(true);
        // Also trigger notify to wake the agent
        const task = await res.json();
        fetch("/api/tasks/notify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.NEXT_PUBLIC_AGENT_API_KEY}`,
          },
          body: JSON.stringify({
            taskId: task.id,
            agent,
            title: task.title,
            action: "created",
          }),
        }).catch(() => {});
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
