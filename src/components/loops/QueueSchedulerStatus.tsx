"use client";

import { useEffect, useMemo, useState } from "react";

type CronRow = {
  cron_name: string;
  schedule: string;
  schedule_minutes: number;
  state: "paused" | "scheduled" | "degraded";
  last_run_at: string | null;
  enabled: boolean;
  last_status?: string | null;
  last_error?: string | null;
  rows_affected?: number | null;
};

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function QueueSchedulerStatus() {
  const [cron, setCron] = useState<CronRow | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/scheduler/status");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.cron_name) {
          setCron({
            cron_name: data.cron_name,
            schedule: data.schedule,
            schedule_minutes: data.schedule_minutes,
            state: data.state,
            last_run_at: data.last_run_at,
            enabled: data.enabled,
            last_status: data.last_status,
            last_error: data.last_error,
            rows_affected: data.rows_affected,
          });
        }
      } catch {
        // noop
      }
    }

    load();
    const refresh = setInterval(load, 30000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
      clearInterval(tick);
    };
  }, []);

  const nextRun = useMemo(() => {
    if (!cron || cron.state === "degraded" || cron.last_status === "error" || !cron.enabled) return null;
    const mins = Number.isInteger(cron.schedule_minutes) && cron.schedule_minutes > 0
      ? cron.schedule_minutes
      : null;
    if (!mins || !cron.last_run_at) return null;
    return new Date(cron.last_run_at).getTime() + mins * 60_000;
  }, [cron]);

  if (!cron) {
    return <div className="text-xs text-gray-500">Checking scheduler…</div>;
  }

  if (cron.state === "degraded" || cron.last_status === "error") {
    return (
      <div className="text-xs text-red-300">
        Scheduler degraded · {cron.schedule}
        {cron.last_error ? ` · ${cron.last_error}` : ""}
      </div>
    );
  }

  if (!cron.enabled) {
    return <div className="text-xs text-amber-300">Scheduler paused · {cron.schedule}</div>;
  }

  if (!nextRun) {
    return (
      <div className="text-xs text-gray-400">
        Scheduler {cron.state} · {cron.schedule}
      </div>
    );
  }

  const remaining = nextRun - now;

  return (
    <div className="space-y-0.5 text-right text-xs text-gray-400">
      <div>Scheduler {cron.state} · {cron.schedule}</div>
      <div>
        Next scheduler check in <span className="font-medium text-white">{remaining <= 0 ? "now" : formatCountdown(remaining)}</span>
      </div>
      {cron.last_run_at && (
        <div>
          Last check: <span className="text-gray-300">{cron.last_status === "error" ? cron.last_error || "error" : cron.rows_affected ? `dispatched ${cron.rows_affected}` : "no dispatch"}</span>
        </div>
      )}
    </div>
  );
}
