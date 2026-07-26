const CONTROL_STATEMENT = /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SET\s+LOCAL\b)/i;

/** Split PostgreSQL SQL only at top-level semicolons.
 * Handles quoted identifiers/strings, nested block comments, line comments, and
 * dollar-quoted DO/function bodies ($$ and $tag$).
 */
export function splitTopLevelSql(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let state = "normal";
  let dollarTag = "";
  let blockDepth = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "normal";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "'" && next === "'") index += 2;
      else if (char === "'") { state = "normal"; index += 1; }
      else index += 1;
      continue;
    }
    if (state === "double-quote") {
      if (char === '"' && next === '"') index += 2;
      else if (char === '"') { state = "normal"; index += 1; }
      else index += 1;
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "normal";
      } else index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line-comment";
      index += 2;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      blockDepth = 1;
      index += 2;
    } else if (char === "'") {
      state = "single-quote";
      index += 1;
    } else if (char === '"') {
      state = "double-quote";
      index += 1;
    } else if (char === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar-quote";
        index += dollarTag.length;
      } else index += 1;
    } else if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
      index += 1;
    } else index += 1;
  }

  if (state === "single-quote" || state === "double-quote" || state === "dollar-quote" || state === "block-comment") {
    throw new Error(`Unterminated SQL ${state}`);
  }
  const trailing = sql.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function executableText(statement) {
  return statement
    .replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u, "")
    .trim();
}

export function isSqlEditorControlStatement(statement) {
  return CONTROL_STATEMENT.test(executableText(statement));
}

/** Execute one query call per top-level statement. With node-postgres default
 * autocommit this gives every statement its own transaction, matching SQL Editor
 * statement-by-statement behavior (including ON COMMIT DROP after CREATE TEMP).
 */
export async function executeSqlEditorStatements(client, sql, {
  label = "SQL",
  ignoreControlStatements = true,
  afterStatement,
} = {}) {
  const statements = splitTopLevelSql(sql);
  let executed = 0;
  let ignored = 0;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (ignoreControlStatements && isSqlEditorControlStatement(statement)) {
      ignored += 1;
      continue;
    }
    try {
      await client.query(statement);
    } catch (error) {
      error.message = `${label} statement ${index + 1}/${statements.length} failed: ${error.message}`;
      error.sqlEditorStatementIndex = index;
      error.sqlEditorStatement = statement;
      throw error;
    }
    executed += 1;
    await afterStatement?.({ index, statement, total: statements.length, executed });
  }
  return { total: statements.length, executed, ignored };
}
