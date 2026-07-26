export const LOCAL_DATABASE_NAME = "aipaths_mission_control_local";
export const REPLACE_CONFIRMATION = `--replace-local-data=${LOCAL_DATABASE_NAME}`;

export function parseLocalDatabaseUrl(databaseUrl) {
  const authorityMatch = String(databaseUrl).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/);
  const authority = authorityMatch?.[1] || "";
  const rawHostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!/^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(rawHostPort)) {
    throw new Error("MISSION_CONTROL_DATABASE_URL must use the exact loopback host 127.0.0.1 or [::1]");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("MISSION_CONTROL_DATABASE_URL must be a valid local Postgres URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("MISSION_CONTROL_DATABASE_URL must use the Postgres URL scheme");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error("MISSION_CONTROL_DATABASE_URL must use the exact loopback host 127.0.0.1 or [::1]");
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("MISSION_CONTROL_DATABASE_URL has an invalid database name encoding");
  }
  if (databaseName !== LOCAL_DATABASE_NAME || parsed.pathname.split("/").length !== 2) {
    throw new Error(`MISSION_CONTROL_DATABASE_URL must target the exact database ${LOCAL_DATABASE_NAME}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error("MISSION_CONTROL_DATABASE_URL must not contain query parameters or a fragment");
  }
  const port = parsed.port || "5432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("MISSION_CONTROL_DATABASE_URL has an invalid port");
  }

  return {
    hostname: parsed.hostname === "[::1]" ? "::1" : parsed.hostname,
    port,
    databaseName,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    safeDescription: `${parsed.hostname}:${port}/${databaseName}`,
  };
}

export function parseSyncArguments(args, { homeDirectory } = {}) {
  let replaceLocalData = false;
  let backupDir = `${homeDirectory || "~"}/Library/Application Support/AIPaths Mission Control/backups`;
  for (const argument of args) {
    if (argument === REPLACE_CONFIRMATION) {
      replaceLocalData = true;
    } else if (argument.startsWith("--backup-dir=")) {
      backupDir = argument.slice("--backup-dir=".length);
      if (!backupDir) throw new Error("--backup-dir requires a path");
      if (!backupDir.startsWith("/")) throw new Error("--backup-dir must be an absolute path");
    } else {
      throw new Error(`Unknown argument. Replacement requires the exact confirmation ${REPLACE_CONFIRMATION}`);
    }
  }
  if (args.some((argument) => argument.startsWith("--backup-dir=")) && !replaceLocalData) {
    throw new Error(`--backup-dir is only valid with ${REPLACE_CONFIRMATION}`);
  }
  return { replaceLocalData, backupDir };
}

export function decideSyncMode(nonEmptyTables, replaceLocalData) {
  if (!nonEmptyTables.length) return "bootstrap";
  if (!replaceLocalData) {
    const summary = nonEmptyTables.map(({ tableName, rowCount }) => `${tableName}=${rowCount}`).join(", ");
    throw new Error(
      `Refusing to touch a non-empty local database (${summary}). `
      + `To replace it only after a full backup, pass ${REPLACE_CONFIRMATION}`,
    );
  }
  return "replace";
}

export function prepareWorkItemRows(rows) {
  const rowsForInsert = [];
  const parentLinks = [];
  for (const row of rows) {
    if (row.parent_id != null) parentLinks.push({ id: row.id, parentId: row.parent_id });
    rowsForInsert.push({ ...row, parent_id: null });
  }
  return { rowsForInsert, parentLinks };
}

export function validateReferenceIntegrity(rowsByTable, rules) {
  const errors = [];
  for (const [sourceTable, sourceColumn, targetTable, targetColumn] of rules) {
    const targetIds = new Set(
      (rowsByTable.get(targetTable) || [])
        .filter((row) => row[targetColumn] != null)
        .map((row) => String(row[targetColumn])),
    );
    for (const row of rowsByTable.get(sourceTable) || []) {
      const value = row[sourceColumn];
      if (value == null) continue;
      if (!targetIds.has(String(value))) {
        errors.push(`${sourceTable}.${sourceColumn}=${value} has no imported ${targetTable}.${targetColumn}`);
      }
    }
  }
  return errors;
}

export function findSchemaImportErrors(rowsByTable, columnsByTable, tableNames) {
  const errors = [];
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) || [];
    if (!columns.length) {
      errors.push(`local table public.${tableName} is missing`);
      continue;
    }
    const rows = rowsByTable.get(tableName) || [];
    const localColumnNames = new Set(columns.map((column) => column.column_name));
    const cloudColumnNames = new Set(rows.flatMap((row) => Object.keys(row)));
    for (const cloudColumn of cloudColumnNames) {
      if (!localColumnNames.has(cloudColumn)) {
        errors.push(`${tableName}.${cloudColumn} exists in cloud but not in the local schema`);
      }
    }
    for (const column of columns) {
      if (column.is_nullable !== "NO" || column.column_default != null || column.is_identity === "YES") continue;
      for (const [index, row] of rows.entries()) {
        if (!Object.prototype.hasOwnProperty.call(row, column.column_name) || row[column.column_name] == null) {
          errors.push(`${tableName}[${index}] cannot supply required local column ${column.column_name}`);
          break;
        }
      }
    }
  }
  return errors;
}

export function findSemanticImportErrors(rowsByTable) {
  const errors = [];
  const journalKeys = new Set();
  for (const row of rowsByTable.get("memories") || []) {
    if (row.type !== "journal") continue;
    const key = `${row.agent}|${row.type}|${row.date}`;
    if (journalKeys.has(key)) {
      errors.push(`memories contains duplicate journal key ${key}; refusing to discard either row`);
    }
    journalKeys.add(key);
  }
  return errors;
}

export function sanitizeRows(_tableName, rows) {
  // Deliberately lossless. Import incompatibilities belong in preflight, never
  // in a sanitizer that drops rows or nulls foreign keys.
  return rows;
}

export function redactSecrets(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(String(secret)).join("[REDACTED]");
  return message.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
}

export function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}
