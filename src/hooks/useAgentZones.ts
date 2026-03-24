"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { AGENTS } from "@/lib/agents";

export type AgentZone = "work" | "kitchen" | "lounge";

export interface AgentZoneInfo {
  zone: AgentZone;
  task?: string;
  lastActivityAt?: string;
}

const THIRTY_MINUTES = 30 * 60 * 1000;

/**
 * Determines which zone each agent belongs to based on real-time data:
 * - "work": has an in_progress task → at desk
 * - "kitchen": last activity <30min ago → between tasks
 * - "lounge": idle (>30min or no activity)
 */
export function useAgentZones(): Record<string, AgentZoneInfo> {
  const [zones, setZones] = useState<Record<string, AgentZoneInfo>>({});
  const supabase = createClient();
  const agentActivity = useRef<Record<string, string>>({}); // agent → last activity ISO

  // Initial fetch + realtime subscriptions
  useEffect(() => {
    // 1. Fetch in_progress tasks
    async function fetchState() {
      const { data: activeTasks } = await supabase
        .from("agent_tasks")
        .select("agent, title, status")
        .eq("status", "in_progress")
        .not("tags", "cs", '{"epic"}')
        .not("tags", "cs", '{"project"}');

      // 2. Fetch recent activity (last 2 hours)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: recentActivity } = await supabase
        .from("activity_log")
        .select("agent, created_at")
        .gte("created_at", twoHoursAgo)
        .order("created_at", { ascending: false });

      // Build latest activity map
      const latestActivity: Record<string, string> = {};
      for (const event of recentActivity || []) {
        if (!latestActivity[event.agent]) {
          latestActivity[event.agent] = event.created_at;
        }
      }
      agentActivity.current = latestActivity;

      // Build working set
      const working = new Set<string>();
      const workingTasks: Record<string, string> = {};
      for (const task of activeTasks || []) {
        working.add(task.agent);
        workingTasks[task.agent] = task.title;
      }

      // Determine zones
      computeZones(working, workingTasks, latestActivity);
    }

    function computeZones(
      working: Set<string>,
      workingTasks: Record<string, string>,
      latestActivity: Record<string, string>
    ) {
      const now = Date.now();
      const newZones: Record<string, AgentZoneInfo> = {};

      for (const agent of AGENTS) {
        if (working.has(agent.id)) {
          newZones[agent.id] = { zone: "work", task: workingTasks[agent.id] };
        } else {
          const lastAt = latestActivity[agent.id];
          if (lastAt && now - new Date(lastAt).getTime() < THIRTY_MINUTES) {
            newZones[agent.id] = { zone: "kitchen", lastActivityAt: lastAt };
          } else {
            newZones[agent.id] = { zone: "lounge", lastActivityAt: lastAt };
          }
        }
      }

      setZones(newZones);
    }

    fetchState();

    // 3. Subscribe to task changes (detect in_progress)
    const taskChannel = supabase
      .channel("zones-tasks")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_tasks" },
        () => { fetchState(); } // Re-compute on any task change
      )
      .subscribe();

    // 4. Subscribe to activity (detect recent activity)
    const activityChannel = supabase
      .channel("zones-activity")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activity_log" },
        () => { fetchState(); }
      )
      .subscribe();

    // 5. Timer to re-evaluate zones every 60s (for 30min threshold)
    const timer = setInterval(() => { fetchState(); }, 60_000);

    return () => {
      supabase.removeChannel(taskChannel);
      supabase.removeChannel(activityChannel);
      clearInterval(timer);
    };
  }, [supabase]);

  return zones;
}
