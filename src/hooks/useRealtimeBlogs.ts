"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { BlogItem } from "@/app/blogs/page";

export function useRealtimeBlogs(initialBlogs: BlogItem[]): BlogItem[] {
  const [blogs, setBlogs] = useState<BlogItem[]>(initialBlogs);
  const supabase = createClient();

  useEffect(() => {
    setBlogs(initialBlogs);
  }, [initialBlogs]);

  useEffect(() => {
    const channel = supabase
      .channel("blogs-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pipeline_items", filter: "pipeline_type=eq.blog" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const item = payload.new as BlogItem;
            setBlogs((prev) => (prev.some((b) => b.id === item.id) ? prev : [item, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const item = payload.new as BlogItem;
            setBlogs((prev) => prev.map((b) => (b.id === item.id ? { ...b, ...item } : b)));
          } else if (payload.eventType === "DELETE") {
            const item = payload.old as { id: string };
            setBlogs((prev) => prev.filter((b) => b.id !== item.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return blogs;
}
