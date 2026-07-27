export const LIVE_OPERATIONAL_DATABASE_NAME = "aipaths_mission_control_local";
export const MISSION_CONTROL_TEST_DATABASE_PREFIX = "aipaths_mission_control_test_";
export const LOOPS_REHEARSAL_DATABASE_PREFIX = "mc_loops_rehearsal_";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const DISPOSABLE_PREFIXES = [
  MISSION_CONTROL_TEST_DATABASE_PREFIX,
  LOOPS_REHEARSAL_DATABASE_PREFIX,
];

function parseUrl(value, variableName) {
  if (!value) throw new Error(`Missing ${variableName}`);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${variableName} must use the postgres or postgresql scheme`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${variableName} must use the exact loopback host 127.0.0.1 or [::1]`);
  }
  // Connection-string query parameters can override parsed fields in some
  // PostgreSQL clients (for example `?host=...`). Refuse all of them so the
  // host/database checks above describe the connection that will be made.
  if (url.search || url.hash) {
    throw new Error(`${variableName} must not contain query parameters or a fragment`);
  }
  return url;
}

export function databaseNameFromUrl(url, variableName = "PostgreSQL URL") {
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${variableName} has an invalid database name encoding`);
  }
  if (!databaseName || databaseName.includes("/")) {
    throw new Error(`${variableName} must identify exactly one database`);
  }
  return databaseName;
}

export function assertLoopbackPostgresUrl(value, variableName = "PostgreSQL URL") {
  const url = parseUrl(value, variableName);
  const databaseName = databaseNameFromUrl(url, variableName);
  if (databaseName === LIVE_OPERATIONAL_DATABASE_NAME) {
    throw new Error(`${variableName} refuses the live operational database ${LIVE_OPERATIONAL_DATABASE_NAME}`);
  }
  return url;
}

export function assertDisposableTestDatabaseUrl(
  value,
  variableName = "MISSION_CONTROL_TEST_DATABASE_URL",
) {
  const url = assertLoopbackPostgresUrl(value, variableName);
  const databaseName = databaseNameFromUrl(url, variableName);
  if (!DISPOSABLE_PREFIXES.some((prefix) => databaseName.startsWith(prefix))) {
    throw new Error(`${variableName} must target a recognized disposable test database`);
  }
  return url;
}

export function requireMissionControlTestDatabaseUrl(env = process.env) {
  const variableName = "MISSION_CONTROL_TEST_DATABASE_URL";
  return assertDisposableTestDatabaseUrl(env[variableName], variableName).toString();
}
