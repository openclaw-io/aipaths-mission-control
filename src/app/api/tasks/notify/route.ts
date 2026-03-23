import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/notify
 * Sends a notification to the assigned agent about a task.
 * Uses OpenClaw's sessions_send via the gateway API.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { taskId, agent, title, action } = await request.json();

  // Map agent names to OpenClaw session labels
  const AGENT_SESSIONS: Record<string, string> = {
    strategist: "strategist",
    youtube: "youtube",
    content: "content",
    marketing: "marketing",
    dev: "dev",
    community: "community",
    editor: "editor",
    legal: "legal",
  };

  const sessionLabel = AGENT_SESSIONS[agent];
  if (!sessionLabel) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  // Build notification message
  const messages: Record<string, string> = {
    created: `📋 New task assigned to you: "${title}"`,
    unblocked: `🔓 Task unblocked and ready: "${title}"`,
    approved: `✅ Task approved by Gonza: "${title}"`,
  };

  const message = messages[action] || `📋 Task update: "${title}"`;

  // Send via Discord webhook (task-router channel)
  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `📤 @gonza → @${agent}: "${title}" (${action})`,
        }),
      });
    } catch (err) {
      console.error("[notify] Discord webhook failed:", err);
    }
  }

  return NextResponse.json({ ok: true, message, agent: sessionLabel });
}
