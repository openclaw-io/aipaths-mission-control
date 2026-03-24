import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/scheduler — get scheduler config
 * PATCH /api/scheduler — update config (enabled, max_concurrent, daily_budget_usd)
 */
export async function GET() {
  const supabase = createServiceClient();
  const { data } = await supabase.from("scheduler_config").select("key, value");
  const config: Record<string, string> = {};
  for (const row of data || []) config[row.key] = row.value;
  return NextResponse.json(config);
}

export async function PATCH(req: NextRequest) {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const supabase = createServiceClient();

  for (const [key, value] of Object.entries(body)) {
    await supabase
      .from("scheduler_config")
      .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
  }

  return NextResponse.json({ ok: true });
}
