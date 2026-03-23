"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠",
  youtube: "🎬",
  content: "✍️",
  marketing: "📣",
  dev: "💻",
  community: "🌐",
  editor: "📝",
  legal: "⚖️",
  gonza: "👤",
};

const PAGE_SIZE = 20;

export function TaskLogs({
  tasks,
  agentFilter,
}: {
  tasks: Task[];
  agentFilter: string;
}) {
  const [extra, setExtra] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const filtered = agentFilter === "all"
    ? tasks
    : tasks.filter((t) => t.agent === agentFilter);

  // Combine initial + loaded extra
  const allFiltered = agentFilter === "all"
    ? [...filtered, ...extra]
    : [...filtered, ...extra.filter((t) => t.agent === agentFilter)];

  // Sort by completed_at DESC
  const sorted = [...allFiltered].sort((a, b) => {
    const aTime = a.completed_at ? new Date(a.completed_at).getTime() : new Date(a.created_at).getTime();
    const bTime = b.completed_at ? new Date(b.completed_at).getTime() : new Date(b.created_at).getTime();
    return bTime - aTime;
  });

  // Deduplicate by id
  const seen = new Set<string>();
  const unique = sorted.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  async function loadMore() {
    setLoading(true);
    try {
      const supabase = createClient();
      const offset = tasks.length + extra.length;

      let query = supabase
        .from("agent_tasks")
        .select("*")
        .eq("status", "done")
        .order("completed_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (agentFilter !== "all") {
        query = query.eq("agent", agentFilter);
      }

      const { data } = await query;

      if (data && data.length > 0) {
        setExtra((prev) => [...prev, ...(data as Task[])]);
        if (data.length < PAGE_SIZE) setHasMore(false);
      } else {
        setHasMore(false);
      }
    } finally {
      setLoading(false);
    }
  }

  if (unique.length === 0) {
    return (
      <div className="mt-6">
        <p className="text-gray-500">No completed tasks yet.</p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <p className="text-sm text-gray-500 mb-3">
        {unique.length} completed task{unique.length !== 1 ? "s" : ""}
      </p>
      <div className="space-y-1.5">
        {unique.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-3 rounded-lg border border-gray-800 bg-[#111118] px-4 py-2.5"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
            <span className="text-sm text-white flex-1 min-w-0 truncate">
              {task.title}
            </span>
            <span className="text-xs text-gray-500 shrink-0">
              {AGENT_EMOJI[task.agent] ?? "🤖"} {task.agent}
            </span>
            <span className="text-xs text-gray-600 shrink-0">
              {task.completed_at ? timeAgo(task.completed_at) : timeAgo(task.created_at)}
            </span>
          </div>
        ))}
      </div>

      {hasMore && unique.length >= PAGE_SIZE && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="mt-4 w-full rounded-lg border border-gray-800 bg-[#111118] py-2.5 text-sm text-gray-400 hover:text-white hover:border-gray-600 transition disabled:opacity-50"
        >
          {loading ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}
