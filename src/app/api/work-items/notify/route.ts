import { spawn } from "node:child_process";
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

async function checkModelHealth(agentId = "systems") {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!gatewayToken) return { ok: false, agentId, reason: "missing_OPENCLAW_GATEWAY_TOKEN" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENCLAW_MODEL_HEALTH_TIMEOUT_MS || 60000));
  try {
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": agentId,
        "x-openclaw-session-key": `agent:${agentId}:mission-control:model-health:${Date.now()}`,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: "Mission Control model health check. Reply OK only." }],
        stream: false,
      }),
    });
    const text = await res.text().catch(() => "");
    let body: { choices?: Array<{ message?: { content?: unknown } }> } | null = null;
    try { body = text ? JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> } : null; } catch { body = null; }
    const content = body?.choices?.[0]?.message?.content;
    const normalized = typeof content === "string" ? content.trim().toLowerCase() : "";
    const looksHealthy = res.ok && normalized === "ok";
    return looksHealthy
      ? { ok: true, agentId, status: res.status }
      : {
          ok: false,
          agentId,
          status: res.status,
          reason: res.ok
            ? `unexpected_health_response: ${content ? String(content).slice(0, 300) : text.slice(0, 300)}`
            : text.slice(0, 500) || `HTTP ${res.status}`,
        };
  } catch (err) {
    return { ok: false, agentId, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function wakeAgent(agentId: string, workItemId: string, message: string): Promise<boolean> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!gatewayToken) {
    console.log(`[notify-work-item] No OPENCLAW_GATEWAY_TOKEN — skipping agent wake for ${agentId}`);
    return false;
  }

  const sessionKey = buildWorkItemSessionKey(agentId, workItemId);
  const payload = {
    gatewayUrl,
    gatewayToken,
    agentId,
    sessionKey,
    message,
    workItemId,
    missionControlApi: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001",
    agentApiKey: process.env.AGENT_API_KEY || "",
  };

  const script = String.raw`
const fs = require("node:fs");
const payload = JSON.parse(process.env.OPENCLAW_WAKE_PAYLOAD || "{}");
const logPath = process.env.OPENCLAW_WAKE_LOG || "/tmp/openclaw-work-item-wake.log";
const log = (line) => fs.appendFileSync(logPath, new Date().toISOString() + " " + line + "\n");
async function restoreReady(reason) {
  if (!payload.agentApiKey || !payload.missionControlApi || !payload.workItemId) return;
  try {
    const retryDelayMs = Number(process.env.OPENCLAW_WAKE_RETRY_DELAY_MS || 5 * 60 * 1000);
    await fetch(payload.missionControlApi + "/api/agent/work-items/" + payload.workItemId, {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer " + payload.agentApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "ready",
        scheduled_for: new Date(Date.now() + retryDelayMs).toISOString(),
        payload_patch: {
          dispatch_state: "ready_after_wake_failure",
          dispatch_failure_reason: reason,
          dispatch_last_failed_at: new Date().toISOString(),
          dispatch_retry_scheduled_for: new Date(Date.now() + retryDelayMs).toISOString(),
          schedule_kind: "dispatch_retry",
        },
        payload_increment: { wake_failure_count: 1 },
      }),
    });
  } catch (err) {
    log("[notify-work-item] failed to restore ready for " + payload.workItemId + ": " + (err && err.message ? err.message : String(err)));
  }
}
(async () => {
  try {
    const res = await fetch(payload.gatewayUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + payload.gatewayToken,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": payload.agentId,
        "x-openclaw-session-key": payload.sessionKey,
      },
      body: JSON.stringify({
        model: "openclaw:" + payload.agentId,
        messages: [{ role: "user", content: payload.message }],
        stream: false,
      }),
    });
    const text = await res.text().catch(() => "");
    log("[notify-work-item] " + payload.agentId + " " + payload.workItemId + " HTTP " + res.status + " " + text.slice(0, 500));
    if (!res.ok) {
      await restoreReady("wake_http_" + res.status + ": " + text.slice(0, 300));
    }
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    log("[notify-work-item] " + payload.agentId + " " + payload.workItemId + " failed: " + reason);
    await restoreReady("wake_fetch_failed: " + reason);
    process.exit(1);
  }
})();
`;

  try {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OPENCLAW_WAKE_PAYLOAD: JSON.stringify(payload),
        OPENCLAW_WAKE_LOG: process.env.OPENCLAW_WAKE_LOG || "/tmp/openclaw-work-item-wake.log",
      },
    });
    child.unref();
    console.log(`[notify-work-item] spawned detached wake pid ${child.pid} for ${agentId} ${workItemId}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify-work-item] failed to spawn detached wake for ${agentId}:`, message);
    return false;
  }
}

