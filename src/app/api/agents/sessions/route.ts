import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/sessions
 * Returns which agents are currently active (have in_progress work items)
 * and their latest activity.
 */
export async function GET() {
  const supabase = createServiceClient();

  // Get in_progress work_items (canonical execution queue; indicates active agent)
  const { data: activeTasks } = await supabase
    .from("work_items")
    .select("owner_agent, target_agent_id, title, started_at")
    .eq("status", "in_progress")
    .or("target_agent_id.not.is.null,owner_agent.not.is.null");

  // Get latest activity per agent (last 1 hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recentActivity } = await supabase
    .from("activity_log")
    .select("agent, event_type, title, created_at")
    .gte("created_at", oneHourAgo)
    .order("created_at", { ascending: false })
    .limit(50);

  // Build per-agent session info
  const sessions: Record<string, {
    active: boolean;
    currentTask: string | null;
    startedAt: string | null;
    lastActivity: string | null;
    lastActivityType: string | null;
    lastActivityAt: string | null;
  }> = {};

  for (const task of activeTasks || []) {
    const agent = task.target_agent_id || task.owner_agent;
    if (!agent) continue;

    sessions[agent] = {
      active: true,
      currentTask: task.title,
      startedAt: task.started_at,
      lastActivity: null,
      lastActivityType: null,
      lastActivityAt: null,
    };
  }

  // Add recent activity
  const seen = new Set<string>();
  for (const event of recentActivity || []) {
    if (seen.has(event.agent)) continue;
    seen.add(event.agent);

    if (!sessions[event.agent]) {
      sessions[event.agent] = {
        active: false,
        currentTask: null,
        startedAt: null,
        lastActivity: event.title,
        lastActivityType: event.event_type,
        lastActivityAt: event.created_at,
      };
    } else {
      sessions[event.agent].lastActivity = event.title;
      sessions[event.agent].lastActivityType = event.event_type;
      sessions[event.agent].lastActivityAt = event.created_at;
    }
  }

  return NextResponse.json(sessions);
}
