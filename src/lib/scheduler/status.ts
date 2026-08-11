import { LAUNCHER_SCHEDULE_MINUTES } from "./config.ts";
import { PUBLISH_BLOG_DISPATCHER_CRON_NAME } from "../work-items/publish-blog-dispatcher.ts";

export type WorkItemSchedulerHealth = {
  enabled?: boolean | null;
  schedule?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  rows_affected?: number | null;
};

type SchedulerHealthState = "healthy" | "unknown" | "degraded";
const HEALTH_FRESHNESS_SECONDS = 660;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

export function buildWorkItemSchedulerStatus(
  health: WorkItemSchedulerHealth | null,
  healthError: unknown = null,
  now = new Date(),
) {
  const observationError = healthError ? `cron_health unavailable: ${errorMessage(healthError)}` : null;
  const missingHealthError = !healthError && !health ? "Dispatcher health missing" : null;
  const enabledKnown = !healthError && health !== null && typeof health.enabled === "boolean";
  const enabledError = !healthError && health && !enabledKnown
    ? "Dispatcher health enabled flag missing or invalid"
    : null;
  const enabled = enabledKnown ? health.enabled === true : false;
  const lastStatus = healthError ? "unknown" : health?.last_status || "unknown";
  const lastRunAt = healthError ? null : health?.last_run_at || null;
  const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  const freshnessMs = HEALTH_FRESHNESS_SECONDS * 1_000;
  const fresh = enabled && Number.isFinite(lastRunMs)
    ? now.getTime() - lastRunMs <= freshnessMs && lastRunMs <= now.getTime() + 60_000
    : false;
  const freshnessError = enabled && lastStatus !== "unknown" && !fresh
    ? `Dispatcher health stale: last run exceeds ${HEALTH_FRESHNESS_SECONDS} seconds`
    : null;
  const unknownStatusError = enabled && lastStatus === "unknown"
    ? "Dispatcher health status missing or unknown"
    : null;
  const healthState: SchedulerHealthState = observationError || missingHealthError || enabledError || lastStatus === "unknown"
    ? "unknown"
    : lastStatus === "error" || freshnessError
      ? "degraded"
      : "healthy";
  const degraded = Boolean(
    observationError || missingHealthError || enabledError || unknownStatusError || lastStatus === "error" || freshnessError,
  );

  return {
    cron_name: PUBLISH_BLOG_DISPATCHER_CRON_NAME,
    enabled,
    schedule: health?.schedule || `every ${LAUNCHER_SCHEDULE_MINUTES} min`,
    schedule_minutes: LAUNCHER_SCHEDULE_MINUTES,
    state: degraded ? "degraded" : enabled ? "scheduled" : "paused",
    health: healthState,
    last_run_at: lastRunAt,
    last_status: lastStatus,
    last_error: observationError || missingHealthError || enabledError || health?.last_error || unknownStatusError || freshnessError || null,
    rows_affected: healthError ? 0 : health?.rows_affected ?? 0,
    fresh: enabled ? fresh : enabledKnown ? null : false,
    freshness_seconds: HEALTH_FRESHNESS_SECONDS,
  };
}

/** cron_health from runtime-workers is both control observation and liveness. */
export function buildSchedulerStatusResponse(
  health: WorkItemSchedulerHealth | null,
  healthError: unknown = null,
  now = new Date(),
) {
  return {
    status: 200,
    body: buildWorkItemSchedulerStatus(health, healthError, now),
  };
}
