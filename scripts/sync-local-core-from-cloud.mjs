#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const { Client: PgClient } = pg;
const DEFAULT_LOCAL_DB = "postgres://joaco@127.0.0.1:5432/aipaths_mission_control_local";
const EXPECTED_LOCAL_DB = "aipaths_mission_control_local";
const PAGE_SIZE = 1000;
const INSERT_CHUNK_SIZE = 200;
const PRESERVE_IDENTITY_TABLES = new Set([
  "intel_sources",
  "competitor_channels",
  "competitor_transcripts",
  "intel_runs",
  "intel_items_raw",
  "intel_items_enriched",
  "competitor_video_snapshots",
]);

const TABLES = [
  { name: "loops", orderBy: "created_at" },
  { name: "work_items", orderBy: "created_at" },
  { name: "loop_events", orderBy: "created_at" },
  { name: "loop_work_items", orderBy: "created_at" },
  { name: "recurring_work_rules", orderBy: "created_at" },
  { name: "activity_log", orderBy: "created_at" },
  { name: "memories", orderBy: "created_at" },
  { name: "usage_logs", orderBy: "created_at" },
  { name: "ops_daily_snapshots", orderBy: "date" },
  { name: "academy_daily_kpis", orderBy: "date" },
  { name: "pipeline_items", orderBy: "created_at" },
  { name: "ops_owned_videos", orderBy: "published_at" },
  { name: "ops_youtube_video_learning_snapshots", orderBy: "computed_at" },
  { name: "intel_sources", orderBy: "id" },
  { name: "competitor_channels", orderBy: "id" },
  { name: "competitor_transcripts", orderBy: "id" },
  { name: "intel_runs", orderBy: "id" },
  { name: "intel_items_raw", orderBy: "id" },
  { name: "intel_items_enriched", orderBy: "id" },
  { name: "competitor_video_snapshots", orderBy: "id" },
  { name: "intel_inbox_reviews", orderBy: "created_at" },
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
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // optional
  }
}

loadEnv(resolve(process.cwd(), ".env.local"));

const cloudUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const cloudServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const localDbUrl = process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_LOCAL_DB;

if (!cloudUrl || !cloudServiceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

function parseLocalDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Malformed local database URL: ${value}`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname) || database !== EXPECTED_LOCAL_DB) {
    throw new Error(`Expected a loopback PostgreSQL URL for database ${EXPECTED_LOCAL_DB}`);
  }
  return parsed;
}

try {
  parseLocalDatabaseUrl(localDbUrl);
} catch (error) {
  console.error(`Refusing to run against non-local database URL: ${localDbUrl}`);
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}

const cloud = createClient(cloudUrl, cloudServiceRoleKey, { auth: { persistSession: false } });
const local = new PgClient({ connectionString: localDbUrl });

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

async function getLocalColumns(client, tableName) {
  const result = await client.query(
    `select column_name, data_type, udt_name, is_identity, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [tableName],
  );
  return result.rows;
}

function valueForColumn(tableName, row, column) {
  // Self-referencing parents are restored only after every work_items row exists.
  if (tableName === "work_items" && column.column_name === "parent_id") return null;

  if (Object.prototype.hasOwnProperty.call(row, column.column_name)) {
    const rawValue = row[column.column_name];
    if (Array.isArray(rawValue)) {
      return column.data_type === "ARRAY" ? rawValue : JSON.stringify(rawValue);
    }
    return normalizeValue(rawValue);
  }

  if (tableName === "activity_log" && column.column_name === "metadata") {
    return JSON.stringify({});
  }

  if (tableName === "usage_logs" && column.column_name === "metadata") {
    return JSON.stringify({});
  }

  if ((column.data_type === "json" || column.data_type === "jsonb") && column.is_nullable === "NO") {
    return JSON.stringify({});
  }

  if (column.is_nullable === "NO" && typeof column.column_default === "string") {
    const defaultValue = column.column_default;
    if (/(^|\W)0(\W|$)/.test(defaultValue) && ["integer", "bigint", "numeric", "smallint"].includes(column.data_type)) {
      return 0;
    }
    if (column.data_type === "boolean") {
      if (defaultValue.includes("true")) return true;
      if (defaultValue.includes("false")) return false;
    }
    const textMatch = defaultValue.match(/^'(.*)'::/);
    if (textMatch && ["text", "character varying", "character"].includes(column.data_type)) {
      return textMatch[1];
    }
  }

  if (column.is_nullable === "NO" && column.data_type.includes("timestamp")) {
    return row.updated_at || row.created_at || new Date().toISOString();
  }

  return null;
}

