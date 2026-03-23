import { createClient } from "@/lib/supabase/server";
import CronsClient from "@/components/crons/CronsClient";

export default async function CronsPage() {
  const supabase = await createClient();

  const [cronsResult, logsResult] = await Promise.all([
    supabase.from("cron_health").select("*").order("cron_name"),
    supabase
      .from("cron_logs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(200),
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
        crons={cronsResult.data ?? []}
        logs={logsResult.data ?? []}
      />
    </div>
  );
}
