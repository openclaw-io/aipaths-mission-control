import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Agent → { agentId, channelId } mapping (matches inbox-router)
const AGENT_ROUTING: Record<string, { agentId: string; channelId: string }> = {
  strategist: { agentId: "strategist", channelId: "1474045438989697115" },
  youtube:    { agentId: "youtube",    channelId: "1473373627750682664" },
  content:    { agentId: "content",    channelId: "1473373703197691934" },
  marketing:  { agentId: "marketing",  channelId: "1473373756557623481" },
  dev:        { agentId: "dev",        channelId: "1473373777755639982" },
  community:  { agentId: "community",  channelId: "1473373793375490058" },
  editor:     { agentId: "editor",     channelId: "1473373703197691934" }, // shares content channel
  legal:      { agentId: "legal",      channelId: "1473373703197691934" },
};

/**
 * Wake an OpenClaw agent via the gateway's chat completions API.
 * Same pattern as inbox-router's wakeDirector().
 */
async function wakeAgent(agentId: string, channelId: string, message: string): Promise<boolean> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!gatewayToken) {
    console.log(`[notify] No OPENCLAW_GATEWAY_TOKEN — skipping agent wake for ${agentId}`);
    return false;
  }

  const sessionKey = `agent:${agentId}:discord:channel:${channelId}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": agentId,
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    console.log(`[notify] ${agentId} wake: HTTP ${res.status}`);
    return res.ok;
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.log(`[notify] ${agentId} wake: sent (response timed out — agent is working)`);
      return true;
    }
    console.error(`[notify] ${agentId} wake failed:`, err.message);
    return false;
  }
}

/**
 * POST /api/tasks/notify
 * 1. Posts to Discord #task-router (visibility for Gonza)
 * 2. Wakes the assigned agent via OpenClaw gateway
 */
export async function POST(request: NextRequest) {
  // Accept either Supabase cookie auth OR internal API key
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const isInternalCall = !!bearerToken && bearerToken === process.env.AGENT_API_KEY;

  if (!isInternalCall) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { taskId, agent, title, action } = await request.json();

  const routing = AGENT_ROUTING[agent];
  if (!routing) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  // Fetch full task details for the wake message
  let instruction = "";
  if (taskId) {
    const adminDb = createServiceClient();
    const { data: task } = await adminDb
      .from("agent_tasks")
      .select("instruction")
      .eq("id", taskId)
      .single();
    if (task?.instruction) instruction = task.instruction;
  }

  // Build notification message with full context
  const actionLabels: Record<string, string> = {
    created: "📋 New task assigned to you",
    unblocked: "🔓 Task unblocked and ready",
    approved: "✅ Task approved by Gonza",
    promoted: "📅 Scheduled task now ready",
  };
  const label = actionLabels[action] || "📋 Task update";

  let message = `${label}: "${title}" (task ID: ${taskId})\n`;
  if (instruction) {
    message += `\n## Instructions\n${instruction}\n`;
  }
  message += `\nWhen done, update the task status using the mission-control skill.`;

  // 1. Discord webhook (for Gonza's visibility)
  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `📤 Mission Control → @${agent}: "${title}" (${action})`,
        }),
      });
    } catch (err) {
      console.error("[notify] Discord webhook failed:", err);
    }
  }

  // 2. Wake the agent via gateway
  let woke = false;
  if (agent !== "gonza") {
    woke = await wakeAgent(routing.agentId, routing.channelId, message);
  }

  return NextResponse.json({ ok: true, agent, woke });
}
