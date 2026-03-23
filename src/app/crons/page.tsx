import { createClient } from "@/lib/supabase/server";
import CronsClient from "@/components/crons/CronsClient";

export default async function CronsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cron_health")
    .select("*")
    .order("cron_name");

  if (error) {
    console.error("[CronsPage] Failed to fetch crons:", error);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🕐 Crons</h1>
      <p className="mt-2 text-gray-400">
        Monitor scheduled jobs and cron health.
      </p>
      <CronsClient crons={data ?? []} />
    </div>
  );
}
