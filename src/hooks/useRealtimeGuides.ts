"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createClient } from "@/lib/supabase/client";
import type { GuideItem } from "@/app/guides/page";

export function useRealtimeGuides(initialGuides: GuideItem[]): [GuideItem[], Dispatch<SetStateAction<GuideItem[]>>] {
  const [guides, setGuides] = useState<GuideItem[]>(initialGuides);
  const supabase = createClient();

  useEffect(() => {
    setGuides(initialGuides);
  }, [initialGuides]);

  useEffect(() => {
    const channel = supabase
      .channel("guides-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pipeline_items" },
        (payload) => {
          const candidate = (payload.eventType === "DELETE" ? payload.old : payload.new) as { pipeline_type?: string };
          if (!["doc", "guide"].includes(String(candidate?.pipeline_type))) return;
          if (payload.eventType === "INSERT") {
            const item = payload.new as GuideItem;
            setGuides((prev) => (prev.some((b) => b.id === item.id) ? prev : [item, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const item = payload.new as GuideItem;
            setGuides((prev) => prev.map((b) => (b.id === item.id ? { ...b, ...item } : b)));
          } else if (payload.eventType === "DELETE") {
            const item = payload.old as { id: string };
            setGuides((prev) => prev.filter((b) => b.id !== item.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return [guides, setGuides];
}
