import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getExecutionWindowConfig, isExecutionWindowOpenNow } from "@/lib/execution-window";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getExecutionWindowConfig();

  if (!config) {
    return NextResponse.json({ error: "execution_window_config_missing" }, { status: 500 });
  }

  const state = isExecutionWindowOpenNow(config, new Date());

  return NextResponse.json({
    config,
    state,
  });
}

export async function PATCH(request: NextRequest) {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: user.email || user.id,
  };

  if (typeof body.timezone === "string") {
    updates.timezone = body.timezone;
  }

  if (body.base_schedule && typeof body.base_schedule === "object") {
    updates.base_schedule = body.base_schedule;
  }

  if (["auto", "forced_on", "forced_off"].includes(body.override_mode)) {
    updates.override_mode = body.override_mode;
  }

  if (body.override_until === null || typeof body.override_until === "string") {
    updates.override_until = body.override_until;
  }

  if (body.override_reason === null || typeof body.override_reason === "string") {
    updates.override_reason = body.override_reason;
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("execution_window_config")
    .update(updates)
    .eq("id", "global")
    .select("id, timezone, base_schedule, override_mode, override_until, override_reason, updated_by, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const state = isExecutionWindowOpenNow(data, new Date());

  return NextResponse.json({
    config: data,
    state,
  });
}
