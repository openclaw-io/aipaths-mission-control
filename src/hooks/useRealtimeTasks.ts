"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/app/tasks/page";

/**
 * Hook that subscribes to Supabase Realtime changes on agent_tasks.
 * Takes initial server-fetched tasks and keeps them in sync.
 */
export function useRealtimeTasks(initialTasks: Task[]): Task[] {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const supabase = createClient();

  useEffect(() => {
    // Sync initial tasks on prop change (e.g., navigation)
    setTasks(initialTasks);
  }, [initialTasks]);

  useEffect(() => {
    const channel = supabase
      .channel("tasks-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_tasks" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newTask = payload.new as Task;
            setTasks((prev) => {
              // Avoid duplicates
              if (prev.some((t) => t.id === newTask.id)) return prev;
              return [newTask, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as Task;
            setTasks((prev) =>
              prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t))
            );
          } else if (payload.eventType === "DELETE") {
            const deleted = payload.old as { id: string };
            setTasks((prev) => prev.filter((t) => t.id !== deleted.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return tasks;
}
