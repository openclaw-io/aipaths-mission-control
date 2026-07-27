import { LAUNCHER_SCHEDULE_MINUTES, inspectSchedulerConfigRows } from "./config.ts";

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

export function buildWorkItemSchedulerStatus(
  configRows: SchedulerConfigRow[],
  health: WorkItemSchedulerHealth | null,
  healthError: unknown = null,
) {
  const control = inspectSchedulerConfigRows(configRows);
  const controlError = control.valid ? null : `Invalid scheduler config: ${control.errors.join("; ")}`;
  const enabled = control.enabled === true;
  const observationError = healthError ? `cron_health unavailable: ${errorMessage(healthError)}` : null;
  const lastStatus = healthError ? "unknown" : health?.last_status || "unknown";
  const healthState: SchedulerHealthState = healthError || lastStatus === "unknown"
    ? "unknown"
    : lastStatus === "error"
      ? "degraded"
      : "healthy";
  const degraded = Boolean(controlError || observationError || lastStatus === "error");

  return {
    cron_name: "work-item-scheduler",
    enabled,
    schedule: `every ${LAUNCHER_SCHEDULE_MINUTES} min`,
    schedule_minutes: LAUNCHER_SCHEDULE_MINUTES,
    state: degraded ? "degraded" : enabled ? "scheduled" : "paused",
    health: healthState,
    last_run_at: healthError ? null : health?.last_run_at || null,
    last_status: lastStatus,
    last_error: controlError || observationError || health?.last_error || null,
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
