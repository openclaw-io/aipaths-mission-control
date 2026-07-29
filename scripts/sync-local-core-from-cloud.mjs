#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import {
  LOCAL_DATABASE_NAME,
  decideSyncMode,
  findSchemaImportErrors,
  findSemanticImportErrors,
  parseLocalDatabaseUrl,
  parseSyncArguments,
  prepareWorkItemRows,
  quoteIdent,
  redactSecrets,
  sanitizeRows,
  validateReferenceIntegrity,
} from "../ops/local-postgres/sync-local-core-helpers.mjs";

const { Client: PgClient } = pg;
const PAGE_SIZE = 1000;
const INSERT_CHUNK_SIZE = 200;
const BASELINE_CONFIG_TABLES = new Set(["scheduler_config", "execution_window_config"]);

// Closed dependency set. Hierarchy parents precede children; the one intentional
// cycle (loops.current_plan_revision_id -> loop_plan_revisions.id) is safe because
// that nullable FK is INITIALLY DEFERRED and the whole import is transactional.
export const TABLES = [
  { name: "pipeline_runs", orderBy: "id" },
  { name: "recurring_work_rules", orderBy: "created_at" },
  { name: "loops", orderBy: "created_at" },
  { name: "loop_plan_revisions", orderBy: "created_at" },
  { name: "loop_stages", orderBy: "created_at" },
  { name: "loop_tasks", orderBy: "created_at" },
  { name: "loop_task_dependencies", orderBy: "created_at" },
  { name: "loop_task_runs", orderBy: "created_at" },
  { name: "loop_task_reviews", orderBy: "created_at" },
  { name: "loop_evidence", orderBy: "created_at" },
  { name: "pipeline_items", orderBy: "created_at" },
  { name: "ops_owned_videos", orderBy: "published_at" },
  { name: "intel_sources", orderBy: "id" },
  { name: "intel_runs", orderBy: "id" },
  { name: "competitor_channels", orderBy: "id" },
  { name: "competitor_transcripts", orderBy: "id" },
  { name: "work_items", orderBy: "created_at" },
  { name: "work_item_dependencies", orderBy: "created_at" },
  { name: "recurring_work_occurrences", orderBy: "created_at" },
  { name: "pipeline_events", orderBy: "created_at" },
  { name: "pipeline_work_map", orderBy: "created_at" },
  { name: "loop_events", orderBy: "created_at" },
  { name: "loop_work_items", orderBy: "created_at" },
  { name: "activity_log", orderBy: "created_at" },
  { name: "memories", orderBy: "created_at" },
  { name: "usage_logs", orderBy: "created_at" },
  { name: "ops_youtube_video_daily", orderBy: "date" },
  { name: "ops_youtube_short_daily", orderBy: "date" },
  { name: "ops_youtube_channel_daily", orderBy: "date" },
  { name: "ops_community_daily", orderBy: "date" },
  { name: "ops_youtube_comments", orderBy: "created_at" },
  { name: "ops_daily_snapshots", orderBy: "date" },
  { name: "academy_daily_kpis", orderBy: "date" },
  { name: "ops_youtube_video_learning_snapshots", orderBy: "computed_at" },
  { name: "intel_items_raw", orderBy: "id" },
  { name: "intel_items_enriched", orderBy: "id" },
  { name: "intel_trend_daily", orderBy: "date" },
  { name: "competitor_video_snapshots", orderBy: "id" },
  { name: "intel_inbox_reviews", orderBy: "created_at" },
];
const TABLE_NAMES = TABLES.map((table) => table.name);
const TABLE_NAME_SET = new Set(TABLE_NAMES);

