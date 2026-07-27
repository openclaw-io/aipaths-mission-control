import { NextResponse } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import {
  buildSchedulerStatusResponse,
  type SchedulerConfigRow,
  type WorkItemSchedulerHealth,
} from "@/lib/scheduler/status";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler/status
 *
 * Canonical control comes from scheduler_config. cron_health contributes only
 * runtime observations, so observation failures return degraded/unknown with
 * HTTP 200 rather than making scheduler control unavailable.
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
    const configResult = await query<SchedulerConfigRow>(`select key, value from scheduler_config`);
    let health: WorkItemSchedulerHealth | null = null;
    let healthError: unknown = null;
    try {
      const healthResult = await query<WorkItemSchedulerHealth>(
        `select last_run_at, last_status, last_error, rows_affected
         from cron_health where cron_name = $1 limit 1`,
        ["work-item-scheduler"],
      );
      health = healthResult.rows[0] || null;
    } catch (error) {
      healthError = error;
    }

    const response = buildSchedulerStatusResponse(configResult.rows || [], health, healthError);
    return NextResponse.json(response.body, { status: response.status });
  }

  const supabase = createServiceClient();
  const configResult = await supabase.from("scheduler_config").select("key, value");
  if (configResult.error) {
    return NextResponse.json({ error: configResult.error.message }, { status: 500 });
  }

  let health: WorkItemSchedulerHealth | null = null;
  let healthError: unknown = null;
  try {
    const healthResult = await supabase
      .from("cron_health")
      .select("last_run_at, last_status, last_error, rows_affected")
      .eq("cron_name", "work-item-scheduler")
      .maybeSingle();
    if (healthResult.error) healthError = healthResult.error;
    else health = (healthResult.data as WorkItemSchedulerHealth | null) || null;
  } catch (error) {
    healthError = error;
  }

  const response = buildSchedulerStatusResponse(
    (configResult.data || []) as SchedulerConfigRow[],
    health,
    healthError,
  );
  return NextResponse.json(response.body, { status: response.status });
}
