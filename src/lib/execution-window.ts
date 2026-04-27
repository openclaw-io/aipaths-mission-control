import { supabaseAdmin } from "@/lib/supabase/admin";

export type ExecutionWindowOverrideMode = "auto" | "forced_on" | "forced_off";
export type ExecutionWindowBlock = { start: string; end: string };
export type ExecutionWindowSchedule = Record<string, ExecutionWindowBlock[]>;

export type ExecutionWindowConfig = {
  id: string;
  timezone: string;
  base_schedule: ExecutionWindowSchedule;
  override_mode: ExecutionWindowOverrideMode;
  override_until: string | null;
  override_reason: string | null;
  updated_by: string | null;
  updated_at: string;
};

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function getLocalParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === "weekday")?.value.toLowerCase() || "monday";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);

  return { weekday, minutesOfDay: hour * 60 + minute };
}

function parseMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isBlockOpen(block: ExecutionWindowBlock, weekday: string, minutesOfDay: number, previousWeekday: string) {
  const start = parseMinutes(block.start);
  const end = parseMinutes(block.end);

  if (start === end) return true;

  if (start < end) {
    return minutesOfDay >= start && minutesOfDay < end;
  }

  return (
    (weekday === previousWeekday && minutesOfDay < end) ||
    (minutesOfDay >= start)
  );
}

function previousDayKey(dayKey: string) {
  const index = DAY_KEYS.indexOf(dayKey as (typeof DAY_KEYS)[number]);
  return DAY_KEYS[(index - 1 + DAY_KEYS.length) % DAY_KEYS.length];
}

export async function getExecutionWindowConfig(): Promise<ExecutionWindowConfig | null> {
  const { data, error } = await supabaseAdmin
    .from("execution_window_config")
    .select("id, timezone, base_schedule, override_mode, override_until, override_reason, updated_by, updated_at")
    .eq("id", "global")
    .maybeSingle();

  if (error) throw error;
  return (data as ExecutionWindowConfig | null) || null;
}

export function isExecutionWindowOpenNow(config: ExecutionWindowConfig, now = new Date()) {
  if (config.override_mode === "forced_on" && config.override_until) {
    if (new Date(config.override_until).getTime() > now.getTime()) {
      return { open: true, source: "override" as const, mode: "forced_on" as const };
    }
  }

  if (config.override_mode === "forced_off" && config.override_until) {
    if (new Date(config.override_until).getTime() > now.getTime()) {
      return { open: false, source: "override" as const, mode: "forced_off" as const };
    }
  }

  const { weekday, minutesOfDay } = getLocalParts(now, config.timezone);
  const currentBlocks = config.base_schedule?.[weekday] || [];
  const prevDay = previousDayKey(weekday);
  const previousBlocks = config.base_schedule?.[prevDay] || [];

  const openCurrent = currentBlocks.some((block) => isBlockOpen(block, weekday, minutesOfDay, prevDay));
  const openPrevious = previousBlocks.some((block) => {
    const start = parseMinutes(block.start);
    const end = parseMinutes(block.end);
    return start > end && minutesOfDay < end;
  });

  return {
    open: openCurrent || openPrevious,
    source: "schedule" as const,
    mode: "auto" as const,
  };
}
