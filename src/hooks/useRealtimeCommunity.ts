"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createClient } from "@/lib/supabase/client";
import type { CommunityItem } from "@/app/community/page";

export function useRealtimeCommunity(initialItems: CommunityItem[]): [CommunityItem[], Dispatch<SetStateAction<CommunityItem[]>>] {
  const [items, setItems] = useState<CommunityItem[]>(initialItems);
  const supabase = createClient();

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    const channel = supabase
      .channel("community-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pipeline_items", filter: "pipeline_type=eq.community_post" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const item = payload.new as CommunityItem;
            setItems((prev) => (prev.some((existing) => existing.id === item.id) ? prev : [item, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const item = payload.new as CommunityItem;
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
