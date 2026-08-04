import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { AGENT_ROUTING, isRoutedAgent } from "@/lib/agent-routing";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { query, withTransaction } from "@/lib/db/postgres";
import { buildLoopWakeContext } from "@/lib/loops/execution-instruction";
import {
  genericNotifyIdentityMatches,
  isVisualQaLikeWorkItem,
  parseGenericNotifyClassificationIdentity,
} from "@/lib/work-items/generic-notify-contract";
import { serializeWorkItemStatusPayload } from "@/lib/work-items/status-payload";

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

type LoopContextRow = {
  id: string;
  name: string | null;
  summary: string | null;
  description: string | null;
  acceptance_criteria: string[] | null;
  clarification_questions: ClarificationQuestion[] | null;
  metadata: {
    original_input?: string | null;
    clarification_history?: ClarificationHistoryEntry[] | null;
  } | null;
  approval_scope: {
    allowed_actions?: string[] | null;
    forbidden_actions?: string[] | null;
    notes?: string | null;
  } | null;
};

type WorkItemRow = {
  id: string;
  loop_id: string | null;
  title: string;
  instruction: string | null;
  status: string;
  updated_at: string | Date;
  priority: string | null;
  owner_agent: string | null;
  target_agent_id: string | null;
  requested_by: string | null;
  scheduled_for: string | Date | null;
  source_type: string | null;
  source_id: string | null;
  payload: Record<string, unknown> | null;
};

function buildLoopContext(loop: LoopContextRow) {
  const parts: string[] = [];

  if (loop.name) parts.push(`Loop: ${loop.name}`);

  const summary = loop.summary || loop.description;
  if (summary) parts.push(`Summary: ${summary}`);
  parts.push(buildLoopWakeContext(loop));

  return parts.join("\n\n");
}

function buildWorkItemSessionKey(agentId: string, workItemId: string, payload?: Record<string, unknown> | null) {
  const dispatchSessionKey = typeof payload?.dispatch_session_key === "string" ? payload.dispatch_session_key : "";
  if (dispatchSessionKey) return dispatchSessionKey;

  const dispatchSessionId = typeof payload?.dispatch_session_id === "string" ? payload.dispatch_session_id : "";
  if (dispatchSessionId) {
    return `agent:${agentId}:mission-control:work-item:${workItemId}:dispatch:${dispatchSessionId}`;
  }

  const executionAttemptId = typeof payload?.execution_attempt_id === "string" ? payload.execution_attempt_id : "";
  if (executionAttemptId) {
    return `agent:${agentId}:mission-control:work-item:${workItemId}:execution:${executionAttemptId}`;
  }

  const dispatchAttempt = Number(payload?.dispatch_attempts || 0);
  const staleRequeues = Number(payload?.stale_claim_requeue_count || 0);
  const manualRequeues = Number(payload?.manual_requeue_count || 0);
  const attemptSuffix = dispatchAttempt > 0 || staleRequeues > 0 || manualRequeues > 0
    ? `:attempt:${dispatchAttempt}:stale:${staleRequeues}:manual:${manualRequeues}`
    : "";
  return `agent:${agentId}:mission-control:work-item:${workItemId}${attemptSuffix}`;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildWorkItemStatusCommand(
  workItemId: string,
  status: "in_progress" | "done" | "failed",
  workPayload?: Record<string, unknown> | null,
) {
  const envLocal = `${process.cwd()}/.env.local`;
  const envFile = `${process.cwd()}/.env`;
  const url = `http://localhost:3001/api/agent/work-items/${workItemId}`;
  const payload = serializeWorkItemStatusPayload(status, workPayload);
  const authEnvironmentReference = String.fromCharCode(36) + "{AGENT_" + "API_KEY}";
  const script = `set -a; [ -f "${envLocal}" ] && . "${envLocal}"; [ -f "${envFile}" ] && . "${envFile}"; set +a; curl -s -X PATCH -H "Authorization: Bearer ${authEnvironmentReference}" -H "Content-Type: application/json" "${url}" -d '${payload}'`;
  return `bash -lc ${shellSingleQuote(script)}`;
}

type WakeAgentResult = {
  ok: boolean;
  mode: "hermes_cli_spawn" | "hermes_cli_health";
  sessionKey?: string | null;
  error?: string | null;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number | null;
};

function baseCommandEnv(extra?: Record<string, string>) {
  return {
    ...process.env,
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/Users/joaco/.local/bin", "/usr/bin", "/bin", process.env.PATH || ""].filter(Boolean).join(":"),
    HOME: process.env.HOME || "/Users/joaco",
    HERMES_ACCEPT_HOOKS: process.env.HERMES_ACCEPT_HOOKS || "1",
    PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || "1",
    ...(extra || {}),
  };
}

function runCommand(bin: string, args: string[], timeoutMs: number, timeoutLabel: string, extraEnv?: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: baseCommandEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, stdout, stderr, error: `${timeoutLabel}_timeout_after_${timeoutMs}ms`, exitCode: null });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      finish({ ok: false, stdout, stderr, error: err.message, exitCode: null });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `${timeoutLabel}_exit_${code}`, exitCode: code });
    });
  });
}

