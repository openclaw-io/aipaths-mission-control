import { createClient } from "@/lib/supabase/server";
import { timeAgo } from "@/lib/utils";

interface CronRow {
  id: string;
  cron_name: string;
  schedule: string;
  description: string | null;
  last_run_at: string | null;
  last_status: string;
  last_duration_ms: number | null;
  last_error: string | null;
  rows_affected: number | null;
}

const STATUS_DOT: Record<string, string> = {
  ok: "bg-green-500",
  error: "bg-red-500",
  unknown: "bg-gray-500",
};

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default async function CronsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cron_health")
    .select("*");

  if (error) {
    console.error("[CronsPage] Failed to fetch crons:", error);
  }

  const crons: CronRow[] = data ?? [];

  // Sort: errors first, then by last_run_at DESC (nulls last)
  crons.sort((a, b) => {
    if (a.last_status === "error" && b.last_status !== "error") return -1;
    if (a.last_status !== "error" && b.last_status === "error") return 1;
    const aTime = a.last_run_at ? new Date(a.last_run_at).getTime() : 0;
    const bTime = b.last_run_at ? new Date(b.last_run_at).getTime() : 0;
    return bTime - aTime;
  });

  const healthy = crons.filter((c) => c.last_status === "ok").length;
  const errors = crons.filter((c) => c.last_status === "error").length;
  const unknown = crons.filter((c) => c.last_status === "unknown").length;

  const summaryItems = [
    { label: "Total Crons", value: String(crons.length), color: "text-white" },
    { label: "Healthy", value: String(healthy), color: "text-green-400", dot: "bg-green-500" },
    { label: "Errors", value: String(errors), color: "text-red-400", dot: "bg-red-500" },
    { label: "Unknown", value: String(unknown), color: "text-gray-400", dot: "bg-gray-500" },
  ];

  return (
    <div>
      <h1 className="text-3xl font-bold text-white">🕐 Crons</h1>
      <p className="mt-2 text-gray-400">
        Monitor scheduled jobs and cron health.
      </p>

      {/* Summary Bar */}
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {summaryItems.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-gray-800 bg-[#111118] p-5"
          >
            <div className="flex items-center gap-2">
              {item.dot && (
                <span className={`h-3 w-3 rounded-full ${item.dot}`} />
              )}
              <span className={`text-3xl font-bold ${item.color}`}>
                {item.value}
              </span>
            </div>
            <div className="mt-1 text-sm text-gray-400">{item.label}</div>
          </div>
        ))}
      </div>

      {/* Cron List */}
      {crons.length === 0 ? (
        <p className="mt-8 text-gray-500">
          No crons configured yet. Crons will appear here once they report their health.
        </p>
      ) : (
        <div className="mt-8 space-y-2">
          {crons.map((cron) => (
            <div
              key={cron.id}
              className="rounded-lg border border-gray-800 bg-[#111118]"
            >
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                {/* Status dot */}
                <span
                  className={`h-3 w-3 shrink-0 rounded-full ${STATUS_DOT[cron.last_status] ?? "bg-gray-500"}`}
                />

                {/* Name + schedule */}
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-white">
                    {cron.cron_name}
                  </span>
                  <span className="ml-2 text-sm text-gray-500">
                    {cron.schedule}
                  </span>
                  {cron.description && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      {cron.description}
                    </p>
                  )}
                </div>

                {/* Metadata */}
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <div>
                    <span className="text-gray-500">Last run: </span>
                    <span className="text-gray-300">
                      {cron.last_run_at ? timeAgo(cron.last_run_at) : "Never"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Duration: </span>
                    <span className="text-gray-300">
                      {formatDuration(cron.last_duration_ms)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Rows: </span>
                    <span className="text-gray-300">
                      {cron.rows_affected ?? "—"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Error details */}
              {cron.last_status === "error" && cron.last_error && (
                <div className="border-t border-red-500/20 bg-red-500/5 px-4 py-3">
                  <p className="text-sm text-red-400">{cron.last_error}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
