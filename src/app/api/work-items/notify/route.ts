import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { AGENT_ROUTING, isRoutedAgent } from "@/lib/agent-routing";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { query, withTransaction } from "@/lib/db/postgres";
import { buildLoopWakeContext } from "@/lib/loops/execution-instruction";
import { evaluateYouTubeLaunchActionReadiness } from "@/lib/youtube-launch-state";
import {
  genericNotifyIdentityMatches,
  isVisualQaLikeWorkItem,
  parseGenericNotifyClassificationIdentity,
} from "@/lib/work-items/generic-notify-contract";
import { serializeWorkItemStatusPayload } from "@/lib/work-items/status-payload";
import {
  claimExternalDelivery,
  markExternalDeliveryPreDeliveryFailure,
} from "@/lib/work-items/external-delivery";
import {
  buildScheduledLaunchGateBlockedTransition,
  nextScheduledLaunchRetryTransition,
} from "@/lib/work-items/scheduled-launch-runtime";
import {
  PUBLISH_BLOG_DISPATCHER_CALLER,
  isPublishBlogDispatchCandidate,
} from "@/lib/work-items/publish-blog-dispatcher";

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

type LaunchReadinessItem = Parameters<typeof evaluateYouTubeLaunchActionReadiness>[0]["item"];
type LaunchReadinessWorkItem = Parameters<typeof evaluateYouTubeLaunchActionReadiness>[0]["workItem"];
type LaunchReadinessLocalClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

const GENERIC_NOTIFY_LEASE_VERSION = "generic_notify_lease_v1" as const;
const GENERIC_NOTIFY_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IMPLEMENTATION_UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const IMPLEMENTATION_UUID_PATTERN = new RegExp(`^${IMPLEMENTATION_UUID_SOURCE}$`);
const IMPLEMENTATION_SCHEDULER_SESSION_PATTERN = new RegExp(`^${IMPLEMENTATION_UUID_SOURCE}:attempt-([1-9][0-9]*):${IMPLEMENTATION_UUID_SOURCE}$`);

function isExactPublishBlogDispatcherRequest(input: {
  workItemId: unknown;
  agent: unknown;
  action: unknown;
  idempotencyKey: unknown;
}) {
  if (typeof input.workItemId !== "string"
      || input.agent !== "dev"
      || input.action !== "created"
      || typeof input.idempotencyKey !== "string") return false;
  const prefix = `publish-blog:${input.workItemId}:attempt-`;
  if (!input.idempotencyKey.startsWith(prefix)) return false;
  const attemptText = input.idempotencyKey.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(attemptText)) return false;
  const attempt = Number(attemptText);
  return Number.isSafeInteger(attempt) && attempt > 0;
}

function isTrustedImplementationDispatchSessionId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  if (IMPLEMENTATION_UUID_PATTERN.test(value)) return true;
  const schedulerIdentity = IMPLEMENTATION_SCHEDULER_SESSION_PATTERN.exec(value);
  if (!schedulerIdentity) return false;
  const attempt = Number(schedulerIdentity[1]);
  return Number.isSafeInteger(attempt) && attempt > 0;
}

type GenericNotifyLease = {
  version: typeof GENERIC_NOTIFY_LEASE_VERSION;
  key: string;
  outcome: "leased" | "accepted" | "failed";
  leased_at: string;
  expires_at: string;
  outcome_at: string | null;
  mode: WakeAgentResult["mode"] | null;
  session_key: string | null;
  error: string | null;
};

function genericNotifyLeaseMs() {
  const configured = Number(process.env.GENERIC_NOTIFY_LEASE_MS || 60000);
  return Number.isSafeInteger(configured) && configured >= 1000 && configured <= 3600000
    ? configured
    : 60000;
}

