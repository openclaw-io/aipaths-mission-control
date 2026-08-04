import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";
import { claimQaWorkItem } from "@/lib/qa/claim";
import { applyQaResult, lockQaExecution } from "@/lib/qa/execution";
import { hashQaResult, type QaResult } from "@/lib/qa/result";

export type TransactionRunner = <T>(run: (client: CompletionQueryClient) => Promise<T>) => Promise<T>;
export type QaLauncher = (executionId: string, capability: string) => Promise<QaRunnerIdentity>;
export type QaDispatchResult =
  | { ok: true; already_running: true; state_claimed: true; execution_id: string; status: "running" }
  | { ok: true; already_running: false; state_claimed: true; execution_id: string;
      status: "running" | "succeeded" | "failed" | "blocked" };

const DEFAULT_DB = "postgres://aipaths_mc_app@127.0.0.1:5432/aipaths_mission_control_local";
const SAFE_QA_CLAIM_ERRORS = new Set([
  "invalid_qa_claim_identity",
  "qa_work_item_not_found",
  "qa_claim_binding_mismatch",
  "qa_running_execution_ambiguous",
  "qa_claim_state_conflict",
  "qa_claim_concurrent_conflict",
]);

export class QaDispatchError extends Error {
  readonly kind = "qa_dispatch_error";

  constructor(
    message: string,
    readonly state_claimed?: boolean,
    readonly execution_id?: string,
  ) {
    super(message);
    this.name = "QaDispatchError";
  }
}

export function isQaDispatchError(error: unknown): error is QaDispatchError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate.kind === "qa_dispatch_error"
    && (candidate.state_claimed === undefined || typeof candidate.state_claimed === "boolean")
    && (candidate.execution_id === undefined || typeof candidate.execution_id === "string");
}

export function safeVisualQaRunnerEnv(): NodeJS.ProcessEnv {
  const browserExecutable = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  if ((process.env.HERMES_VISUAL_QA_MODEL && process.env.HERMES_VISUAL_QA_MODEL !== "gpt-5.6-sol")
    || (process.env.HERMES_VISUAL_QA_PROVIDER && process.env.HERMES_VISUAL_QA_PROVIDER !== "openai-codex")) {
    throw new Error("qa_hermes_contract_override");
  }
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/Users/joaco",
    TMPDIR: process.env.TMPDIR || "/tmp",
    NODE_ENV: process.env.NODE_ENV || "production",
    MISSION_CONTROL_DATABASE_URL: process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_DB,
    HERMES_VISUAL_QA_BIN: process.env.HERMES_VISUAL_QA_BIN || "/Users/joaco/.hermes/hermes-agent/venv/bin/hermes",
    HERMES_VISUAL_QA_PROFILE: process.env.HERMES_VISUAL_QA_PROFILE || "reviewer",
    HERMES_VISUAL_QA_MODEL: "gpt-5.6-sol",
    HERMES_VISUAL_QA_PROVIDER: "openai-codex",
    HERMES_VISUAL_QA_ARTIFACT_ROOT: process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT || "/Users/joaco/openclaw/artifacts/visual-qa",
    AGENT_BROWSER_BIN: process.env.AGENT_BROWSER_BIN
      || resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "agent-browser.cmd" : "agent-browser"),
    ...(browserExecutable && isAbsolute(browserExecutable)
      ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable }
      : {}),
  };
}

type KillProcessGroup = (pid: number, signal?: NodeJS.Signals | 0) => void;

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safePid(pid: number) {
  return Number.isInteger(pid) && pid > 1 && pid < 2 ** 31;
}

export function qaRunnerProcessGroupAlive(
  pid: number,
  kill: KillProcessGroup = process.kill.bind(process) as KillProcessGroup,
) {
  if (!safePid(pid)) return false;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForRunnerProcessGroupExit(pid: number, {
  kill,
  timeoutMs,
  pollIntervalMs,
}: {
  kill: KillProcessGroup;
  timeoutMs: number;
  pollIntervalMs: number;
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!qaRunnerProcessGroupAlive(pid, kill)) return true;
    await sleep(pollIntervalMs);
  }
  return !qaRunnerProcessGroupAlive(pid, kill);
}

export type QaRunnerIdentity = { pid: number; birth_token: string };
type RunnerIdentityReader = (pid: number) => Promise<string>;

async function readRunnerProcessIdentity(pid: number) {
  return new Promise<string>((resolveIdentity, rejectIdentity) => {
    const child: ChildProcess = spawn("/bin/ps", ["-ww", "-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], {
      env: { PATH: "/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV || "production" },
      stdio: ["ignore", "pipe", "ignore"],
    } as SpawnOptions);
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectIdentity(new Error("visual_qa_runner_identity_timeout"));
    }, 2_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 8_192) stdout += String(chunk).slice(0, 8_192 - stdout.length);
    });
    child.once("error", () => {
      clearTimeout(timer);
      rejectIdentity(new Error("visual_qa_runner_identity_unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveIdentity(stdout);
      else rejectIdentity(new Error("visual_qa_runner_identity_unavailable"));
    });
  });
}

