"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createClient } from "@/lib/supabase/client";
import type { VideoPipelineItem } from "@/app/youtube/page";

export function useRealtimeYouTube(initialItems: VideoPipelineItem[]): [VideoPipelineItem[], Dispatch<SetStateAction<VideoPipelineItem[]>>] {
  const [items, setItems] = useState<VideoPipelineItem[]>(initialItems);
  const supabase = createClient();

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    const channel = supabase
      .channel("youtube-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pipeline_items", filter: "pipeline_type=eq.video" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const item = payload.new as VideoPipelineItem;
            setItems((prev) => (prev.some((existing) => existing.id === item.id) ? prev : [item, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const item = payload.new as VideoPipelineItem;
            setItems((prev) => prev.map((existing) => (existing.id === item.id ? { ...existing, ...item } : existing)));
          } else if (payload.eventType === "DELETE") {
            const item = payload.old as { id: string };
            setItems((prev) => prev.filter((existing) => existing.id !== item.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return [items, setItems];
}
