import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";
import { AGENT_ROUTING, isRoutedAgent } from "@/lib/agent-routing";

export const dynamic = "force-dynamic";

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildTaskStatusCommand(taskId: string, payload: Record<string, string>) {
  const envLocal = `${process.cwd()}/.env.local`;
  const envFile = `${process.cwd()}/.env`;
  const url = `http://127.0.0.1:3001/api/agent/tasks/${taskId}`;
  const body = JSON.stringify(payload);
  const script = `set -a; [ -f "${envLocal}" ] && . "${envLocal}"; [ -f "${envFile}" ] && . "${envFile}"; set +a; curl -s -X PATCH -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" "${url}" -d '${body}'`;
  return `bash -lc ${shellSingleQuote(script)}`;
}

function buildTaskSessionKey(agentId: string, taskId: string) {
  return `agent:${agentId}:mission-control:task:${taskId}`;
}

/**
 * Wake an OpenClaw agent via the gateway's chat completions API.
 * Same pattern as inbox-router's wakeDirector().
 */
async function wakeAgent(agentId: string, taskId: string, message: string): Promise<boolean> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const wakeTimeoutMs = Number(process.env.OPENCLAW_WAKE_TIMEOUT_MS || 120_000);

  if (!gatewayToken) {
    console.log(`[notify] No OPENCLAW_GATEWAY_TOKEN — skipping agent wake for ${agentId}`);
    return false;
  }

  const sessionKey = buildTaskSessionKey(agentId, taskId);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), wakeTimeoutMs);

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
      console.error(`[notify] ${agentId} wake timed out after ${wakeTimeoutMs}ms`);
      return false;
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

  const body = await request.json();
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const agent = typeof body.agent === "string" ? body.agent : "";
  const title = typeof body.title === "string" ? body.title : "";
  const action = typeof body.action === "string" ? body.action : "";

  if (!isRoutedAgent(agent)) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  const routing = AGENT_ROUTING[agent];

  // Fetch full task details for the wake message
  let instruction = "";
  let taskModel = "";
  if (taskId) {
    const adminDb = createServiceClient();
    const { data: task } = await adminDb
      .from("agent_tasks")
      .select("instruction, model")
      .eq("id", taskId)
      .single();
    if (task?.instruction) instruction = task.instruction;
    if (task?.model) taskModel = task.model;
  }

  // Build notification message with full context
  const actionLabels: Record<string, string> = {
    created: "📋 New task assigned to you",
    unblocked: "🔓 Task unblocked and ready",
    approved: "✅ Task approved by Gonza",
    promoted: "📅 Scheduled task now ready",
    completed: "✅ Task you requested was completed",
    failed: "❌ Task you requested has failed",
  };
  const label = actionLabels[action] || "📋 Task update";
  const isCompletion = action === "completed" || action === "failed";

  let message = `${label}: "${title}" (task ID: ${taskId})\n`;
  if (isCompletion) {
    // For completion notifications, include result/error from the task
    const adminDb = createServiceClient();
    const { data: fullTask } = await adminDb
      .from("agent_tasks")
      .select("result, error, agent")
      .eq("id", taskId)
      .single();
    if (fullTask?.result) message += `\n**Result:** ${fullTask.result}\n`;
    if (fullTask?.error) message += `\n**Error:** ${fullTask.error}\n`;
    if (fullTask?.agent) message += `\n_Completed by: ${fullTask.agent}_\n`;
  } else if (instruction) {
    message += `\n## Instructions\n${instruction}\n`;
  }

  message += `\n## Execution context
This wake is running in a detached Mission Control task session, not a user chat thread. Do not assume you can reply in-context to a human. If you need to send an external message, use the appropriate tool explicitly.\n`;

  if (!isCompletion) {
  // Add model routing info for code tasks
  if (taskModel) {
    const fullModel = taskModel === "opus" ? "anthropic/claude-opus-4-6" : "anthropic/claude-sonnet-4-20250514";
    message += `\n**Model:** ${taskModel} (${fullModel})`;
    message += `\nIf this is a code task (file edits, builds), consider spawning a code worker via sessions_spawn with runtime "acp" and model "${fullModel}". See the mission-control skill for details.\n`;
  }

  const claimCommand = buildTaskStatusCommand(taskId, { status: "in_progress" });
  const doneCommand = buildTaskStatusCommand(taskId, { status: "done", result: "Brief summary of what was done" });
  const failCommand = buildTaskStatusCommand(taskId, { status: "failed", error: "What went wrong" });

  message += `\n## REQUIRED: Update task status via Mission Control API
These commands load the Mission Control repo env before calling the API.

**Before you start working**, claim the task:
\`\`\`bash
${claimCommand}
\`\`\`

**When finished**, mark it done with a result summary:
\`\`\`bash
${doneCommand}
\`\`\`

If you fail, mark it failed:
\`\`\`bash
${failCommand}
\`\`\``;
  }

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
  const woke = await wakeAgent(routing.agentId, taskId, message);

  // 3. Log activity
  logActivity(agent, "agent_woke", title, `Action: ${action}`, taskId);

  if (!woke) {
    return NextResponse.json({ ok: false, agent, woke, taskId }, { status: 503 });
  }

  return NextResponse.json({ ok: true, agent, woke, taskId });
}
