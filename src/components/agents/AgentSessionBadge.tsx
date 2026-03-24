"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/utils";

interface SessionInfo {
  active: boolean;
  currentTask: string | null;
  startedAt: string | null;
  lastActivity: string | null;
  lastActivityType: string | null;
  lastActivityAt: string | null;
}

export function AgentSessionBadge({ agentId }: { agentId: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    fetch("/api/agents/sessions")
      .then((r) => r.json())
      .then((data) => {
        if (data[agentId]) setSession(data[agentId]);
      })
      .catch(() => {});

    // Refresh every 30s
    const interval = setInterval(() => {
      fetch("/api/agents/sessions")
        .then((r) => r.json())
        .then((data) => {
          setSession(data[agentId] || null);
        })
        .catch(() => {});
    }, 30000);

    return () => clearInterval(interval);
  }, [agentId]);

  if (!session) return null;

  if (session.active) {
    return (
      <div className="mt-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs font-medium text-green-400">Working</span>
        </div>
        {session.currentTask && (
          <p className="mt-1 text-xs text-green-300/80 line-clamp-1">
            {session.currentTask}
          </p>
        )}
        {session.startedAt && (
          <p className="mt-0.5 text-xs text-green-500/60">
            Started {timeAgo(session.startedAt)}
          </p>
        )}
      </div>
    );
  }

  if (session.lastActivityAt) {
    return (
      <div className="mt-3 text-xs text-gray-600">
        Last seen {timeAgo(session.lastActivityAt)}
      </div>
    );
  }

  return null;
}
