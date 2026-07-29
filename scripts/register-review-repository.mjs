#!/usr/bin/env node
import pg from "pg";
import { registerReviewRepository } from "./lib/repository-registration.mjs";

const DEFAULT_DATABASE_URL = "postgres://joaco@127.0.0.1:5432/aipaths_mission_control_local";

export function parseArguments(args) {
  const options = { enable: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--enable") options.enable = true;
    else if (argument === "--key" && args[index + 1]) options.key = args[++index];
    else if (argument === "--path" && args[index + 1]) options.repositoryPath = args[++index];
    else throw new Error(`unknown_or_incomplete_argument:${argument}`);
  }
  if (!options.key) throw new Error("repository_key_required");
  if (!options.repositoryPath) throw new Error("repository_path_required");
  return options;
}

export function requireLocalMissionControlUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("repository_registration_database_url_invalid"); }
  const database = url.pathname.replace(/^\//, "");
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost"].includes(url.hostname)
    || database !== "aipaths_mission_control_local") {
    throw new Error("repository_registration_requires_local_mission_control_database");
  }
  return url.toString();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const connectionString = requireLocalMissionControlUrl(
    process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_DATABASE_URL,
  );
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await registerReviewRepository({
      ...options,
      withTransaction: async (run) => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const value = await run(client);
          await client.query("commit");
          return value;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "repository_registration_failed" })}\n`);
    process.exitCode = 1;
  });
}
