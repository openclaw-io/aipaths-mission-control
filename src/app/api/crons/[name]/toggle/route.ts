import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServiceClient();

  // Get current state
  const { data: cron } = await supabase
    .from("cron_health")
    .select("enabled")
    .eq("cron_name", name)
    .single();

  if (!cron) return NextResponse.json({ error: "Cron not found" }, { status: 404 });

  const newEnabled = !cron.enabled;
  await supabase
    .from("cron_health")
    .update({ enabled: newEnabled })
    .eq("cron_name", name);

  return NextResponse.json({ ok: true, cron_name: name, enabled: newEnabled });
}
