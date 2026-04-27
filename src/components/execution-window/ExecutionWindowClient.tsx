"use client";

import { useEffect, useState } from "react";
import type { ExecutionWindowConfig, ExecutionWindowSchedule } from "@/lib/execution-window";

const DAY_ORDER = [
  ["monday", "Mon"],
  ["tuesday", "Tue"],
  ["wednesday", "Wed"],
  ["thursday", "Thu"],
  ["friday", "Fri"],
  ["saturday", "Sat"],
  ["sunday", "Sun"],
] as const;

const HOURS = [...Array.from({ length: 15 }, (_, i) => i + 9), ...Array.from({ length: 9 }, (_, i) => i)];
const MODE_OPTIONS = [
  { value: "forced_on", label: "On" },
  { value: "auto", label: "Auto" },
  { value: "forced_off", label: "Off" },
] as const;

type ModeValue = (typeof MODE_OPTIONS)[number]["value"];

function padHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function getNowPartsInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const dayKey = parts.find((p) => p.type === "weekday")?.value.toLowerCase() || "monday";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);

  return { dayKey, hour, minute };
}

function buildHourlySchedule(baseSchedule: ExecutionWindowSchedule) {
  const next: Record<string, boolean[]> = {};

  for (const [dayKey] of DAY_ORDER) {
    next[dayKey] = Array.from({ length: 24 }, (_, hour) => {
      const blocks = baseSchedule?.[dayKey] || [];
      return blocks.some((block) => {
        const [startHour] = block.start.split(":").map(Number);
        const [endHour] = block.end.split(":").map(Number);
        if (startHour === endHour) return true;
        if (startHour < endHour) return hour >= startHour && hour < endHour;
        return hour >= startHour || hour < endHour;
      });
    });
  }

  return next;
}

function buildScheduleFromHourly(hourly: Record<string, boolean[]>) {
  const next: ExecutionWindowSchedule = {};

  for (const [dayKey] of DAY_ORDER) {
    const hours = hourly[dayKey] || Array(24).fill(false);
    const blocks: Array<{ start: string; end: string }> = [];
    let start: number | null = null;

    for (let i = 0; i <= 24; i++) {
      const current = i < 24 ? hours[i] : hours[0];
      const previous = i === 0 ? hours[23] : hours[i - 1];

      if (current && !previous && i < 24) start = i;

      if (!current && previous && start !== null) {
        blocks.push({
          start: `${String(start).padStart(2, "0")}:00`,
          end: `${String(i % 24).padStart(2, "0")}:00`,
        });
        start = null;
      }
    }

    next[dayKey] = blocks;
  }

  return next;
}

function overrideUntilForMode(mode: ModeValue) {
  if (mode === "auto") return null;
  return "9999-12-31T23:59:59.000Z";
}

