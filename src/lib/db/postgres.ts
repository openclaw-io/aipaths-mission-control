import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const DEFAULT_DATABASE_URL = "postgres://joaco@127.0.0.1:5432/aipaths_mission_control_local";

declare global {
  // eslint-disable-next-line no-var
  var __missionControlPgPool: Pool | undefined;
}

export const missionControlDatabaseUrl = process.env.MISSION_CONTROL_DATABASE_URL || DEFAULT_DATABASE_URL;

export function getPostgresPool() {
  if (!globalThis.__missionControlPgPool) {
    globalThis.__missionControlPgPool = new Pool({
      connectionString: missionControlDatabaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  return globalThis.__missionControlPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return getPostgresPool().query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client as never);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