function hermesBin() {
  return process.env.HERMES_BIN || "/Users/joaco/.hermes/hermes-agent/venv/bin/hermes";
}

async function checkHermesHealth(agentId = "systems") {
  const timeoutMs = Number(process.env.HERMES_MODEL_HEALTH_TIMEOUT_MS || 60000);
  const result = await runCommand(hermesBin(), [
    "--profile", agentId,
    "chat",
    "-q", "Mission Control model health check. Reply OK only.",
    "-Q",
    "--source", "mission-control-health",
    "--max-turns", "1",
  ], timeoutMs, "hermes_health");

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const looksHealthy = result.ok && /(^|\n)OK(\n|$)/.test(result.stdout.trim());
  return looksHealthy
    ? { ok: true, agentId, mode: "hermes_cli_health", status: 200 }
    : {
        ok: false,
        agentId,
        mode: "hermes_cli_health",
        status: result.exitCode ?? null,
        reason: result.error || combined.slice(0, 500) || "hermes_health_failed",
      };
}

async function wakeAgentViaHermesCli(agentId: string, workItemId: string, message: string, workPayload?: Record<string, unknown> | null): Promise<WakeAgentResult> {
  const sessionKey = buildWorkItemSessionKey(agentId, workItemId, workPayload);
  const maxTurns = process.env.HERMES_WORK_ITEM_MAX_TURNS || "90";
  const args = [
    "--profile", agentId,
    "chat",
    "-q", message,
    "-Q",
    "--source", "mission-control-work-item",
    "--max-turns", maxTurns,
    "--pass-session-id",
    "--yolo",
  ];

  try {
    const child = spawn(hermesBin(), args, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: baseCommandEnv({
        HERMES_MISSION_CONTROL_WORK_ITEM_ID: workItemId,
        HERMES_MISSION_CONTROL_AGENT_ID: agentId,
        HERMES_MISSION_CONTROL_SESSION_KEY: sessionKey,
      }),
    });
    child.unref();
    console.log(`[notify-work-item] spawned Hermes CLI wake pid ${child.pid} for ${agentId} ${workItemId}`);
    return { ok: true, mode: "hermes_cli_spawn", sessionKey };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[notify-work-item] failed to spawn Hermes CLI wake for ${agentId}:`, error);
    return { ok: false, mode: "hermes_cli_spawn", sessionKey, error };
  }
}

async function wakeAgent(agentId: string, workItemId: string, message: string, workPayload?: Record<string, unknown> | null): Promise<WakeAgentResult> {
  return wakeAgentViaHermesCli(agentId, workItemId, message, workPayload);
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

  const health = await checkHermesHealth(agentId);
  return NextResponse.json(health, { status: health.ok ? 200 : 503 });
}

export async function POST(request: NextRequest) {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "");
  const isInternalCall = !!bearerToken && bearerToken === process.env.AGENT_API_KEY;

  if (!isInternalCall) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workItemId, agent, action, caller, expectedClassificationIdentity } = await request.json();
  const isGenericSchedulerCall = caller === "generic_scheduler_v1";
  const schedulerClassificationIdentity = isGenericSchedulerCall
    ? parseGenericNotifyClassificationIdentity(expectedClassificationIdentity)
    : null;
  if (isGenericSchedulerCall && !schedulerClassificationIdentity) {
    return NextResponse.json({ error: "generic_notify_classification_identity_required" }, { status: 400 });
  }

  if (!isRoutedAgent(agent)) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  const routing = AGENT_ROUTING[agent];
  const useLocalMode = isLocalAuthDisabled();
  const db = useLocalMode ? null : createServiceClient();
  let item: WorkItemRow | null = null;

  if (useLocalMode) {
    const { rows } = await query(
      `select id, loop_id, title, instruction, status, priority, owner_agent, target_agent_id, requested_by,
              scheduled_for, source_type, source_id, payload, updated_at
         from public.work_items
        where id = $1
        limit 1`,
      [workItemId],
    );
    item = (rows[0] as WorkItemRow | undefined) || null;
  } else {
    const { data, error } = await (db as ReturnType<typeof createServiceClient>)
      .from("work_items")
      .select("id, loop_id, title, instruction, status, priority, owner_agent, target_agent_id, requested_by, scheduled_for, source_type, source_id, payload, updated_at")
      .eq("id", workItemId)
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    item = data as WorkItemRow | null;
  }

  if (!item) {
    return NextResponse.json({ error: "work_item not found" }, { status: 404 });
  }
  if (isVisualQaLikeWorkItem(item)) {
    return NextResponse.json({ error: "visual_qa_v1 requires dedicated QA claim" }, { status: 409 });
  }
  if (item.payload?.runtime_contract === "fresh_review_v1" && item.payload?.run_role === "review") {
    return NextResponse.json({ error: "fresh_review_v1 requires dedicated reviewer dispatch" }, { status: 409 });
  }
  if (agent !== item.owner_agent && agent !== item.target_agent_id) {
    return NextResponse.json({ error: "notify_agent_identity_mismatch" }, { status: 409 });
  }

  // fresh_review_v1 session identity is server-owned. The detached agent never
  // supplies or chooses it; retries of the same immutable work item retain it.
  let workPayload = { ...(item.payload || {}) } as Record<string, unknown>;
  if (useLocalMode && workPayload.runtime_contract === "fresh_review_v1"
      && typeof workPayload.dispatch_session_id !== "string") {
    const dispatchSessionId = randomUUID();
    const assigned = await query<{ payload: Record<string, unknown> }>(
      `update public.work_items
          set payload=jsonb_set(payload,'{dispatch_session_id}',to_jsonb($2::text),true),updated_at=now()
        where id=$1 and status in ('ready','in_progress')
          and payload->>'runtime_contract'='fresh_review_v1'
          and not (payload ? 'dispatch_session_id')
        returning payload`,
      [item.id, dispatchSessionId],
    );
    if (assigned.rows[0]) {
      workPayload = assigned.rows[0].payload;
      item.payload = workPayload;
    } else {
      const refreshed = await query<{ payload: Record<string, unknown> }>(
        "select payload from public.work_items where id=$1 limit 1", [item.id],
      );
      workPayload = refreshed.rows[0]?.payload || workPayload;
      item.payload = workPayload;
    }
  }

  const actionLabels: Record<string, string> = {
    created: "📋 New work item assigned to you",
    unblocked: "🔓 Work item unblocked and ready",
    approved: "✅ Work item approved",
    completed: "✅ Work item completed",
    failed: "❌ Work item failed",
  };

  let loopContext = "";
  const sourceLoopId = item.loop_id;
  if (workPayload.runtime_contract === "fresh_review_v1"
      && (item.source_type !== "loop" || typeof sourceLoopId !== "string"
        || workPayload.source_loop_id !== sourceLoopId)) {
    return NextResponse.json({ error: "source_loop_id_mismatch" }, { status: 409 });
  }
  if (item.source_type === "loop" && typeof sourceLoopId === "string") {
    let loop: LoopContextRow | null = null;
    if (useLocalMode) {
      const { rows } = await query(
        `select id, name, summary, description, acceptance_criteria, clarification_questions, metadata, approval_scope
           from public.loops
          where id = $1
          limit 1`,
        [sourceLoopId],
      );
      loop = (rows[0] as LoopContextRow | undefined) || null;
    } else {
      const { data } = await (db as ReturnType<typeof createServiceClient>)
        .from("loops")
        .select("id,name,summary,description,acceptance_criteria,clarification_questions,metadata,approval_scope")
        .eq("id", sourceLoopId)
        .maybeSingle();
      loop = data as LoopContextRow | null;
    }

    if (loop) {
      loopContext = buildLoopContext(loop);
    }
  }

  const label = actionLabels[action] || "📋 Work item update";
  let message = `${label}: \"${item.title}\" (work item ID: ${item.id})\n`;

  if (item.instruction) message += `\n## Instructions\n${item.instruction}\n`;
  if (loopContext) message += `\n## Latest loop context\n${loopContext}\n`;
  if (item.scheduled_for) message += `\nScheduled for: ${item.scheduled_for}\n`;
  if (item.source_type) message += `\nSource: ${item.source_type}\n`;

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

  const claimCommand = buildWorkItemStatusCommand(item.id, "in_progress", workPayload);
  const completeCommand = buildWorkItemStatusCommand(item.id, "done", workPayload);
  const failCommand = buildWorkItemStatusCommand(item.id, "failed", workPayload);

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

  let wake: WakeAgentResult;
  if (isGenericSchedulerCall) {
    if (!useLocalMode || !schedulerClassificationIdentity) {
      return NextResponse.json({ error: "generic_scheduler_notify_requires_local_atomic_guard" }, { status: 503 });
    }
    const guarded = await withTransaction(async (client) => {
      const currentResult = await client.query<WorkItemRow>(
        `select id,status,updated_at,source_type,source_id,owner_agent,target_agent_id,payload
           from public.work_items
          where id=$1
          for update`,
        [item.id],
      );
      const current = currentResult.rows[0];
      if (!current || !genericNotifyIdentityMatches(schedulerClassificationIdentity, current)) {
        return { error: "generic_notify_classification_identity_changed" as const };
      }
      if (isVisualQaLikeWorkItem(current)) {
        return { error: "generic_notify_visual_qa_rejected" as const };
      }
      if (agent !== current.owner_agent && agent !== current.target_agent_id) {
        return { error: "notify_agent_identity_mismatch" as const };
      }
      const guardedWake = await wakeAgent(routing.agentId, item.id, message, workPayload);
      return { wake: guardedWake };
    });
    if ("error" in guarded) {
      return NextResponse.json({ error: guarded.error }, { status: 409 });
    }
    wake = guarded.wake;
  } else {
    wake = await wakeAgent(routing.agentId, item.id, message, workPayload);
  }
  if (!wake.ok) {
    let latestStatus: string | null = null;
    if (useLocalMode) {
      const { rows } = await query(`select status from public.work_items where id = $1 limit 1`, [item.id]);
      latestStatus = typeof rows[0]?.status === "string" ? rows[0].status : null;
    } else {
      const { data: latestItem } = await (db as ReturnType<typeof createServiceClient>)
        .from("work_items")
        .select("status")
        .eq("id", item.id)
        .maybeSingle();
      latestStatus = latestItem?.status || null;
    }

    // Completion is the only safe success signal after a failed wake. An
    // in_progress claim can also be a stale broken session, so let the scheduler
    // surface it instead of hiding the failure as a successful dispatch.
    if (latestStatus === "done") {
      console.log(`[notify-work-item] ${agent} wake timed out, but work item is ${latestStatus}; treating as success`);
      wake = { ...wake, ok: true };
    }
  }

  if (!wake.ok) {
    return NextResponse.json({ ok: false, agent, woke: false, workItemId: item.id, wakeMode: wake.mode, error: wake.error || null }, { status: 503 });
  }

  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;
  const suppressTaskRouterWebhook = workPayload.suppress_task_router_webhook === true;
  if (webhookUrl && !suppressTaskRouterWebhook) {
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

  return NextResponse.json({
    ok: true,
    agent,
    woke: wake.ok,
    workItemId: item.id,
    wakeMode: wake.mode,
    dispatchCronJobId: null,
    dispatchCronRunId: null,
    dispatchSessionId: typeof workPayload.dispatch_session_id === "string" ? workPayload.dispatch_session_id : null,
    dispatchSessionKey: wake.sessionKey || null,
  });
}
