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

const DEFAULT_SCHEDULE_MINUTES = 10;

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildWorkItemSchedulerStatus(
  configRows: SchedulerConfigRow[],
  health: WorkItemSchedulerHealth | null,
) {
  const config = Object.fromEntries(configRows.map(({ key, value }) => [key, value]));
  const enabled = config.enabled !== "false";
  const scheduleMinutes = positiveNumber(config.schedule_minutes, DEFAULT_SCHEDULE_MINUTES);
  const lastStatus = health?.last_status || "unknown";

  return {
    cron_name: "work-item-scheduler",
    enabled,
    schedule: `every ${scheduleMinutes} min`,
    schedule_minutes: scheduleMinutes,
    state: enabled ? (lastStatus === "error" ? "degraded" : "scheduled") : "paused",
    last_run_at: health?.last_run_at || null,
    last_status: lastStatus,
    last_error: health?.last_error || null,
    rows_affected: health?.rows_affected ?? 0,
  };
}
