"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
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
  content: string;
  created_at?: string;
}

const POLL_INTERVAL = 10_000;
const REALTIME_TIMEOUT = 5_000;

export function useOfficeAgents(
  initialTasks: TaskRow[],
  initialMemory: MemoryRow[],
): SpriteAgent[] {
  const [tasks, setTasks] = useState<TaskRow[]>(initialTasks);
  const [memory, setMemory] = useState<MemoryRow[]>(initialMemory);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let realtimeConnected = false;

    const channel = supabase
      .channel("office-agents")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_items" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setTasks((prev) => prev.filter((t) => t.id !== (payload.old as TaskRow).id));
          } else {
            const row = payload.new as TaskRow;
            setTasks((prev) => {
              const idx = prev.findIndex((t) => t.id === row.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = row;
                return next;
              }
              return [row, ...prev];
            });
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "memories",
          filter: "type=eq.journal",
        },
        (payload) => {
          if (payload.eventType !== "DELETE") {
            const row = payload.new as MemoryRow;
            setMemory((prev) => {
              const idx = prev.findIndex(
                (m) => m.agent === row.agent && m.date === row.date,
              );
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = row;
                return next;
              }
              return [row, ...prev]
                .sort((a, b) => {
                  const dateCompare = b.date.localeCompare(a.date);
                  if (dateCompare !== 0) return dateCompare;
                  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
                })
                .slice(0, 50);
            });
          }
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          realtimeConnected = true;
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      });

    // Fallback: if Realtime doesn't connect in 5s, start polling
    const fallbackTimer = setTimeout(() => {
      if (!realtimeConnected && !pollRef.current) {
        pollRef.current = setInterval(async () => {
          const [tasksRes, memRes] = await Promise.all([
            supabase
              .from("work_items")
              .select("id, title, owner_agent, target_agent_id, status, created_at, started_at, completed_at")
              .order("created_at", { ascending: false }),
            supabase
              .from("memories")
              .select("agent, date, content, created_at")
              .eq("type", "journal")
              .order("date", { ascending: false })
              .order("created_at", { ascending: false })
              .limit(50),
          ]);
          if (tasksRes.data) setTasks(tasksRes.data);
          if (memRes.data) setMemory(memRes.data);
        }, POLL_INTERVAL);
      }
    }, REALTIME_TIMEOUT);

    return () => {
      clearTimeout(fallbackTimer);
      if (pollRef.current) clearInterval(pollRef.current);
      supabase.removeChannel(channel);
    };
  }, []);

  return useMemo(() => buildSpriteAgents(tasks, memory), [tasks, memory]);
}
