import { isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import CronsClient from "@/components/crons/CronsClient";

type CronRow = {
  id: string;
  cron_name: string;
  schedule: string;
  description: string | null;
  last_run_at: string | null;
  last_status: string;
  last_duration_ms: number | null;
  last_error: string | null;
  rows_affected: number | null;
  category: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
};

type CronLog = {
  id: string;
  cron_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  rows_affected: number | null;
  message: string | null;
};

export default async function CronsPage() {
  if (isLocalAuthDisabled()) {
    const [cronsRes, logsRes] = await Promise.all([
      query(`select * from cron_health order by cron_name`),
      query(`select * from cron_logs order by started_at desc limit 100`),
    ]);

    return (
      <div>
        <h1 className="text-3xl font-bold text-white">🕐 Crons</h1>
        <p className="mt-2 text-gray-400">
          Monitor scheduled jobs and cron health.
        </p>
        <CronsClient
          crons={(cronsRes.rows ?? []) as CronRow[]}
          logs={(logsRes.rows ?? []) as CronLog[]}
        />
      </div>
    );
  }

  const supabase = await createClient();

  const [cronsResult, logsResult] = await Promise.all([
    supabase.from("cron_health").select("*").order("cron_name"),
    supabase
      .from("cron_logs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(100),
  ]);

  if (cronsResult.error) {
    console.error("[CronsPage] Failed to fetch crons:", cronsResult.error);
  }
  if (logsResult.error) {
    console.error("[CronsPage] Failed to fetch logs:", logsResult.error);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🕐 Crons</h1>
      <p className="mt-2 text-gray-400">
        Monitor scheduled jobs and cron health.
      </p>
      <CronsClient
        crons={(cronsResult.data ?? []) as CronRow[]}
        logs={(logsResult.data ?? []) as CronLog[]}
      />
    </div>
  );
}
