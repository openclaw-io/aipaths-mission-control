import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { AGENT_ROUTING, isRoutedAgent } from "@/lib/agent-routing";

export const dynamic = "force-dynamic";

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

type ClarificationQuestion = {
  id?: string;
  question?: string | null;
  status?: string | null;
  answer?: string | null;
};

type ClarificationHistoryEntry = {
  response?: string | null;
  responded_at?: string | null;
  responded_by?: string | null;
};

type ProjectContextRow = {
  id: string;
  name: string | null;
  summary: string | null;
  description: string | null;
  clarification_questions: ClarificationQuestion[] | null;
  metadata: {
    clarification_history?: ClarificationHistoryEntry[] | null;
  } | null;
  approval_scope: {
    notes?: string | null;
  } | null;
};

function buildProjectContext(project: ProjectContextRow) {
  const parts: string[] = [];

  if (project.name) parts.push(`Project: ${project.name}`);

  const summary = project.summary || project.description;
  if (summary) parts.push(`Summary: ${summary}`);

  const clarificationHistory = Array.isArray(project.metadata?.clarification_history)
    ? project.metadata?.clarification_history || []
    : [];

  const responses = clarificationHistory
    .map((entry) => (typeof entry?.response === "string" ? entry.response.trim() : ""))
    .filter(Boolean);

  if (responses.length) {
    parts.push(`Latest clarification from requester:\n${responses.map((response) => `- ${response}`).join("\n")}`);
  }

  if (project.approval_scope?.notes) {
    parts.push(`Approval notes: ${project.approval_scope.notes}`);
  }

  return parts.join("\n\n");
}

function buildWorkItemSessionKey(agentId: string, workItemId: string) {
  return `agent:${agentId}:mission-control:work-item:${workItemId}`;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildWorkItemStatusCommand(workItemId: string, status: "in_progress" | "done" | "failed") {
  const envLocal = `${process.cwd()}/.env.local`;
  const envFile = `${process.cwd()}/.env`;
  const url = `http://localhost:3001/api/agent/work-items/${workItemId}`;
  const payload = JSON.stringify({ status });
  const script = `set -a; [ -f "${envLocal}" ] && . "${envLocal}"; [ -f "${envFile}" ] && . "${envFile}"; set +a; curl -s -X PATCH -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" "${url}" -d '${payload}'`;
  return `bash -lc ${shellSingleQuote(script)}`;
}

async function wakeAgent(agentId: string, workItemId: string, message: string): Promise<boolean> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const wakeTimeoutMs = Number(process.env.OPENCLAW_WAKE_TIMEOUT_MS || 120_000);

  if (!gatewayToken) {
    console.log(`[notify-work-item] No OPENCLAW_GATEWAY_TOKEN — skipping agent wake for ${agentId}`);
    return false;
  }

  const sessionKey = buildWorkItemSessionKey(agentId, workItemId);

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
    console.log(`[notify-work-item] ${agentId} wake: HTTP ${res.status}`);
    return res.ok;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[notify-work-item] ${agentId} wake timed out after ${wakeTimeoutMs}ms`);
      return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify-work-item] ${agentId} wake failed:`, message);
    return false;
  }
}

export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const isInternalCall = !!bearerToken && bearerToken === process.env.AGENT_API_KEY;

  if (!isInternalCall) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workItemId, agent, action } = await request.json();

  if (!isRoutedAgent(agent)) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  const routing = AGENT_ROUTING[agent];
  const db = createServiceClient();
  const { data: item, error } = await db
    .from("work_items")
    .select("id, title, instruction, status, priority, owner_agent, requested_by, scheduled_for, source_type, source_id, payload")
    .eq("id", workItemId)
    .single();

  if (error || !item) {
    return NextResponse.json({ error: error?.message || "work_item not found" }, { status: 404 });
  }

  const actionLabels: Record<string, string> = {
    created: "📋 New work item assigned to you",
    unblocked: "🔓 Work item unblocked and ready",
    approved: "✅ Work item approved",
    completed: "✅ Work item completed",
    failed: "❌ Work item failed",
  };

  let projectContext = "";
  if (item.source_type === "project" && typeof item.source_id === "string") {
    const { data: project } = await db
      .from("projects")
      .select("id,name,summary,description,clarification_questions,metadata,approval_scope")
      .eq("id", item.source_id)
      .maybeSingle();

    if (project) {
      projectContext = buildProjectContext(project as ProjectContextRow);
    }
  }

  const label = actionLabels[action] || "📋 Work item update";
  let message = `${label}: \"${item.title}\" (work item ID: ${item.id})\n`;

  if (item.instruction) message += `\n## Instructions\n${item.instruction}\n`;
  if (projectContext) message += `\n## Latest project context\n${projectContext}\n`;
  if (item.scheduled_for) message += `\nScheduled for: ${item.scheduled_for}\n`;
  if (item.source_type) message += `\nSource: ${item.source_type}\n`;

  message += `\n## Execution context\nThis wake is running in a detached Mission Control work-item session, not a user chat thread. Do not assume you can reply in-context to a human. If you need to send an external message, use the appropriate tool explicitly.\n`;

  const claimCommand = buildWorkItemStatusCommand(item.id, "in_progress");
  const completeCommand = buildWorkItemStatusCommand(item.id, "done");
  const failCommand = buildWorkItemStatusCommand(item.id, "failed");

  message += `\n## REQUIRED: Update work item status via Mission Control API
These commands load the Mission Control repo env before calling the API.

Claim it:
\`\`\`bash
${claimCommand}
\`\`\`

Complete it:
\`\`\`bash
${completeCommand}
\`\`\`

Fail it:
\`\`\`bash
${failCommand}
\`\`\``;

  let woke = await wakeAgent(routing.agentId, item.id, message);
  if (!woke) {
    const { data: latestItem } = await db
      .from("work_items")
      .select("status")
      .eq("id", item.id)
      .maybeSingle();

    // A long-running agent can successfully claim the work item before the
    // gateway request returns. Treat that as a successful wake so the scheduler
    // does not retry and create duplicate detached sessions.
    if (latestItem?.status === "in_progress" || latestItem?.status === "done") {
      console.log(`[notify-work-item] ${agent} wake timed out, but work item is ${latestItem.status}; treating as success`);
      woke = true;
    }
  }

  if (!woke) {
    return NextResponse.json({ ok: false, agent, woke, workItemId: item.id }, { status: 503 });
  }

  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `📤 Mission Control → @${agent}: \"${item.title}\" (${action}, work_item)`,
        }),
      });
    } catch (err) {
      console.error("[notify-work-item] Discord webhook failed:", err);
    }
  }

  return NextResponse.json({ ok: true, agent, woke, workItemId: item.id });
}
