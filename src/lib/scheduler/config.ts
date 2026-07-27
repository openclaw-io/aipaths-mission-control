export const LAUNCHER_SCHEDULE_MINUTES = 5;

export const SCHEDULER_CONFIG_KEYS = [
  "enabled",
  "max_concurrent",
  "daily_budget_usd",
  "schedule_minutes",
] as const;

type SchedulerConfigKey = (typeof SCHEDULER_CONFIG_KEYS)[number];
type SchedulerPatch = Partial<Record<SchedulerConfigKey, string>>;
type SchedulerConfigRow = { key: string; value: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBoolean(value: unknown) {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  throw new Error('enabled must be exactly true, false, "true", or "false"');
}

function parseInteger(value: unknown, field: string, min: number, max: number) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseSchedulerPatch(body: unknown): SchedulerPatch {
  if (!isPlainObject(body)) throw new Error("Scheduler config body must be an object");
  const entries = Object.entries(body);
  if (entries.length === 0) throw new Error("Scheduler config body must not be empty");

  const allowed = new Set<string>(SCHEDULER_CONFIG_KEYS);
  const patch: SchedulerPatch = {};
  for (const [key, value] of entries) {
    if (!allowed.has(key)) throw new Error(`Unknown scheduler config field: ${key}`);
    if (key === "enabled") {
      patch.enabled = parseBoolean(value);
    } else if (key === "max_concurrent") {
      patch.max_concurrent = String(parseInteger(value, key, 1, 10));
    } else if (key === "daily_budget_usd") {
      patch.daily_budget_usd = String(parseInteger(value, key, 1, 100_000));
    } else if (key === "schedule_minutes") {
      const schedule = parseInteger(value, key, 1, 1440);
      if (schedule !== LAUNCHER_SCHEDULE_MINUTES) {
        throw new Error(`schedule_minutes must match launchd StartInterval (${LAUNCHER_SCHEDULE_MINUTES})`);
      }
      patch.schedule_minutes = String(schedule);
    }
  }
  return patch;
}

function responseInteger(value: unknown, fallback: number, min: number, max: number) {
  try {
    return parseInteger(value, "scheduler config value", min, max);
  } catch {
    return fallback;
  }
}

/** Typed API representation used by the UI; persisted values remain text. */
export function buildSchedulerConfigResponse(rows: SchedulerConfigRow[]) {
  const values = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  return {
    enabled: values.enabled === "true",
    max_concurrent: responseInteger(values.max_concurrent, 2, 1, 10),
    daily_budget_usd: responseInteger(values.daily_budget_usd, 50, 1, 100_000),
    // The launcher is the execution authority. Never advertise a corrupt DB cadence.
    schedule_minutes: LAUNCHER_SCHEDULE_MINUTES,
  };
}
