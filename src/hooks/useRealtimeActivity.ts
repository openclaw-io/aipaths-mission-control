"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface ActivityEvent {
  id: string;
  agent: string;
  event_type: string;
  title: string;
  detail: string | null;
  task_id: string | null;
  created_at: string;
}

export function useRealtimeActivity(initialEvents: ActivityEvent[]): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>(initialEvents);
  const supabase = createClient();

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    const channel = supabase
      .channel("activity-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_log" },
        (payload) => {
          const newEvent = payload.new as ActivityEvent;
          setEvents((prev) => [newEvent, ...prev].slice(0, 100)); // Keep max 100
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return events;
}