const PROCESS_BIRTH = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function normalizeBirthToken(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function parseQaRunnerProcessIdentity(pid: number, executionId: string, output: string): QaRunnerIdentity | null {
  const match = output.trim().match(
    /^(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
  );
  if (!match || Number(match[1]) !== pid || Number(match[2]) !== pid) return null;
  const birthToken = normalizeBirthToken(match[3]);
  if (!PROCESS_BIRTH.test(birthToken)) return null;
  const executable = process.execPath;
  const runner = resolve(process.cwd(), "scripts/visual-qa-runner.mjs");
  const expectedCommand = `${executable} ${runner} ${executionId}`;
  if (match[4] !== expectedCommand) return null;
  return { pid, birth_token: birthToken };
}

export async function captureQaRunnerProcessIdentity(
  pid: number,
  executionId: string,
  readIdentity: RunnerIdentityReader = readRunnerProcessIdentity,
) {
  if (!safePid(pid) || !/^[0-9a-f-]{36}$/i.test(executionId)) return null;
  try {
    return parseQaRunnerProcessIdentity(pid, executionId, await readIdentity(pid));
  } catch {
    return null;
  }
}

export async function verifyQaRunnerProcessIdentity(
  identity: QaRunnerIdentity,
  executionId: string,
  readIdentity: RunnerIdentityReader = readRunnerProcessIdentity,
) {
  if (!identity || !safePid(identity.pid) || !PROCESS_BIRTH.test(normalizeBirthToken(identity.birth_token))
    || !/^[0-9a-f-]{36}$/i.test(executionId)) return false;
  const observed = await captureQaRunnerProcessIdentity(identity.pid, executionId, readIdentity);
  return !!observed && observed.pid === identity.pid
    && observed.birth_token === normalizeBirthToken(identity.birth_token);
}

type VerifyRunnerIdentity = (
  identity: QaRunnerIdentity,
  executionId: string,
) => Promise<boolean>;

export async function terminateQaRunnerProcessGroup(identity: QaRunnerIdentity, executionId: string, {
  kill = process.kill.bind(process) as KillProcessGroup,
  verify = verifyQaRunnerProcessIdentity,
  termWaitMs = 5_000,
  killWaitMs = 5_000,
  pollIntervalMs = 100,
}: {
  kill?: KillProcessGroup;
  verify?: VerifyRunnerIdentity;
  termWaitMs?: number;
  killWaitMs?: number;
  pollIntervalMs?: number;
} = {}) {
  if (!identity || !safePid(identity.pid) || !PROCESS_BIRTH.test(normalizeBirthToken(identity.birth_token))
    || !/^[0-9a-f-]{36}$/i.test(executionId)) {
    throw new Error("visual_qa_runner_identity_invalid");
  }
  const pid = identity.pid;
  if (!qaRunnerProcessGroupAlive(pid, kill)) return false;
  if (!(await verify(identity, executionId))) throw new Error("visual_qa_runner_identity_mismatch");
  try {
    kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    throw error;
  }
  if (await waitForRunnerProcessGroupExit(pid, { kill, timeoutMs: termWaitMs, pollIntervalMs })) return true;
  if (!(await verify(identity, executionId))) throw new Error("visual_qa_runner_identity_mismatch_before_sigkill");
  try {
    kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return true;
    throw error;
  }
  if (!(await waitForRunnerProcessGroupExit(pid, { kill, timeoutMs: killWaitMs, pollIntervalMs }))) {
    throw new Error("visual_qa_runner_process_group_alive_after_sigkill");
  }
  return true;
}

async function writeQaCapability(pipe: Writable, capability: string) {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      pipe.off("error", onError);
      pipe.off("finish", onFinish);
      if (error) rejectWrite(error); else resolveWrite();
    };
    const onError = (error: Error) => finish(error);
    const onFinish = () => finish();
    pipe.once("error", onError);
    pipe.once("finish", onFinish);
    try {
      pipe.end(capability, "utf8", onFinish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("visual_qa_capability_pipe_write_failed"));
    }
  });
}