async function fetchAllRows(table) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await cloud
      .from(table.name)
      .select("*")
      .order(table.orderBy, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`${table.name}: ${error.message}`);

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return sanitizeRows(table.name, rows);
}

function sanitizeRows(tableName, rows) {
  if (tableName !== "memories") return rows;

  const passthrough = [];
  const journalByKey = new Map();

  for (const row of rows) {
    if (row.type !== "journal") {
      passthrough.push(row);
      continue;
    }

    const key = `${row.agent}|${row.type}|${row.date}`;
    const current = journalByKey.get(key);
    if (!current) {
      journalByKey.set(key, row);
      continue;
    }

    const currentCreatedAt = new Date(current.created_at || 0).getTime();
    const candidateCreatedAt = new Date(row.created_at || 0).getTime();
    if (candidateCreatedAt >= currentCreatedAt) {
      journalByKey.set(key, row);
    }
  }

  return [...passthrough, ...journalByKey.values()];
}

function sanitizeCrossTableRows(rowsByTable) {
  const rawIds = new Set((rowsByTable.get("intel_items_raw") || []).map((row) => Number(row.id)));
  const enrichedRows = rowsByTable.get("intel_items_enriched") || [];
  let orphanedReferences = 0;

  const sanitizedEnrichedRows = enrichedRows.map((row) => {
    const rawItemId = Number(row.raw_item_id);
    if (row.raw_item_id == null || rawIds.has(rawItemId)) return row;
    orphanedReferences += 1;
    return {
      ...row,
      raw_item_id: null,
      metadata_json: {
        ...(row.metadata_json || {}),
        local_sync_orphaned_raw_item_id: rawItemId,
      },
    };
  });

  rowsByTable.set("intel_items_enriched", sanitizedEnrichedRows);
  if (orphanedReferences > 0) {
    console.log(`Sanitized ${orphanedReferences} orphaned intel_items_enriched.raw_item_id references`);
  }
}

function assertWorkItemParentsResolvable(rows) {
  const ids = new Set(rows.map((row) => row.id));
  const missing = rows.filter((row) => row.parent_id != null && !ids.has(row.parent_id));
  if (missing.length) {
    throw new Error(`work_items: ${missing.length} parent_id references are absent from the cloud import set`);
  }
}

async function restoreWorkItemParents(client, rows) {
  for (const row of rows) {
    if (row.parent_id == null) continue;
    await client.query(`update "work_items" set parent_id = $1 where id = $2`, [row.parent_id, row.id]);
  }
}

async function verifyLocalDatabaseTarget(client) {
  const result = await client.query(
    `select current_database() as database_name, inet_server_addr()::text as server_address`,
  );
  const target = result.rows[0] || {};
  const address = target.server_address;
  const loopback = address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
  if (target.database_name !== EXPECTED_LOCAL_DB || !loopback) {
    throw new Error(`Connected target verification failed (database=${target.database_name}, server=${address})`);
  }
}