export async function GET(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const isInternalCall = !!bearerToken && bearerToken === process.env.AGENT_API_KEY;

  if (!isInternalCall) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const agentId = request.nextUrl.searchParams.get("agent") || "systems";
  if (!isRoutedAgent(agentId)) {
    return NextResponse.json({ ok: false, error: `Unknown agent: ${agentId}` }, { status: 400 });
  }

  const health = await checkModelHealth(agentId);
  return NextResponse.json(health, { status: health.ok ? 200 : 503 });
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

  const workPayload = (item.payload || {}) as Record<string, unknown>;
  const isCommunityPost = workPayload.pipeline_type === "community_post";
  const actionName = typeof workPayload.action === "string" ? workPayload.action : "";
  const isCommunityDraft = isCommunityPost && [
    "draft_community_news",
    "draft_community_tool",
    "draft_community_startup",
    "develop_community_post",
    "draft_guide_announcement",
    "revise_community_announcement",
  ].includes(actionName);
  const isCommunitySchedule = isCommunityPost && actionName === "schedule_community_post";
  const isCommunityPublish = isCommunityPost && (actionName === "publish_community_post" || workPayload.relation_type === "publish");
  const completionLogChannelId = typeof workPayload.log_channel_id === "string" ? workPayload.log_channel_id : "1473660854800224316";

  message += `\n## Execution context\nThis wake is running in a detached Mission Control work-item session, not a user chat thread. Do not assume you can reply in-context to a human. If you need to send an external message, use the appropriate tool explicitly.\n`;

  message += `\n## Completion routing contract\nWhen the work is done, do not put the user-facing completion/update in your final assistant reply, because detached work-item final replies route to the owning director channel. If you need to notify Gonza or leave a visible completion log, send it explicitly via the Discord message tool to <#${completionLogChannelId}>. After sending that external update and marking the work item done, make your final assistant reply exactly: NO_REPLY.\n`;

  if (isCommunityDraft) {
    message += `\n## Community draft contract\nWrite the final community/news copy into the Mission Control pipeline card. Do not DM Gonza with the draft and do not publish it. Complete this work item only after PATCHing the final copy as output.copy.text or as a clearly labeled final copy in result; Mission Control will move the card to ready_for_review.\n`;
  }
  if (workPayload.relation_type === "distribute_community" && (workPayload.pipeline_type === "blog" || workPayload.pipeline_type === "doc" || workPayload.pipeline_type === "guide")) {
    message += `\n## Content launch community draft contract\nThis is a content-launch announcement request, not a publishing request. Create or update a Community pipeline item containing the final Spanish Discord announcement copy and leave it in ready_for_review for Gonza approval. Do NOT publish to Discord. Do NOT schedule publication. Complete this work item only after the draft exists in Mission Control and is waiting for review.\n`;
  }
  if (isCommunitySchedule) {
    message += `\n## Community schedule contract\nChoose the publish date/time for this approved community post. Do not publish now. Complete this work item with scheduled_for (ISO timestamp); Mission Control will create/update the future publish work item in Work Queue, and the Work Queue scheduler will dispatch it when due.\n`;
  }
  if (isCommunityPublish) {
    const targetChannelId = typeof workPayload.target_channel_id === "string" ? workPayload.target_channel_id : "1498256983122378883";
    const targetChannelName = typeof workPayload.target_channel_name === "string" ? workPayload.target_channel_name : "🛰️_radar_ia";
    const logChannelId = completionLogChannelId;
    message += `\n## Community publish contract\nPublish only the approved copy in <#${targetChannelId}> (${targetChannelName}). Do not publish news/radar items in #anuncios; #anuncios is only for blogs, guides, videos, and major content launches. Wrap every raw URL as <https://...> so Discord suppresses link previews/embeds. After publishing, complete this work item with current_url/published_at if available. Send the publication log/update to <#${logChannelId}>, not to your private director channel. Suggested log: “Anuncio: [title] — lo publiqué en #${targetChannelName}. Post: [ver post](<POST_URL>)”.\n`;
  }

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

  return NextResponse.json({ ok: true, agent, woke, workItemId: item.id, wakeMode: "detached_spawn" });
}