export function ExecutionWindowClient({
  config,
  state,
}: {
  config: ExecutionWindowConfig;
  state: { open: boolean; source: string; mode: string };
}) {
  const [, setNowTick] = useState(() => Date.now());
  const [hourly, setHourly] = useState(() => buildHourlySchedule(config.base_schedule));
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<ModeValue>(config.override_mode as ModeValue);

  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setHourly(buildHourlySchedule(config.base_schedule));
  }, [config.base_schedule]);

  useEffect(() => {
    setMode(config.override_mode as ModeValue);
  }, [config.override_mode]);

  const { dayKey: today, hour: currentHour, minute: currentMinute } = getNowPartsInTimeZone(config.timezone);

  async function patchExecutionWindow(payload: Record<string, unknown>) {
    const res = await fetch("/api/execution-window", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error("Failed to save execution window");
    }
  }

  async function toggleSlot(dayKey: string, hour: number) {
    const nextHourly = {
      ...hourly,
      [dayKey]: hourly[dayKey].map((value, index) => (index === hour ? !value : value)),
    };

    setHourly(nextHourly);
    setSaving(true);

    try {
      await patchExecutionWindow({ base_schedule: buildScheduleFromHourly(nextHourly) });
    } catch (error) {
      console.error(error);
      setHourly(buildHourlySchedule(config.base_schedule));
      alert("No pude guardar el cambio en execution window.");
    } finally {
      setSaving(false);
    }
  }

  async function setExecutionMode(nextMode: ModeValue) {
    const previous = mode;
    setMode(nextMode);
    setSaving(true);

    try {
      await patchExecutionWindow({
        override_mode: nextMode,
        override_until: overrideUntilForMode(nextMode),
        override_reason: nextMode === "auto" ? null : `Set from Execution Window UI (${nextMode})`,
      });
    } catch (error) {
      console.error(error);
      setMode(previous);
      alert("No pude actualizar el modo de execution window.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-800 bg-[#111118] p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold text-white">🕒 Execution Window</h1>
              <div className={`rounded-full border px-3 py-1.5 text-sm ${state.open ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-gray-700 bg-[#0d0d14] text-gray-300"}`}>
                {state.open ? "Active now" : "Inactive now"}
              </div>
              <div className="rounded-full border border-gray-700 bg-[#0d0d14] px-3 py-1.5 text-sm text-gray-300">
                {config.timezone}
              </div>
            </div>
            <p className="text-sm text-gray-500">
              Global schedule and manual overrides for unattended execution materialization
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-full border border-gray-800 bg-[#0d0d14] p-1">
              {MODE_OPTIONS.map((option) => {
                const active = mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setExecutionMode(option.value)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      active
                        ? option.value === "forced_on"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : option.value === "forced_off"
                            ? "bg-rose-500/20 text-rose-300"
                            : "bg-blue-500/20 text-blue-300"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {saving && (
              <div className="rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-sm text-blue-300">
                Saving...
              </div>
            )}
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-gray-800 bg-[#111118] p-4">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Weekly Schedule</h2>
            <p className="text-sm text-gray-500">Click any slot to turn it on or off. Green means open.</p>
          </div>
          <div className="text-xs text-gray-500">Today highlighted</div>
        </div>

        <div className="overflow-x-auto xl:overflow-visible">
          <div className="min-w-[680px] xl:min-w-0">
            <div className="grid grid-cols-[50px_repeat(7,minmax(60px,1fr))] gap-1 xl:grid-cols-[56px_repeat(7,minmax(68px,1fr))]">
              <div />
              {DAY_ORDER.map(([key, label]) => {
                const isToday = key === today;
                return (
                  <div
                    key={key}
                    className={`rounded-lg border px-1.5 py-2 text-center text-[11px] font-medium xl:px-2 xl:text-xs ${
                      isToday
                        ? "border-blue-500/40 bg-blue-500/10 text-blue-200"
                        : "border-gray-800 bg-[#0d0d14] text-gray-300"
                    }`}
                  >
                    {label}
                  </div>
                );
              })}

              {HOURS.map((hour) => (
                <>
                  <div key={`label-${hour}`} className="flex items-center justify-end pr-1 text-[10px] text-gray-500 xl:pr-1.5 xl:text-[11px]">
                    {padHour(hour)}
                  </div>
                  {DAY_ORDER.map(([key]) => {
                    const isOpen = hourly[key]?.[hour] || false;
                    const isToday = key === today;
                    const showNowLine = isToday && hour === currentHour;

                    return (
                      <button
                        key={`${key}-${hour}`}
                        type="button"
                        onClick={() => toggleSlot(key, hour)}
                        className={`relative h-7 rounded-md border transition xl:h-8 ${
                          isOpen
                            ? "border-emerald-500/30 bg-emerald-500/20 hover:bg-emerald-500/30"
                            : isToday
                              ? "border-blue-500/10 bg-blue-500/5 hover:bg-blue-500/10"
                              : "border-gray-800 bg-[#0d0d14] hover:bg-white/5"
                        }`}
                      >
                        {showNowLine && (
                          <div
                            className="pointer-events-none absolute left-0 right-0 z-10 h-0.5 bg-red-500"
                            style={{ top: `${(currentMinute / 60) * 100}%` }}
                          />
                        )}
                      </button>
                    );
                  })}
                </>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
