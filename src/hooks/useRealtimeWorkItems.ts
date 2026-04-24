"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { LinkedWorkItem } from "@/app/blogs/page";

export function useRealtimeWorkItems(initialItems: LinkedWorkItem[]): LinkedWorkItem[] {
  const [items, setItems] = useState<LinkedWorkItem[]>(initialItems);
  const supabase = createClient();

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    const channel = supabase
      .channel("work-items-realtime-blog")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_items" },
        (payload) => {
          const candidate = (payload.eventType === "DELETE" ? payload.old : payload.new) as LinkedWorkItem & { source_type?: string };
          if (!candidate?.source_type || !["service", "pipeline_item"].includes(candidate.source_type)) return;
          if (candidate.source_type === "service" && candidate.payload?.trigger === "manual_transition") return;
          if (payload.eventType === "INSERT") {
            const item = payload.new as LinkedWorkItem;
            setItems((prev) => (prev.some((w) => w.id === item.id) ? prev : [item, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const item = payload.new as LinkedWorkItem;
            setItems((prev) => prev.map((w) => (w.id === item.id ? { ...w, ...item } : w)));
          } else if (payload.eventType === "DELETE") {
            const item = payload.old as { id: string };
            setItems((prev) => prev.filter((w) => w.id !== item.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return items;
}
