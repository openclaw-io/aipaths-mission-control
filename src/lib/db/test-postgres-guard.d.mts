export const LIVE_OPERATIONAL_DATABASE_NAME: string;
export const MISSION_CONTROL_TEST_DATABASE_PREFIX: string;
export const LOOPS_REHEARSAL_DATABASE_PREFIX: string;

export function databaseNameFromUrl(url: URL, variableName?: string): string;
export function assertLoopbackPostgresUrl(value: string | undefined, variableName?: string): URL;
export function assertDisposableTestDatabaseUrl(value: string | undefined, variableName?: string): URL;
export function requireMissionControlTestDatabaseUrl(env?: NodeJS.ProcessEnv): string;
