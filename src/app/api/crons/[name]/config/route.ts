import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** GET /api/crons/:name/config — fetch cron row */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
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
