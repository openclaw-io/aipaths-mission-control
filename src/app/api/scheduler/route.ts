import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler — get scheduler config
 * PATCH /api/scheduler — update config (enabled, max_concurrent, daily_budget_usd)
 */
export async function GET() {
  if (isLocalAuthDisabled()) {
    const { rows } = await query<{ key: string; value: string }>(`select key, value from scheduler_config`);
    const config: Record<string, string> = {};
    for (const row of rows || []) config[row.key] = row.value;
    return NextResponse.json(config);
  }

  const supabase = createServiceClient();
  const { data } = await supabase.from("scheduler_config").select("key, value");
  const config: Record<string, string> = {};
  for (const row of data || []) config[row.key] = row.value;
  return NextResponse.json(config);
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

  const body = await req.json();

  if (useLocalMode) {
    for (const [key, value] of Object.entries(body)) {
      await query(
        `insert into scheduler_config (key, value, updated_at)
         values ($1, $2, $3)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(value), new Date().toISOString()],
      );
    }
    return NextResponse.json({ ok: true });
  }

  const supabase = createServiceClient();
  for (const [key, value] of Object.entries(body)) {
    await supabase
      .from("scheduler_config")
      .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
  }

  return NextResponse.json({ ok: true });
}
