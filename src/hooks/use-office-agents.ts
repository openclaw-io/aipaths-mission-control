"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { buildSpriteAgents } from "@/lib/office-status";
import type { SpriteAgent } from "@/lib/types/office";

interface TaskRow {
  id: string;
  title: string;
  owner_agent: string | null;
  target_agent_id: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface MemoryRow {
  agent: string;
  date: string;
  content?: string | null;
  created_at?: string;
}

const POLL_INTERVAL = 300_000;

export function useOfficeAgents(
  initialTasks: TaskRow[],
  initialMemory: MemoryRow[],
): SpriteAgent[] {
  const [tasks, setTasks] = useState<TaskRow[]>(initialTasks);
  const [memory, setMemory] = useState<MemoryRow[]>(initialMemory);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function refresh() {
      if (document.visibilityState !== "visible") return;
      const body = await fetch("/api/office/agents", { cache: "no-store" })
        .then((res) => res.ok ? res.json() : null)
        .catch(() => null);

      if (body?.tasks) setTasks(body.tasks as TaskRow[]);
      if (body?.memory) setMemory(body.memory as MemoryRow[]);
    }

    pollRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL);

    const handleVisibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", handleVisibleRefresh);
    document.addEventListener("visibilitychange", handleVisibleRefresh);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener("focus", handleVisibleRefresh);
      document.removeEventListener("visibilitychange", handleVisibleRefresh);
    };
  }, []);

  return useMemo(() => buildSpriteAgents(tasks, memory), [tasks, memory]);
}
