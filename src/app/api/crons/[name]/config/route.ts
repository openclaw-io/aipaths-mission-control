import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** GET /api/crons/:name/config — fetch cron row */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await authClient!.auth.getUser();
    user = authResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (useLocalMode) {
    const { rows } = await query(`select cron_name, schedule, last_run_at, enabled, config from cron_health where cron_name = $1 limit 1`, [name]);
    const cron = rows[0];
    if (!cron) return NextResponse.json({ error: "Cron not found" }, { status: 404 });
    return NextResponse.json(cron);
  }

  const supabase = createServiceClient();
  const { data: cron, error } = await supabase
    .from("cron_health")
    .select("cron_name, schedule, last_run_at, enabled, config")
    .eq("cron_name", name)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(cron);
}

/** PATCH /api/crons/:name/config — update cron config jsonb */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
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
    const existingRows = await query<{ config: Record<string, unknown> | null }>(`select config from cron_health where cron_name = $1 limit 1`, [name]);
    if (!existingRows.rows[0]) return NextResponse.json({ error: "Cron not found" }, { status: 404 });
    const existing = (existingRows.rows[0].config as Record<string, unknown>) || {};
    const merged = { ...existing, ...body };
    await query(`update cron_health set config = $1::jsonb where cron_name = $2`, [JSON.stringify(merged), name]);
    return NextResponse.json({ ok: true, config: merged });
  }

  const supabase = createServiceClient();

  // Merge with existing config
  const { data: cron } = await supabase
    .from("cron_health")
    .select("config")
    .eq("cron_name", name)
    .single();

  const existing = (cron?.config as Record<string, unknown>) || {};
  const merged = { ...existing, ...body };

  await supabase
    .from("cron_health")
    .update({ config: merged })
    .eq("cron_name", name);

  return NextResponse.json({ ok: true, config: merged });
}