export const REFERENCE_RULES = [
  ["loops", "current_plan_revision_id", "loop_plan_revisions", "id"],
  ["loop_plan_revisions", "loop_id", "loops", "id"],
  ["loop_stages", "plan_revision_id", "loop_plan_revisions", "id"],
  ["loop_tasks", "stage_id", "loop_stages", "id"],
  ["loop_task_dependencies", "task_id", "loop_tasks", "id"],
  ["loop_task_dependencies", "depends_on_task_id", "loop_tasks", "id"],
  ["loop_task_runs", "task_id", "loop_tasks", "id"],
  ["loop_task_reviews", "task_id", "loop_tasks", "id"],
  ["loop_task_reviews", "task_run_id", "loop_task_runs", "id"],
  ["loop_evidence", "task_id", "loop_tasks", "id"],
  ["loop_evidence", "task_run_id", "loop_task_runs", "id"],
  ["work_items", "loop_id", "loops", "id"],
  ["work_items", "parent_id", "work_items", "id"],
  ["work_item_dependencies", "work_item_id", "work_items", "id"],
  ["work_item_dependencies", "depends_on_work_item_id", "work_items", "id"],
  ["recurring_work_occurrences", "rule_id", "recurring_work_rules", "id"],
  ["recurring_work_occurrences", "work_item_id", "work_items", "id"],
  ["pipeline_items", "loop_id", "loops", "id"],
  ["pipeline_events", "pipeline_item_id", "pipeline_items", "id"],
  ["pipeline_work_map", "pipeline_item_id", "pipeline_items", "id"],
  ["pipeline_work_map", "work_item_id", "work_items", "id"],
  ["loop_events", "loop_id", "loops", "id"],
  ["loop_work_items", "loop_id", "loops", "id"],
  ["loop_work_items", "work_item_id", "work_items", "id"],
  ["ops_youtube_video_daily", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_video_daily", "academy_video_id", "ops_owned_videos", "academy_video_id"],
  ["ops_youtube_short_daily", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_short_daily", "academy_video_id", "ops_owned_videos", "academy_video_id"],
  ["ops_youtube_channel_daily", "run_id", "pipeline_runs", "id"],
  ["ops_community_daily", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_comments", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_comments", "academy_video_id", "ops_owned_videos", "academy_video_id"],
  ["ops_daily_snapshots", "build_run_id", "pipeline_runs", "id"],
  ["academy_daily_kpis", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_video_learning_snapshots", "run_id", "pipeline_runs", "id"],
  ["ops_youtube_video_learning_snapshots", "academy_video_id", "ops_owned_videos", "academy_video_id"],
  ["intel_items_raw", "source_id", "intel_sources", "id"],
  ["intel_items_raw", "run_id", "pipeline_runs", "id"],
  ["intel_items_enriched", "raw_item_id", "intel_items_raw", "id"],
  ["intel_trend_daily", "run_id", "pipeline_runs", "id"],
  ["competitor_channels", "source_id", "intel_sources", "id"],
  ["competitor_video_snapshots", "competitor_channel_id", "competitor_channels", "id"],
  ["intel_inbox_reviews", "enriched_item_id", "intel_items_enriched", "id"],
  ["intel_inbox_reviews", "created_pipeline_item_id", "pipeline_items", "id"],
];

function loadEnv(path) {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!process.env[key]) process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Optional when the environment is already populated.
  }
}

async function fetchAllRows(cloud, table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await cloud
      .from(table.name)
      .select("*")
      .order(table.orderBy, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${table.name}: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return sanitizeRows(table.name, rows);
}

async function getLocalColumns(client, tableName) {
  const result = await client.query(
    `select column_name, data_type, is_identity, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [tableName],
  );
  return result.rows;
}

async function getNonEmptyLocalTables(client) {
  const tablesResult = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const nonEmpty = [];
  for (const { table_name: tableName } of tablesResult.rows) {
    if (BASELINE_CONFIG_TABLES.has(tableName)) continue;
    const countResult = await client.query(`select count(*)::bigint as count from public.${quoteIdent(tableName)}`);
    const rowCount = Number(countResult.rows[0].count);
    if (rowCount > 0) nonEmpty.push({ tableName, rowCount });
  }
  return nonEmpty;
}

async function getExternalForeignKeys(client) {
  const result = await client.query(
    `select child.relname as child_table,
            parent.relname as parent_table,
            constraint_row.conname as constraint_name
       from pg_constraint constraint_row
       join pg_class child on child.oid = constraint_row.conrelid
       join pg_namespace child_ns on child_ns.oid = child.relnamespace
       join pg_class parent on parent.oid = constraint_row.confrelid
       join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
      where constraint_row.contype = 'f'
        and child_ns.nspname = 'public'
        and parent_ns.nspname = 'public'
        and parent.relname = any($1::text[])`,
    [TABLE_NAMES],
  );
  return result.rows.filter((row) => !TABLE_NAME_SET.has(row.child_table));
}

async function verifyLocalDatabaseTarget(client) {
  const result = await client.query(
    "select current_database() as database_name, inet_server_addr()::text as server_address",
  );
  const target = result.rows[0] || {};
  const address = target.server_address;
  const loopback = address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
  if (target.database_name !== LOCAL_DATABASE_NAME || !loopback) {
    throw new Error(
      `Connected target verification failed (database=${target.database_name}, server=${address})`,
    );
  }
}

function normalizeValue(value, column) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return column.data_type === "ARRAY" ? value : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

async function resetIdentitySequences(client, tableName, identityColumns) {
  for (const column of identityColumns) {
    const sequenceResult = await client.query(
      "select pg_get_serial_sequence($1, $2) as sequence_name",
      [`public.${tableName}`, column.column_name],
    );
    const sequenceName = sequenceResult.rows[0]?.sequence_name;
    if (!sequenceName) continue;
    const maxResult = await client.query(
      `select max(${quoteIdent(column.column_name)})::bigint as max_value from public.${quoteIdent(tableName)}`,
    );
    const maxValue = maxResult.rows[0].max_value;
    if (maxValue == null) {
      await client.query("select setval($1::regclass, 1, false)", [sequenceName]);
    } else {
      await client.query("select setval($1::regclass, $2, true)", [sequenceName, maxValue]);
    }
  }
}

async function insertRows(client, tableName, columns, rows) {
  if (!rows.length) return;
  const insertColumns = columns.filter((column) =>
    rows.some((row) => Object.prototype.hasOwnProperty.call(row, column.column_name))
  );
  const identityColumns = insertColumns.filter((column) => column.is_identity === "YES");
  const prefix = `insert into public.${quoteIdent(tableName)} (${insertColumns.map((column) => quoteIdent(column.column_name)).join(", ")})`
    + (identityColumns.length ? " overriding system value" : "");

  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    const values = [];
    const tuples = chunk.map((row) => {
      const placeholders = insertColumns.map((column) => {
        values.push(normalizeValue(row[column.column_name], column));
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await client.query(`${prefix} values ${tuples.join(", ")}`, values);
  }
  await resetIdentitySequences(client, tableName, identityColumns);
}

async function restoreWorkItemParents(client, parentLinks) {
  for (let start = 0; start < parentLinks.length; start += INSERT_CHUNK_SIZE) {
    const chunk = parentLinks.slice(start, start + INSERT_CHUNK_SIZE);
    await client.query(
      `update public.work_items as item
          set parent_id = links.parent_id
         from unnest($1::uuid[], $2::uuid[]) as links(id, parent_id)
        where item.id = links.id`,
      [chunk.map((link) => link.id), chunk.map((link) => link.parentId)],
    );
  }
}

function findPgDump() {
  const candidates = [
    process.env.PG_DUMP,
    "/opt/homebrew/bin/pg_dump",
    "/opt/homebrew/opt/postgresql@17/bin/pg_dump",
    "/opt/homebrew/opt/postgresql@16/bin/pg_dump",
    "/opt/homebrew/opt/libpq/bin/pg_dump",
    "/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation.
    }
  }
  throw new Error("pg_dump is required for replacement mode; set PG_DUMP to its absolute path");
}

function backupLocalDatabase(localTarget, backupDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDir, `${LOCAL_DATABASE_NAME}-${timestamp}.dump`);
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const result = spawnSync(findPgDump(), [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--host=${localTarget.hostname}`,
    `--port=${localTarget.port}`,
    `--dbname=${localTarget.databaseName}`,
    `--file=${backupPath}`,
    ...(localTarget.username ? [`--username=${localTarget.username}`] : []),
  ], {
    env: { ...process.env, ...(localTarget.password ? { PGPASSWORD: localTarget.password } : {}) },
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error) throw new Error(`pg_dump could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pg_dump failed: ${(result.stderr || "unknown error").trim()}`);
  if (statSync(backupPath).size === 0) throw new Error("pg_dump produced an empty backup file");
  return backupPath;
}

async function assertImportedCounts(client, rowsByTable) {
  const errors = [];
  for (const tableName of TABLE_NAMES) {
    const result = await client.query(`select count(*)::bigint as count from public.${quoteIdent(tableName)}`);
    const actual = Number(result.rows[0].count);
    const expected = (rowsByTable.get(tableName) || []).length;
    if (actual !== expected) errors.push(`${tableName}: expected ${expected}, found ${actual}`);
  }
  if (errors.length) throw new Error(`Post-import count verification failed: ${errors.join("; ")}`);
}

export async function main(args = process.argv.slice(2)) {
  loadEnv(resolve(process.cwd(), ".env.local"));
  const options = parseSyncArguments(args, { homeDirectory: homedir() });
  const cloudUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const cloudServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const localDbUrl = process.env.MISSION_CONTROL_DATABASE_URL;
  if (!localDbUrl) throw new Error("Missing MISSION_CONTROL_DATABASE_URL; there is no database fallback");
  const localTarget = parseLocalDatabaseUrl(localDbUrl);
  const local = new PgClient({ connectionString: localDbUrl });

  try {
    await local.connect();
    await verifyLocalDatabaseTarget(local);
    const mode = decideSyncMode(await getNonEmptyLocalTables(local), options.replaceLocalData);
    if (!cloudUrl || !cloudServiceRoleKey) {
      throw new Error("Cloud bootstrap requires NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }

    const cloud = createClient(cloudUrl, cloudServiceRoleKey, { auth: { persistSession: false } });
    const rowsByTable = new Map();
    for (const table of TABLES) {
      const rows = await fetchAllRows(cloud, table);
      rowsByTable.set(table.name, rows);
      console.log(`Fetched ${rows.length} rows from cloud ${table.name}`);
    }

    const columnsByTable = new Map();
    for (const tableName of TABLE_NAMES) columnsByTable.set(tableName, await getLocalColumns(local, tableName));
    const preflightErrors = [
      ...findSchemaImportErrors(rowsByTable, columnsByTable, TABLE_NAMES),
      ...findSemanticImportErrors(rowsByTable),
      ...validateReferenceIntegrity(rowsByTable, REFERENCE_RULES),
    ];
    for (const foreignKey of await getExternalForeignKeys(local)) {
      preflightErrors.push(
        `local table ${foreignKey.child_table} depends on ${foreignKey.parent_table} via ${foreignKey.constraint_name}`,
      );
    }
    if (preflightErrors.length) {
      throw new Error(`Import preflight failed before mutation:\n- ${preflightErrors.join("\n- ")}`);
    }

    const workItems = prepareWorkItemRows(rowsByTable.get("work_items") || []);
    const targets = [...TABLE_NAMES].reverse().map((name) => `public.${quoteIdent(name)}`).join(", ");
    await local.query("begin");
    if (mode === "replace") {
      // Block concurrent writes while pg_dump captures the exact state that may be replaced.
      // SHARE is compatible with pg_dump's reads and blocks concurrent writes.
      await local.query(`lock table ${targets} in share mode`);
      const backupPath = backupLocalDatabase(localTarget, options.backupDir);
      console.log(`Verified full local backup: ${backupPath}`);
      for (const tableName of [...TABLE_NAMES].reverse()) {
        await local.query(`delete from public.${quoteIdent(tableName)}`);
      }
    }
    for (const tableName of TABLE_NAMES) {
      const rows = tableName === "work_items" ? workItems.rowsForInsert : (rowsByTable.get(tableName) || []);
      await insertRows(local, tableName, columnsByTable.get(tableName), rows);
      if (tableName === "work_items") await restoreWorkItemParents(local, workItems.parentLinks);
      console.log(`Inserted ${rows.length} rows into local ${tableName}`);
    }
    await assertImportedCounts(local, rowsByTable);
    await local.query("commit");
    console.log(`Local Mission Control ${mode} complete for ${localTarget.safeDescription}.`);
  } catch (error) {
    await local.query("rollback").catch(() => {});
    throw error;
  } finally {
    await local.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(redactSecrets(error, [process.env.MISSION_CONTROL_DATABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]));
    process.exitCode = 1;
  });
}
