import { NextResponse } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import {
  buildSchedulerStatusResponse,
  type WorkItemSchedulerHealth,
} from "@/lib/scheduler/status";
import { createServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { PUBLISH_BLOG_DISPATCHER_CRON_NAME } from "@/lib/work-items/publish-blog-dispatcher";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler/status
 *
 * runtime-workers is the sole dispatcher and health writer. Mission Control
 * only observes its cron_health row, including the effective enabled flag.
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
    let health: WorkItemSchedulerHealth | null = null;
    let healthError: unknown = null;
    try {
      const healthResult = await query<WorkItemSchedulerHealth>(
        `select enabled, schedule, last_run_at, last_status, last_error, rows_affected
         from cron_health where cron_name = $1 limit 1`,
        [PUBLISH_BLOG_DISPATCHER_CRON_NAME],
      );
      health = healthResult.rows[0] || null;
    } catch (error) {
      healthError = error;
    }

    const response = buildSchedulerStatusResponse(health, healthError);
    return NextResponse.json(response.body, { status: response.status });
  }

  const supabase = createServiceClient();
  let health: WorkItemSchedulerHealth | null = null;
  let healthError: unknown = null;
  try {
    const healthResult = await supabase
      .from("cron_health")
      .select("enabled, schedule, last_run_at, last_status, last_error, rows_affected")
      .eq("cron_name", PUBLISH_BLOG_DISPATCHER_CRON_NAME)
      .maybeSingle();
    if (healthResult.error) healthError = healthResult.error;
    else health = (healthResult.data as WorkItemSchedulerHealth | null) || null;
  } catch (error) {
    healthError = error;
  }

  const response = buildSchedulerStatusResponse(health, healthError);
  return NextResponse.json(response.body, { status: response.status });
}