/** Launches the detached visual QA runner. The raw capability exists only in the parent and child FD 3 pipe. */
export const launchVisualQaRunner = async (
  executionId: string,
  capability: string,
  { readIdentity = readRunnerProcessIdentity, terminate = terminateQaRunnerProcessGroup }: {
    readIdentity?: RunnerIdentityReader;
    terminate?: (identity: QaRunnerIdentity, executionId: string) => Promise<boolean>;
  } = {},
): Promise<QaRunnerIdentity> => {
  const script = resolve(process.cwd(), "scripts/visual-qa-runner.mjs");
  const child: ChildProcess = spawn(process.execPath, [script, executionId], {
    cwd: process.cwd(),
    detached: true,
    env: safeVisualQaRunnerEnv(),
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  } as SpawnOptions);
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  if (!child.pid) {
    child.unref();
    throw new Error("qa_runner_cleanup_failed");
  }
  const cleanupPostSpawnFailure = async () => {
    const identity = await captureQaRunnerProcessIdentity(child.pid as number, executionId, readIdentity);
    if (!identity) {
      child.unref();
      throw new Error("qa_runner_cleanup_failed");
    }
    try {
      if (await terminate(identity, executionId) !== true) throw new Error("cleanup_not_verified");
    } catch {
      child.unref();
      throw new Error("qa_runner_cleanup_failed");
    }
    throw new Error("qa_spawn_failed");
  };
  const capabilityPipe = child.stdio[3] as Writable | null;
  if (!capabilityPipe || typeof capabilityPipe.write !== "function") {
    return cleanupPostSpawnFailure();
  }
  try {
    await writeQaCapability(capabilityPipe, capability);
  } catch {
    return cleanupPostSpawnFailure();
  }
  const identity = await captureQaRunnerProcessIdentity(child.pid, executionId, readIdentity);
  if (!identity) {
    child.unref();
    throw new Error("qa_runner_cleanup_failed");
  }
  child.unref();
  return identity;
};

async function failLaunch(withTransaction: TransactionRunner, executionId: string, capability: string, reason: string) {
  await withTransaction(async (client) => {
    const execution = await lockQaExecution(client, executionId);
    if (!execution || execution.status !== "running") return;
    const result: QaResult = {
      verdict: "infrastructure_failure",
      tested_sha: execution.target_sha,
      viewport_checks: [],
      flow_checks: [],
      evidence: [],
      findings: [],
      error: reason.slice(0, 2_048),
    };
    await applyQaResult(client, execution, result, hashQaResult(result), execution.qa_session_id || "", capability);
  });
}

export async function dispatchQa(
  workItemId: string,
  dependencies: {
    withTransaction: TransactionRunner;
    launch?: QaLauncher;
    terminate?: (identity: QaRunnerIdentity, executionId: string) => void | Promise<void>;
  },
): Promise<QaDispatchResult> {
  if (!/^[0-9a-f-]{36}$/i.test(workItemId)) {
    throw new QaDispatchError("invalid_qa_work_item_id", false);
  }
  let claimed;
  try {
    claimed = await claimQaWorkItem(workItemId, {
      withTransaction: dependencies.withTransaction,
      allowAlreadyRunning: true,
    });
  } catch (error) {
    const message = error instanceof Error && SAFE_QA_CLAIM_ERRORS.has(error.message)
      ? error.message
      : "qa_dispatch_claim_failed";
    throw new QaDispatchError(message, false);
  }
  if (claimed.alreadyRunning) {
    return { ok: true, already_running: true, state_claimed: true,
      execution_id: claimed.execution_id, status: "running" };
  }

  let runnerIdentity: QaRunnerIdentity;
  try {
    runnerIdentity = await (dependencies.launch || launchVisualQaRunner)(claimed.execution_id, claimed.capability);
  } catch (error) {
    if (error instanceof Error && error.message === "qa_runner_cleanup_failed") {
      throw new QaDispatchError("qa_runner_cleanup_failed", true, claimed.execution_id);
    }
    const reason = "qa_spawn_failed";
    await failLaunch(dependencies.withTransaction, claimed.execution_id, claimed.capability, reason).catch(() => {});
    throw new QaDispatchError(reason, true, claimed.execution_id);
  }

  try {
    const persistedStatus = await dependencies.withTransaction(async (client) => {
      const attached = await client.query<{ status: "running" | "succeeded" | "failed" | "blocked" }>(
        "select attach_visual_qa_execution_pid($1,$2,$3,$4) status",
        [claimed.execution_id, runnerIdentity.pid, runnerIdentity.birth_token, claimed.capability],
      );
      const status = attached.rows[0]?.status;
      if (status && ["running", "succeeded", "failed", "blocked"].includes(status)) return status;
      throw new Error("visual_qa_execution_pid_state_conflict");
    });
    return { ok: true, already_running: false, state_claimed: true,
      execution_id: claimed.execution_id, status: persistedStatus };
  } catch {
    const terminate = dependencies.terminate || terminateQaRunnerProcessGroup;
    try {
      await Promise.resolve(terminate(runnerIdentity, claimed.execution_id));
    } catch {
      throw new QaDispatchError("qa_runner_cleanup_failed", true, claimed.execution_id);
    }
    const reason = "qa_pid_persistence_failed";
    await failLaunch(dependencies.withTransaction, claimed.execution_id, claimed.capability, reason).catch(() => {});
    throw new QaDispatchError(reason, true, claimed.execution_id);
  }
}