function parseGenericNotifyLease(payload: Record<string, unknown> | null): GenericNotifyLease | null | "invalid" {
  const value = payload?.generic_notify_lease;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const lease = value as Record<string, unknown>;
  const outcome = String(lease.outcome);
  const outcomeAtValid = lease.outcome_at === null
    || (typeof lease.outcome_at === "string" && Number.isFinite(Date.parse(lease.outcome_at)));
  const modeValid = lease.mode === null || lease.mode === "hermes_cli_spawn" || lease.mode === "hermes_cli_health";
  const sessionKeyValid = lease.session_key === null
    || (typeof lease.session_key === "string" && lease.session_key.length <= 512);
  const errorValid = lease.error === null || (typeof lease.error === "string" && lease.error.length <= 500);
  if (lease.version !== GENERIC_NOTIFY_LEASE_VERSION
      || typeof lease.key !== "string" || !GENERIC_NOTIFY_IDEMPOTENCY_KEY.test(lease.key)
      || !["leased", "accepted", "failed"].includes(outcome)
      || typeof lease.leased_at !== "string" || !Number.isFinite(Date.parse(lease.leased_at))
      || typeof lease.expires_at !== "string" || !Number.isFinite(Date.parse(lease.expires_at))
      || !outcomeAtValid || !modeValid || !sessionKeyValid || !errorValid
      || (outcome === "leased" && (lease.outcome_at !== null || lease.mode !== null || lease.error !== null))
      || (outcome === "accepted" && (lease.outcome_at === null || lease.mode === null || lease.error !== null))
      || (outcome === "failed" && (lease.outcome_at === null || lease.mode === null || typeof lease.error !== "string"))) {
    return "invalid";
  }
  return lease as GenericNotifyLease;
}

