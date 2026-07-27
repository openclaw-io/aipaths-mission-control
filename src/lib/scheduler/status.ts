import { LAUNCHER_SCHEDULE_MINUTES } from "./config.ts";

export type SchedulerConfigRow = {
  key: string;
  value: string;
};

export type WorkItemSchedulerHealth = {
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  rows_affected?: number | null;
};

type SchedulerHealthState = "healthy" | "unknown" | "degraded";

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

function inspectControl(config: Record<string, string>) {
  const errors: string[] = [];
  let enabled = false;
  if (config.enabled === "true") enabled = true;
  else if (config.enabled !== "false") errors.push('enabled must be exactly "true" or "false"');

  const scheduleMinutes = /^\d+$/.test(config.schedule_minutes || "")
    ? Number(config.schedule_minutes)
    : Number.NaN;
  if (!Number.isSafeInteger(scheduleMinutes) || scheduleMinutes !== LAUNCHER_SCHEDULE_MINUTES) {
    errors.push(`schedule_minutes must match launchd StartInterval (${LAUNCHER_SCHEDULE_MINUTES})`);
  }

  return { enabled, error: errors.length > 0 ? `Invalid scheduler config: ${errors.join("; ")}` : null };
}

export function buildWorkItemSchedulerStatus(
  configRows: SchedulerConfigRow[],
  health: WorkItemSchedulerHealth | null,
  healthError: unknown = null,
) {
  const config = Object.fromEntries(configRows.map(({ key, value }) => [key, value]));
  const control = inspectControl(config);
  const observationError = healthError ? `cron_health unavailable: ${errorMessage(healthError)}` : null;
  const lastStatus = healthError ? "unknown" : health?.last_status || "unknown";
  const healthState: SchedulerHealthState = healthError || lastStatus === "unknown"
    ? "unknown"
    : lastStatus === "error"
      ? "degraded"
      : "healthy";
  const degraded = Boolean(control.error || observationError || lastStatus === "error");

  return {
    cron_name: "work-item-scheduler",
    enabled: control.enabled,
    schedule: `every ${LAUNCHER_SCHEDULE_MINUTES} min`,
    schedule_minutes: LAUNCHER_SCHEDULE_MINUTES,
    state: degraded ? "degraded" : control.enabled ? "scheduled" : "paused",
    health: healthState,
    last_run_at: healthError ? null : health?.last_run_at || null,
    last_status: lastStatus,
    last_error: control.error || observationError || health?.last_error || null,
    rows_affected: healthError ? 0 : health?.rows_affected ?? 0,
  };
}

/** Endpoint control policy: cron_health is observation, never availability. */
export function buildSchedulerStatusResponse(
  configRows: SchedulerConfigRow[],
  health: WorkItemSchedulerHealth | null,
  healthError: unknown = null,
) {
  return {
    status: 200,
    body: buildWorkItemSchedulerStatus(configRows, health, healthError),
  };
}
