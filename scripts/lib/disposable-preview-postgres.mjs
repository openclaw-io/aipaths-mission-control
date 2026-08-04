import pg from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { cleanVisualQaChildEnv, terminateDetachedProcessGroup } from "./visual-qa-runtime.mjs";
import { runBounded } from "./reviewer-runtime.mjs";

const POSTGRES_BIN_DIRS = [
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/opt/postgresql@17/bin",
  "/usr/local/opt/postgresql@16/bin",
  "/Applications/Postgres.app/Contents/Versions/latest/bin",
];

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("visual_qa_lifecycle_aborted");
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new Error("visual_qa_lifecycle_aborted"));
  return new Promise((resolveValue, rejectValue) => {
    const onAbort = () => rejectValue(new Error("visual_qa_lifecycle_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolveValue, rejectValue).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function sleep(ms, signal) {
  return abortable(new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), signal);
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("visual_qa_postgres_port_reservation_failed");
  }
  return {
    port: address.port,
    release: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function resolvePostgresBinDir(explicitDir) {
  const candidates = [explicitDir, ...POSTGRES_BIN_DIRS]
    .filter((value) => typeof value === "string" && value.startsWith("/"));
  for (const candidate of candidates) {
    try {
      const binDir = await realpath(candidate);
      await Promise.all(["initdb", "postgres"].map((name) => realpath(join(binDir, name))));
      return binDir;
    } catch {
      // Try the next locally installed PostgreSQL distribution.
    }
  }
  throw new Error("visual_qa_postgres_binaries_missing");
}

async function waitForPostgres(databaseUrl, getExit, timeoutMs = 30_000, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const exit = getExit();
    if (exit) throw new Error(`visual_qa_postgres_exited:${exit.code ?? exit.signal ?? "unknown"}`);
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000, query_timeout: 1_000 });
    try {
      await abortable(client.connect(), signal);
      await abortable(client.query("select 1"), signal);
      return;
    } catch {
      throwIfAborted(signal);
      await sleep(100, signal);
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error("visual_qa_postgres_start_timeout");
}

export async function startDisposablePreviewDatabase({
  rootDir,
  schemaPath,
  postgresBinDir = process.env.HERMES_VISUAL_QA_POSTGRES_BIN_DIR,
  processGroups = null,
  signal,
} = {}) {
  throwIfAborted(signal);
  const canonicalRoot = await realpath(rootDir).catch(() => null);
  const canonicalSchema = await realpath(schemaPath).catch(() => null);
  if (!canonicalRoot || !canonicalSchema) throw new Error("visual_qa_postgres_paths_invalid");

  const binDir = await resolvePostgresBinDir(postgresBinDir);
  const initdb = join(binDir, "initdb");
  const postgres = join(binDir, "postgres");
  const dataDir = join(canonicalRoot, "postgres-data");
  const postgresEnv = cleanVisualQaChildEnv({ HOME: canonicalRoot, TMPDIR: canonicalRoot }, { allowHermes: false });
  await runBounded(initdb, [
    "-D", dataDir,
    "--encoding=UTF8",
    "--locale=C",
    "--username=visual_qa_admin",
    "--auth-local=trust",
    "--auth-host=trust",
  ], {
    cwd: canonicalRoot,
    env: postgresEnv,
    timeoutMs: 60_000,
    maxBytes: 256 * 1024,
    detachedProcessGroup: true,
    signal,
    onSpawn: (pid) => processGroups?.track(pid),
    onSettled: (pid) => processGroups?.untrack(pid),
  });

  let reservation = await reserveLoopbackPort();
  const port = reservation.port;
  let child = null;
  let exit = null;
  let stderr = "";
  try {
    await abortable(reservation.release(), signal);
    reservation = null;
    child = spawn(postgres, [
      "-D", dataDir,
      "-h", "127.0.0.1",
      "-p", String(port),
      "-c", "unix_socket_directories=",
      "-c", "ssl=off",
      "-c", "fsync=off",
      "-c", "full_page_writes=off",
      "-c", "synchronous_commit=off",
      "-c", "max_connections=10",
      "-c", "shared_buffers=16MB",
      "-c", "log_connections=off",
      "-c", "log_disconnections=off",
      "-c", "log_statement=none",
    ], {
      cwd: canonicalRoot,
      detached: true,
      env: postgresEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.once("exit", (code, signal) => { exit = { code, signal }; });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
      if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
    });
    await abortable(once(child, "spawn"), signal);
    child.unref();
    if (!child.pid) throw new Error("visual_qa_postgres_pid_missing");
    processGroups?.track(child.pid);

    const adminUrl = `postgresql://visual_qa_admin@127.0.0.1:${port}/postgres`;
    await waitForPostgres(adminUrl, () => exit, 30_000, signal);
    const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
    try {
      await abortable(admin.connect(), signal);
      await abortable(admin.query(await abortable(readFile(canonicalSchema, "utf8"), signal)), signal);
    } finally {
      await admin.end().catch(() => {});
    }

    const databaseUrl = `postgresql://aipaths_mc_app@127.0.0.1:${port}/postgres`;
    const app = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    try {
      await abortable(app.connect(), signal);
      const identity = await abortable(app.query("select current_user, current_database()"), signal);
      if (identity.rows[0]?.current_user !== "aipaths_mc_app" || identity.rows[0]?.current_database !== "postgres") {
        throw new Error("visual_qa_preview_database_identity_mismatch");
      }
    } finally {
      await app.end().catch(() => {});
    }

    let stopped = false;
    return {
      child,
      port,
      databaseUrl,
      targetSecrets: [],
      async stop() {
        if (stopped) return;
        await terminateDetachedProcessGroup(child.pid);
        processGroups?.untrack(child.pid);
        stopped = true;
      },
    };
  } catch (error) {
    if (reservation) await reservation.release().catch(() => {});
    if (child?.pid) {
      await terminateDetachedProcessGroup(child.pid).catch(() => {});
      processGroups?.untrack(child.pid);
    }
    throw new Error(error instanceof Error && /^visual_qa_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "visual_qa_postgres_failed");
  }
}