async function assertNoExternalReferencingForeignKeys(client) {
  const tableNames = TABLES.map((table) => table.name);
  const result = await client.query(
    `select c.conname,
            child_ns.nspname || '.' || child.relname as child_table,
            parent_ns.nspname || '.' || parent.relname as parent_table
       from pg_constraint c
       join pg_class child on child.oid = c.conrelid
       join pg_namespace child_ns on child_ns.oid = child.relnamespace
       join pg_class parent on parent.oid = c.confrelid
       join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
      where c.contype = 'f'
        and parent_ns.nspname = 'public' and parent.relname = any($1::text[])
        and not (child_ns.nspname = 'public' and child.relname = any($1::text[]))
      order by child_table, c.conname`,
    [tableNames],
  );
  if (result.rows.length) {
    const detail = result.rows.map((row) => `${row.conname}: ${row.child_table} -> ${row.parent_table}`).join(", ");
    throw new Error(`Sync aborted: external foreign key(s) reference the replacement set; no out-of-set rows will be changed: ${detail}`);
  }
}

async function insertRows(client, tableName, columns, rows) {
  if (!rows.length) return;

  const preserveIdentity = PRESERVE_IDENTITY_TABLES.has(tableName);
  const insertColumns = columns.filter((column) => preserveIdentity || column.is_identity !== "YES");
  const quotedColumns = insertColumns.map((column) => `"${column.column_name}"`).join(", ");
  const insertPrefix = preserveIdentity
    ? `insert into "${tableName}" (${quotedColumns}) overriding system value`
    : `insert into "${tableName}" (${quotedColumns})`;

  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    const values = [];
    const tuples = chunk.map((row, rowIndex) => {
      const placeholders = insertColumns.map((column, columnIndex) => {
        values.push(valueForColumn(tableName, row, column));
        return `$${rowIndex * insertColumns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await client.query(`${insertPrefix} values ${tuples.join(", ")}`, values);
  }

  if (preserveIdentity) {
    await client.query(
      `select setval(
         pg_get_serial_sequence('public."${tableName}"', 'id'),
         coalesce((select max(id) from "${tableName}"), 1),
         true
       )`
    );
  }
}

function assertNoUnmappedCloudColumns(tableName, columns, rows) {
  const localColumns = new Set(columns.map((column) => column.column_name));
  const unmapped = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!localColumns.has(key)) unmapped.add(key);
    }
  }
  if (unmapped.size) {
    throw new Error(`${tableName}: unmapped cloud columns: ${[...unmapped].sort().join(", ")}`);
  }
}

async function assertImportedCounts(client, expectedCounts) {
  for (const table of TABLES) {
    const expected = expectedCounts.get(table.name) || 0;
    const result = await client.query(`select count(*)::integer as count from "${table.name}"`);
    const actual = Number(result.rows[0]?.count || 0);
    if (actual !== expected) {
      throw new Error(`${table.name}: count assertion failed (cloud=${expected}, local=${actual})`);
    }
    console.log(`Count assertion passed for ${table.name}: ${actual}`);
  }
}

try {
  await local.connect();
  await verifyLocalDatabaseTarget(local);

  const rowsByTable = new Map();
  for (const table of TABLES) {
    const rows = await fetchAllRows(table);
    rowsByTable.set(table.name, rows);
    console.log(`Fetched ${rows.length} rows from cloud ${table.name}`);
  }

  sanitizeCrossTableRows(rowsByTable);
  assertWorkItemParentsResolvable(rowsByTable.get("work_items") || []);

  await local.query("begin");
  await assertNoExternalReferencingForeignKeys(local);
  for (const table of [...TABLES].reverse()) {
    await local.query(`delete from "${table.name}"`);
  }

  for (const table of TABLES) {
    const columns = await getLocalColumns(local, table.name);
    const rows = rowsByTable.get(table.name) || [];
    if (!columns.length) throw new Error(`${table.name}: local table is absent`);
    assertNoUnmappedCloudColumns(table.name, columns, rows);
    await insertRows(local, table.name, columns, rows);
    if (table.name === "work_items") await restoreWorkItemParents(local, rows);
    console.log(`Inserted ${rows.length} rows into local ${table.name}`);
  }

  await assertImportedCounts(
    local,
    new Map(TABLES.map((table) => [table.name, (rowsByTable.get(table.name) || []).length])),
  );

  await local.query("commit");
  console.log("Local Mission Control core sync complete.");
} catch (error) {
  await local.query("rollback").catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await local.end().catch(() => {});
}
