import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { buildSchedulerConfigResponse, parseSchedulerPatch } from "@/lib/scheduler/config";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler — get typed scheduler config
 * PATCH /api/scheduler — validate and update canonical allowlisted controls
 */
export async function GET() {
  if (isLocalAuthDisabled()) {
    const { rows } = await query<{ key: string; value: string }>(`select key, value from scheduler_config`);
    return NextResponse.json(buildSchedulerConfigResponse(rows || []));
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.from("scheduler_config").select("key, value");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(buildSchedulerConfigResponse(data || []));
}

export async function PATCH(req: NextRequest) {
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await authClient!.auth.getUser();
    user = authResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let patch: ReturnType<typeof parseSchedulerPatch>;
  try {
    patch = parseSchedulerPatch(await req.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid scheduler config";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const updatedAt = new Date().toISOString();
  if (useLocalMode) {
    try {
      for (const [key, value] of Object.entries(patch)) {
        await query(
          `insert into scheduler_config (key, value, updated_at)
           values ($1, $2, $3)
           on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [key, value, updatedAt],
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scheduler config write failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, config: patch });
  }

  const supabase = createServiceClient();
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: updatedAt }));
  const { error } = await supabase.from("scheduler_config").upsert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, config: patch });
}
