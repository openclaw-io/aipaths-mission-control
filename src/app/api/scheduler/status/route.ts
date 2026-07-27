import { NextResponse } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { buildWorkItemSchedulerStatus, type SchedulerConfigRow, type WorkItemSchedulerHealth } from "@/lib/scheduler/status";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler/status
 *
 * Canonical control comes from scheduler_config. cron_health contributes only
 * runtime observations, so an idle StartInterval job is still "scheduled".
 */
export async function GET() {
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor
    ? { email: actor.email, id: actor.email }
    : null;

  if (!useLocalMode) {
    const authResult = await authClient!.auth.getUser();
    user = authResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (useLocalMode) {
    const [configResult, healthResult] = await Promise.all([
      query<SchedulerConfigRow>(`select key, value from scheduler_config`),
      query<WorkItemSchedulerHealth>(
        `select last_run_at, last_status, last_error, rows_affected
         from cron_health where cron_name = $1 limit 1`,
        ["work-item-scheduler"],
      ),
    ]);

    return NextResponse.json(
      buildWorkItemSchedulerStatus(configResult.rows || [], healthResult.rows[0] || null),
    );
  }

  const supabase = createServiceClient();
  const [configResult, healthResult] = await Promise.all([
    supabase.from("scheduler_config").select("key, value"),
    supabase
      .from("cron_health")
      .select("last_run_at, last_status, last_error, rows_affected")
      .eq("cron_name", "work-item-scheduler")
      .maybeSingle(),
  ]);

  if (configResult.error) {
    return NextResponse.json({ error: configResult.error.message }, { status: 500 });
  }
  if (healthResult.error) {
    return NextResponse.json({ error: healthResult.error.message }, { status: 500 });
  }

  return NextResponse.json(
    buildWorkItemSchedulerStatus(
      (configResult.data || []) as SchedulerConfigRow[],
      (healthResult.data as WorkItemSchedulerHealth | null) || null,
    ),
  );
}