function genericNotifyReplayBody(item: WorkItemRow, agent: string, lease: GenericNotifyLease) {
  const accepted = lease.outcome === "accepted";
  const pending = lease.outcome === "leased";
  return {
    ok: accepted,
    accepted,
    pending,
    agent,
    woke: lease.outcome === "accepted",
    workItemId: item.id,
    wakeMode: lease.mode,
    dispatchCronJobId: null,
    dispatchCronRunId: null,
    dispatchSessionId: typeof item.payload?.dispatch_session_id === "string" ? item.payload.dispatch_session_id : null,
    dispatchSessionKey: lease.session_key,
    idempotent: true,
    outcome: lease.outcome,
    error: lease.error,
  };
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function externalDeliveryKey(payload: Record<string, unknown>) {
  return textValue(payload.external_delivery_idempotency_key);
}

function externalDeliveryScope(payload: Record<string, unknown>) {
  return recordValue(payload.idempotency_scope);
}

function externalDeliveryInstruction(payload: Record<string, unknown>) {
  const key = externalDeliveryKey(payload);
  const claim = recordValue(payload.external_delivery_claim);
  const token = textValue(claim.claim_token);
  if (!key || !token) return "";
  return `\n## REQUIRED: Durable external-delivery contract\nMission Control atomically claimed external delivery key ${key} with claim token ${token}. This key and token are server-owned and immutable. Issue the Community publish or Email provider request at most once, pass ${key} as the provider idempotency key when supported, and never retry an ambiguous/provider-pending request. Before completing, report output.external_delivery = { status: \"accepted\", accepted_at, provider_delivery_id } only after provider acceptance; report { status: \"not_attempted\", failure_class, error } only when no provider request was issued; otherwise report { status: \"ambiguous\", error }.\n`;
}

function externalDeliveryReplayBody(item: WorkItemRow, agent: string, claim: Awaited<ReturnType<typeof claimExternalDelivery>>) {
  const accepted = claim.kind === "accepted_replay";
  return {
    ok: accepted,
    accepted,
    pending: !accepted,
    agent,
    woke: false,
    workItemId: item.id,
    idempotent: true,
    externalDeliveryKey: claim.key,
    externalDeliveryOutcome: claim.status,
    providerDeliveryId: claim.providerDeliveryId,
  };
}

function needsScheduledLaunchReadiness(payload: Record<string, unknown>) {
  return payload.launch_state_contract === "scheduled_launch_v2"
    && (payload.requires_preflight_passed === true || payload.requires_live_check_passed === true);
}

async function checkScheduledLaunchReadiness(input: {
  useLocalMode: boolean;
  db: ReturnType<typeof createServiceClient> | null;
  localClient?: LaunchReadinessLocalClient;
  item: WorkItemRow;
  payload: Record<string, unknown>;
}) {
  if (!needsScheduledLaunchReadiness(input.payload)) return null;
  const pipelineItemId = textValue(input.payload.source_video_pipeline_item_id)
    || textValue(input.payload.pipeline_item_id)
    || (["pipeline_item", "service"].includes(String(input.item.source_type || "")) ? textValue(input.item.source_id) : null);
  if (!pipelineItemId) {
    return { ok: false, failures: ["missing_launch_pipeline_item_id"], remediation: "Recreate or repair the scheduled launch work item payload before dispatch." };
  }

  let pipelineItem: Record<string, unknown> | null = null;
  if (input.useLocalMode) {
    const localQuery = input.localClient?.query.bind(input.localClient) || query;
    const { rows } = await localQuery<Record<string, unknown>>(
      `select id,title,status,scheduled_for,published_at,current_url,metadata
         from public.pipeline_items
        where id=$1
        limit 1`,
      [pipelineItemId],
    );
    pipelineItem = rows[0] || null;
  } else {
    const { data, error } = await (input.db as ReturnType<typeof createServiceClient>)
      .from("pipeline_items")
      .select("id,title,status,scheduled_for,published_at,current_url,metadata")
      .eq("id", pipelineItemId)
      .maybeSingle();
    if (error) {
      return { ok: false, failures: ["launch_pipeline_item_read_failed"], remediation: error.message };
    }
    pipelineItem = data as Record<string, unknown> | null;
  }

  if (!pipelineItem) {
    return { ok: false, failures: ["launch_pipeline_item_not_found"], remediation: "Recreate or repair the scheduled launch parent before dispatch." };
  }

  return evaluateYouTubeLaunchActionReadiness({
    item: pipelineItem as LaunchReadinessItem,
    workItem: { ...input.item, payload: input.payload } as LaunchReadinessWorkItem,
  });
}

function buildLoopContext(loop: LoopContextRow) {
  const parts: string[] = [];

  if (loop.name) parts.push(`Loop: ${loop.name}`);

  const summary = loop.summary || loop.description;
  if (summary) parts.push(`Summary: ${summary}`);
  parts.push(buildLoopWakeContext(loop));

  return parts.join("\n\n");
}

function buildWorkItemSessionKey(agentId: string, workItemId: string, payload?: Record<string, unknown> | null) {
  const genericNotifyLease = parseGenericNotifyLease(payload || null);
  if (genericNotifyLease && genericNotifyLease !== "invalid") {
    return `agent:${agentId}:mission-control:work-item:${workItemId}:notify:${genericNotifyLease.key}`;
  }

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
  const authEnvironmentReference = String.fromCharCode(36) + "{AGENT_" + "API_KEY}";
  if (status === "done" && workPayload?.action === "prepare_blog_final_package") {
    const completionFileReference = String.fromCharCode(36) + "{SPANISH_FINAL_PACKAGE_COMPLETION_JSON:?Set SPANISH_FINAL_PACKAGE_COMPLETION_JSON}";
    const script = `set -a; [ -f "${envLocal}" ] && . "${envLocal}"; [ -f "${envFile}" ] && . "${envFile}"; set +a; curl -s -X PATCH -H "Authorization: Bearer ${authEnvironmentReference}" -H "Content-Type: application/json" "${url}" --data-binary @"${completionFileReference}"`;
    return `SPANISH_FINAL_PACKAGE_COMPLETION_JSON=/private/tmp/spanish-final-package-${workItemId}.json bash -lc ${shellSingleQuote(script)}`;
  }
  const payload = serializeWorkItemStatusPayload(status, workPayload);
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

  return new Promise((resolve) => {
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

      const onError = (err: Error) => {
        child.removeListener("spawn", onSpawn);
        console.error(`[notify-work-item] failed to spawn Hermes CLI wake for ${agentId}:`, err.message);
        resolve({ ok: false, mode: "hermes_cli_spawn", sessionKey, error: err.message });
      };
      const onSpawn = () => {
        child.removeListener("error", onError);
        // Detached execution is accepted once the OS has spawned it; do not wait
        // for the agent to finish. Keep a late error listener so no ChildProcess
        // error can become an unhandled EventEmitter exception.
        child.on("error", (err) => {
          console.error(`[notify-work-item] Hermes CLI wake pid ${child.pid} later errored for ${agentId}:`, err.message);
        });
        child.unref();
        console.log(`[notify-work-item] spawned Hermes CLI wake pid ${child.pid} for ${agentId} ${workItemId}`);
        resolve({ ok: true, mode: "hermes_cli_spawn", sessionKey });
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[notify-work-item] failed to spawn Hermes CLI wake for ${agentId}:`, error);
      resolve({ ok: false, mode: "hermes_cli_spawn", sessionKey, error });
    }
  });
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

  const { workItemId, agent, action, caller, idempotencyKey, expectedClassificationIdentity } = await request.json();
  const isGenericSchedulerCall = caller === "generic_scheduler_v1";
  const isPublishBlogDispatcherCall = caller === PUBLISH_BLOG_DISPATCHER_CALLER;
  const isLeaseGuardedNotifyCall = isGenericSchedulerCall || isPublishBlogDispatcherCall;
  if (isPublishBlogDispatcherCall && !isExactPublishBlogDispatcherRequest({
    workItemId,
    agent,
    action,
    idempotencyKey,
  })) {
    return NextResponse.json({ error: "publish_blog_dispatcher_request_invalid" }, { status: 400 });
  }
  const schedulerClassificationIdentity = isLeaseGuardedNotifyCall
    ? parseGenericNotifyClassificationIdentity(expectedClassificationIdentity)
    : null;
  if (isLeaseGuardedNotifyCall && !schedulerClassificationIdentity) {
    return NextResponse.json({ error: "generic_notify_classification_identity_required" }, { status: 400 });
  }
  if (isLeaseGuardedNotifyCall
      && (typeof idempotencyKey !== "string" || !GENERIC_NOTIFY_IDEMPOTENCY_KEY.test(idempotencyKey))) {
    return NextResponse.json({ error: "generic_notify_idempotency_key_required" }, { status: 400 });
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
  if (!isLeaseGuardedNotifyCall && isVisualQaLikeWorkItem(item)) {
    return NextResponse.json({ error: "visual_qa_v1 requires dedicated QA claim" }, { status: 409 });
  }
  if (!isLeaseGuardedNotifyCall
      && item.payload?.runtime_contract === "fresh_review_v1" && item.payload?.run_role === "review") {
    return NextResponse.json({ error: "fresh_review_v1 requires dedicated reviewer dispatch" }, { status: 409 });
  }
  if (!isLeaseGuardedNotifyCall && agent !== item.owner_agent && agent !== item.target_agent_id) {
    return NextResponse.json({ error: "notify_agent_identity_mismatch" }, { status: 409 });
  }

  // fresh_review_v1 session identity is server-owned. The detached agent never
  // supplies or chooses it; retries of the same immutable work item retain it.
  let workPayload = { ...(item.payload || {}) } as Record<string, unknown>;
  if (!isLeaseGuardedNotifyCall && useLocalMode && workPayload.runtime_contract === "fresh_review_v1"
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

  const preLockDeliveryKey = externalDeliveryKey(workPayload);
  if (!useLocalMode && !isLeaseGuardedNotifyCall && needsScheduledLaunchReadiness(workPayload)) {
    return NextResponse.json({ error: "scheduled_launch_notify_requires_local_atomic_guard" }, { status: 503 });
  }
  const launchReadiness = isLeaseGuardedNotifyCall || !useLocalMode
    ? await checkScheduledLaunchReadiness({ useLocalMode, db, item, payload: workPayload })
    : null;
  if (launchReadiness && !launchReadiness.ok) {
    const blocked = buildScheduledLaunchGateBlockedTransition(workPayload, {
      now: new Date(),
      failures: launchReadiness.failures,
      remediation: launchReadiness.remediation || "Resolve the launch gate failures, rerun preflight, then manually requeue.",
    });
    if (useLocalMode) {
      await withTransaction(async (client) => {
        await client.query("select id from public.work_items where id=$1 for update", [item!.id]);
        await client.query(
          `update public.work_items
              set status=$2,scheduled_for=null,completed_at=null,payload=$3::jsonb,updated_at=now()
            where id=$1`,
          [item!.id, blocked.status, JSON.stringify(blocked.payload)],
        );
      });
    } else {
      await (db as ReturnType<typeof createServiceClient>)
        .from("work_items")
        .update({ status: blocked.status, scheduled_for: null, completed_at: null, payload: blocked.payload, updated_at: new Date().toISOString() })
        .eq("id", item.id);
    }
    return NextResponse.json({
      error: "youtube_launch_gate_blocked",
      failures: launchReadiness.failures,
      remediation: launchReadiness.remediation,
      deadLettered: true,
    }, { status: 409 });
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

  if (workPayload.action === "prepare_blog_final_package") {
    message += `\n## REQUIRED: Spanish final-package completion contract
Before running the completion command, write the referenced JSON file with this exact structure:
\`\`\`json
{
  "status": "done",
  "output": {
    "final_package": {
      "spanish_markdown": "# Final Spanish Markdown...",
      "metadata_es": { "locale": "es", "title": "Spanish title" },
      "hero_image": { "media_path": "/absolute/approved/local/path/hero.png" }
    }
  }
}
\`\`\`
Mission Control rejects missing/non-Spanish metadata, remote-only hero URLs, files outside the approved roots, missing files, and unsupported image types. Do not include or alter English localization fields.`;
  }

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

  let externalClaim: Awaited<ReturnType<typeof claimExternalDelivery>> | null = null;
  const deliveryKey = preLockDeliveryKey;
  if (!isLeaseGuardedNotifyCall && useLocalMode) {
    const deliveryAcquisition = await withTransaction(async (client) => {
      const locked = await client.query<WorkItemRow>(
        "select * from public.work_items where id=$1 for update",
        [item!.id],
      );
      const current = locked.rows[0];
      if (!current || current.status !== "ready") return { error: "external_delivery_work_item_not_ready" as const };
      const initialUpdatedAt = new Date(item!.updated_at).getTime();
      const lockedUpdatedAt = new Date(current.updated_at).getTime();
      if (!Number.isFinite(initialUpdatedAt) || !Number.isFinite(lockedUpdatedAt) || initialUpdatedAt !== lockedUpdatedAt) {
        return { error: "notify_work_item_changed_before_lock" as const };
      }
      const currentPayload = { ...(current.payload || {}) } as Record<string, unknown>;
      const currentDeliveryKey = externalDeliveryKey(currentPayload);
      if (currentDeliveryKey !== deliveryKey) {
        return { error: "external_delivery_identity_changed" as const };
      }
      const currentLaunchReadiness = await checkScheduledLaunchReadiness({
        useLocalMode: true,
        db,
        localClient: client,
        item: current,
        payload: currentPayload,
      });
      if (currentLaunchReadiness && !currentLaunchReadiness.ok) {
        const blocked = buildScheduledLaunchGateBlockedTransition(currentPayload, {
          now: new Date(),
          failures: currentLaunchReadiness.failures,
          remediation: currentLaunchReadiness.remediation || "Resolve the launch gate failures, rerun preflight, then manually requeue.",
        });
        await client.query(
          `update public.work_items
              set status=$2,scheduled_for=null,completed_at=null,payload=$3::jsonb,updated_at=now()
            where id=$1`,
          [current.id, blocked.status, JSON.stringify(blocked.payload)],
        );
        return { gateBlocked: currentLaunchReadiness, current };
      }
      if (!currentDeliveryKey) return { claim: null, current, payload: currentPayload };
      const claim = await claimExternalDelivery(client, {
        key: currentDeliveryKey,
        workItemId: current.id,
        scope: externalDeliveryScope(currentPayload),
        now: new Date(),
      });
      if (claim.kind !== "acquired") return { claim, current };
      currentPayload.external_delivery_claim = {
        key: claim.key,
        claim_token: claim.claimToken,
        claim_attempt: claim.claimAttempt,
        status: "pending",
        claimed_at: new Date().toISOString(),
      };
      const updated = await client.query<WorkItemRow>(
        `update public.work_items set payload=$2::jsonb,updated_at=now()
          where id=$1 returning *`,
        [current.id, JSON.stringify(currentPayload)],
      );
      return { claim, current: updated.rows[0], payload: currentPayload };
    });
    if ("error" in deliveryAcquisition) {
      return NextResponse.json({ error: deliveryAcquisition.error }, { status: 409 });
    }
    if ("gateBlocked" in deliveryAcquisition && deliveryAcquisition.gateBlocked) {
      const gateBlocked = deliveryAcquisition.gateBlocked;
      return NextResponse.json({
        error: "youtube_launch_gate_blocked",
        failures: gateBlocked.failures,
        remediation: gateBlocked.remediation,
        deadLettered: true,
      }, { status: 409 });
    }
    externalClaim = deliveryAcquisition.claim;
    if (externalClaim && externalClaim.kind !== "acquired") {
      const replayStatus = externalClaim.kind === "accepted_replay" ? 200 : externalClaim.kind === "scope_conflict" ? 409 : 202;
      return NextResponse.json(externalDeliveryReplayBody(item, agent, externalClaim), { status: replayStatus });
    }
    workPayload = deliveryAcquisition.payload!;
    item = { ...item, ...deliveryAcquisition.current, payload: workPayload };
    item.payload = workPayload;
  }

  let wake: WakeAgentResult;
  if (isLeaseGuardedNotifyCall) {
    if (!useLocalMode || !schedulerClassificationIdentity) {
      return NextResponse.json({ error: "generic_scheduler_notify_requires_local_atomic_guard" }, { status: 503 });
    }

    // Commit the lease before the external spawn. A retry can therefore replay
    // the same logical attempt even when the first HTTP response is ambiguous.
    const acquisition = await withTransaction(async (client) => {
      const currentResult = await client.query<WorkItemRow>(
        `select id,status,scheduled_for,updated_at,source_type,source_id,owner_agent,target_agent_id,payload
           from public.work_items
          where id=$1
          for update`,
        [item.id],
      );
      const current = currentResult.rows[0];
      if (!current) return { error: "generic_notify_classification_identity_changed" as const };

      // Dedicated QA/reviewer rows are never valid generic work, including
      // replay attempts carrying a pre-existing generic lease.
      if (isVisualQaLikeWorkItem(current)) return { error: "generic_notify_visual_qa_rejected" as const };
      if (current.payload?.runtime_contract === "fresh_review_v1" && current.payload?.run_role === "review") {
        return { error: "generic_notify_fresh_review_rejected" as const };
      }

      const existingLease = parseGenericNotifyLease(current.payload);
      if (existingLease === "invalid") return { error: "generic_notify_lease_invalid" as const };
      const nowMs = Date.now();
      // A committed same-key lease is authoritative even if the spawned agent
      // already claimed the row. Revalidating status first would turn a safe
      // HTTP retry into a false rejection after a successful wake.
      if (existingLease && existingLease.key === idempotencyKey) {
        return { replay: existingLease, current };
      }
      if (isPublishBlogDispatcherCall && existingLease?.outcome === "accepted") {
        return { error: "publish_blog_dispatch_already_accepted" as const };
      }
      if (isPublishBlogDispatcherCall && !isPublishBlogDispatchCandidate(current, new Date(nowMs))) {
        return { error: "publish_blog_dispatcher_candidate_rejected" as const };
      }
      if (existingLease && Date.parse(existingLease.expires_at) > nowMs) {
        return { error: "generic_notify_lease_active" as const };
      }

      // Classification is intentionally checked against the pristine locked
      // row before this endpoint writes its own lease into payload/updated_at.
      if (!genericNotifyIdentityMatches(schedulerClassificationIdentity, current)) {
        return { error: "generic_notify_classification_identity_changed" as const };
      }
      if (current.status !== "ready") return { error: "generic_notify_status_not_ready" as const };
      if ((current.payload as Record<string, unknown> | null)?.dispatch_state === "blocked_live_gate") {
        return { error: "generic_notify_live_gate_blocked" as const };
      }
      if (agent !== current.owner_agent && agent !== current.target_agent_id) {
        return { error: "notify_agent_identity_mismatch" as const };
      }
      const launchReadiness = await checkScheduledLaunchReadiness({
        useLocalMode,
        db,
        localClient: client,
        item: current,
        payload: (current.payload || {}) as Record<string, unknown>,
      });
      if (launchReadiness && !launchReadiness.ok) {
        const blocked = buildScheduledLaunchGateBlockedTransition(current.payload || {}, {
          now: new Date(),
          failures: launchReadiness.failures,
          remediation: launchReadiness.remediation || "Resolve the launch gate failures, rerun preflight, then manually requeue.",
        });
        await client.query(
          `update public.work_items
              set status=$2,scheduled_for=null,completed_at=null,payload=$3::jsonb,updated_at=now()
            where id=$1`,
          [current.id, blocked.status, JSON.stringify(blocked.payload)],
        );
        return { gateBlocked: launchReadiness };
      }

      const payload: Record<string, unknown> = { ...(current.payload || {}) };
      const currentDeliveryKey = externalDeliveryKey(payload);
      let deliveryClaim: Awaited<ReturnType<typeof claimExternalDelivery>> | null = null;
      if (currentDeliveryKey) {
        deliveryClaim = await claimExternalDelivery(client, {
          key: currentDeliveryKey,
          workItemId: current.id,
          scope: externalDeliveryScope(payload),
          now: new Date(nowMs),
        });
        if (deliveryClaim.kind !== "acquired") {
          return { externalReplay: deliveryClaim, current };
        }
        payload.external_delivery_claim = {
          key: deliveryClaim.key,
          claim_token: deliveryClaim.claimToken,
          claim_attempt: deliveryClaim.claimAttempt,
          status: "pending",
          claimed_at: new Date(nowMs).toISOString(),
        };
      }

      const leasedAt = new Date(nowMs).toISOString();
      const lease: GenericNotifyLease = {
        version: GENERIC_NOTIFY_LEASE_VERSION,
        key: idempotencyKey,
        outcome: "leased",
        leased_at: leasedAt,
        expires_at: new Date(nowMs + genericNotifyLeaseMs()).toISOString(),
        outcome_at: null,
        mode: null,
        session_key: null,
        error: null,
      };
      // fresh_review_v1 implementation completion requires a server-owned
      // dispatch identity. Issue it under the same row lock as the lease so
      // concurrent same-key requests observe and preserve one trusted UUID.
      if (payload.runtime_contract === "fresh_review_v1"
          && payload.run_role === "implementation"
          && !isTrustedImplementationDispatchSessionId(payload.dispatch_session_id)) {
        payload.dispatch_session_id = randomUUID();
      }
      payload.generic_notify_lease = lease;
      const updated = await client.query<WorkItemRow>(
        `update public.work_items
            set payload=$2::jsonb,updated_at=now()
          where id=$1
          returning id,status,updated_at,source_type,source_id,owner_agent,target_agent_id,payload`,
        [current.id, JSON.stringify(payload)],
      );
      if (!updated.rows[0]) return { error: "generic_notify_lease_write_failed" as const };
      return { acquired: true as const, current: updated.rows[0], payload, deliveryClaim };
    });

    if ("error" in acquisition) {
      return NextResponse.json({ error: acquisition.error }, { status: 409 });
    }
    const gateBlocked = "gateBlocked" in acquisition ? acquisition.gateBlocked : null;
    if (gateBlocked) {
      return NextResponse.json({
        error: "youtube_launch_gate_blocked",
        failures: gateBlocked.failures,
        remediation: gateBlocked.remediation,
      }, { status: 409 });
    }
    if ("replay" in acquisition && acquisition.replay) {
      const replay = acquisition.replay as GenericNotifyLease;
      const body = genericNotifyReplayBody({ ...item, payload: acquisition.current.payload }, agent, replay);
      const status = replay.outcome === "failed" ? 503 : replay.outcome === "leased" ? 202 : 200;
      return NextResponse.json(body, { status });
    }
    if ("externalReplay" in acquisition && acquisition.externalReplay) {
      const replay = acquisition.externalReplay;
      const status = replay.kind === "accepted_replay" ? 200 : replay.kind === "scope_conflict" ? 409 : 202;
      return NextResponse.json(externalDeliveryReplayBody(item, agent, replay), { status });
    }
    if (!("acquired" in acquisition) || !acquisition.acquired) {
      return NextResponse.json({ error: "generic_notify_lease_acquire_failed" }, { status: 503 });
    }

    workPayload = acquisition.payload;
    item.payload = workPayload;
    externalClaim = acquisition.deliveryClaim;
    message += externalDeliveryInstruction(workPayload);
    wake = await wakeAgent(routing.agentId, item.id, message, workPayload);

    const finalized = await withTransaction(async (client) => {
      const locked = await client.query<WorkItemRow>(
        `select id,status,scheduled_for,updated_at,source_type,source_id,owner_agent,target_agent_id,payload
           from public.work_items
          where id=$1
          for update`,
        [item.id],
      );
      const current = locked.rows[0];
      if (!current) return null;
      const lease = parseGenericNotifyLease(current.payload);
      if (!lease || lease === "invalid" || lease.key !== idempotencyKey || lease.outcome !== "leased") return null;

      const outcomeAt = new Date().toISOString();
      const finalizedLease: GenericNotifyLease = {
        ...lease,
        outcome: wake.ok ? "accepted" : "failed",
        outcome_at: outcomeAt,
        mode: wake.mode,
        session_key: wake.sessionKey || null,
        error: wake.ok ? null : (wake.error || "wake_failed").slice(0, 500),
      };
      let payload: Record<string, unknown> = {
        ...(current.payload || {}),
        generic_notify_lease: finalizedLease,
      };
      let nextStatus = current.status;
      let nextScheduledFor = current.scheduled_for;
      if (!wake.ok) {
        const previousWakeFailures = Number(payload.wake_failure_count);
        payload.wake_failure_count = Number.isSafeInteger(previousWakeFailures) && previousWakeFailures >= 0
          ? previousWakeFailures + 1
          : 1;
        payload.dispatch_failure_reason = finalizedLease.error;
        payload.dispatch_last_failed_at = outcomeAt;

        const key = externalDeliveryKey(payload);
        const claim = recordValue(payload.external_delivery_claim);
        const claimToken = textValue(claim.claim_token);
        if (key && claimToken) {
          await markExternalDeliveryPreDeliveryFailure(client, {
            key,
            claimToken,
            workItemId: current.id,
            failedAt: outcomeAt,
            error: finalizedLease.error || "runtime_unavailable",
          });
          payload.external_delivery_claim = { ...claim, status: "failed_pre_delivery", failed_at: outcomeAt };
        }
        if (payload.runtime_retry_contract === "scheduled_launch_v2_retry_v1") {
          const retry = nextScheduledLaunchRetryTransition(payload, {
            now: outcomeAt,
            failureClass: "runtime_unavailable",
            error: finalizedLease.error || "runtime_unavailable",
          });
          payload = retry.payload;
          nextStatus = retry.status;
          nextScheduledFor = retry.scheduledFor;
        }
      }
      const updated = await client.query<WorkItemRow>(
        `update public.work_items
            set payload=$2::jsonb,status=$3,scheduled_for=$4::timestamptz,
                completed_at=case when $3='ready' then null else completed_at end,updated_at=now()
          where id=$1
          returning id,status,scheduled_for,updated_at,source_type,source_id,owner_agent,target_agent_id,payload`,
        [current.id, JSON.stringify(payload), nextStatus, nextScheduledFor || null],
      );
      return updated.rows[0] || null;
    });

    if (!finalized) {
      return NextResponse.json({
        ok: false,
        agent,
        woke: wake.ok,
        workItemId: item.id,
        wakeMode: wake.mode,
        error: "generic_notify_lease_finalize_conflict",
      }, { status: 503 });
    }
    workPayload = finalized.payload || workPayload;
    item.payload = workPayload;
  } else {
    message += externalDeliveryInstruction(workPayload);
    wake = await wakeAgent(routing.agentId, item.id, message, workPayload);
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

      if (latestStatus === "done") {
        console.log(`[notify-work-item] ${agent} wake timed out, but work item is ${latestStatus}; treating as success`);
        wake = { ...wake, ok: true };
      }
    }
  }

  if (!wake.ok && !isLeaseGuardedNotifyCall
      && (externalDeliveryKey(workPayload) || workPayload.runtime_retry_contract === "scheduled_launch_v2_retry_v1")) {
    if (!useLocalMode) {
      return NextResponse.json({ error: "scheduled_launch_retry_requires_local_atomic_guard" }, { status: 503 });
    }
    const failedAt = new Date().toISOString();
    await withTransaction(async (client) => {
      const locked = await client.query<WorkItemRow>("select * from public.work_items where id=$1 for update", [item.id]);
      const current = locked.rows[0];
      if (!current) return;
      let payload = { ...(current.payload || {}) } as Record<string, unknown>;
      const key = externalDeliveryKey(payload);
      const claim = recordValue(payload.external_delivery_claim);
      const claimToken = textValue(claim.claim_token);
      if (key && claimToken) {
        await markExternalDeliveryPreDeliveryFailure(client, {
          key,
          claimToken,
          workItemId: current.id,
          failedAt,
          error: wake.error || "runtime_unavailable",
        });
        payload.external_delivery_claim = { ...claim, status: "failed_pre_delivery", failed_at: failedAt };
      }
      let status = current.status;
      let scheduledFor = current.scheduled_for;
      if (payload.runtime_retry_contract === "scheduled_launch_v2_retry_v1") {
        const retry = nextScheduledLaunchRetryTransition(payload, {
          now: failedAt,
          failureClass: "runtime_unavailable",
          error: wake.error || "runtime_unavailable",
        });
        payload = retry.payload;
        status = retry.status;
        scheduledFor = retry.scheduledFor;
      }
      await client.query(
        `update public.work_items
            set payload=$2::jsonb,status=$3,scheduled_for=$4::timestamptz,
                completed_at=case when $3='ready' then null else completed_at end,updated_at=now()
          where id=$1`,
        [current.id, JSON.stringify(payload), status, scheduledFor || null],
      );
      workPayload = payload;
      item.payload = payload;
    });
  }

  if (!wake.ok) {
    return NextResponse.json({
      ok: false,
      accepted: false,
      pending: false,
      agent,
      woke: false,
      workItemId: item.id,
      wakeMode: wake.mode,
      dispatchSessionKey: wake.sessionKey || null,
      idempotent: false,
      outcome: isLeaseGuardedNotifyCall ? "failed" : undefined,
      error: wake.error || null,
    }, { status: 503 });
  }

  const webhookUrl = process.env.DISCORD_TASK_ROUTER_WEBHOOK;
  const suppressTaskRouterWebhook = workPayload.suppress_task_router_webhook === true || workPayload.notify_project_thread === false;
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
    accepted: true,
    pending: false,
    agent,
    woke: wake.ok,
    workItemId: item.id,
    wakeMode: wake.mode,
    dispatchCronJobId: null,
    dispatchCronRunId: null,
    dispatchSessionId: typeof workPayload.dispatch_session_id === "string" ? workPayload.dispatch_session_id : null,
    dispatchSessionKey: wake.sessionKey || null,
    idempotent: false,
    outcome: isLeaseGuardedNotifyCall ? "accepted" : undefined,
  });
}
