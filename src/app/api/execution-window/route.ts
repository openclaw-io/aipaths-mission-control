import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRow } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { getExecutionWindowConfig, isExecutionWindowOpenNow, type ExecutionWindowConfig } from "@/lib/execution-window";

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
  const useLocalMode = isLocalAuthDisabled();
  const localUser = useLocalMode ? getLocalMissionControlUser() : null;
  const authClient = useLocalMode ? null : await createClient();
  let user: { email?: string | null; id?: string | null } | null = localUser
    ? { email: localUser.email, id: localUser.email }
    : null;
  if (!useLocalMode) user = (await authClient!.auth.getUser()).data.user;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const updatedBy = user.email || user.id;
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
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

  if (useLocalMode) {
    const entries = Object.entries(updates);
    const values = entries.map(([key, value]) => key === "base_schedule" ? JSON.stringify(value) : value);
    const setters = entries.map(([key], index) => `${key} = $${index + 1}${key === "base_schedule" ? "::jsonb" : ""}`);
    const { rows } = await query(
      `update public.execution_window_config
          set ${setters.join(", ")}
        where id = 'global'
        returning id, timezone, base_schedule, override_mode, override_until, override_reason, updated_by, updated_at`,
      values,
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "execution_window_config_missing" }, { status: 404 });
    }
    const data = normalizeRow(rows[0]) as ExecutionWindowConfig;
    return NextResponse.json({ config: data, state: isExecutionWindowOpenNow(data, new Date()) });
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
