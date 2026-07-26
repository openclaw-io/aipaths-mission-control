import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function buildUniqueKey(supabase: ReturnType<typeof createServiceClient>, input: string) {
  const baseKey = slugify(input) || `loop-${Date.now()}`;

  const { data: existing, error } = await supabase
    .from("loops")
    .select("key")
    .like("key", `${baseKey}%`);

  if (error) throw error;

  const existingKeys = new Set((existing || []).map((row) => row.key));
  if (!existingKeys.has(baseKey)) return baseKey;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseKey}-${i}`.slice(0, 100);
    if (!existingKeys.has(candidate)) return candidate;
  }

  return `${baseKey}-${Date.now()}`.slice(0, 100);
}

async function buildUniqueKeyLocal(input: string) {
  const baseKey = slugify(input) || `loop-${Date.now()}`;
  const { rows } = await query<{ key: string }>(`select key from loops where key like $1`, [`${baseKey}%`]);
  const existingKeys = new Set((rows || []).map((row) => row.key));
  if (!existingKeys.has(baseKey)) return baseKey;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseKey}-${i}`.slice(0, 100);
    if (!existingKeys.has(candidate)) return candidate;
  }

  return `${baseKey}-${Date.now()}`.slice(0, 100);
}

export async function POST(request: NextRequest) {
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await authClient!.auth.getUser();
    user = authResult.data.user;
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actorIdentity = String(user.email || user.id || "local@mission-control");
  const body = await request.json().catch(() => ({}));
  const input = typeof body?.input === "string" ? body.input.trim() : "";

  if (!input) {
    return NextResponse.json({ error: "Loop input is required" }, { status: 400 });
  }

  const now = new Date().toISOString();

  if (useLocalMode) {
    const key = await buildUniqueKeyLocal(input);
    const inserted = await query<{ id: string; key: string; status: string }>(
      `insert into loops (
         key, name, description, summary, type, status, priority, owner_agent,
         metadata, plan, clarification_questions, approval_scope, created_by, updated_at
       ) values (
         $1, $2, $3, $4, 'ops', 'planning', 'medium', 'systems',
         $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10
       ) returning id, key, status`,
      [
        key,
        input,
        input,
        input,
        JSON.stringify({ created_from: 'quick_loop_box' }),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify({
          approved: false,
          approved_by: null,
          approved_at: null,
          can_execute_unattended: true,
          allowed_actions: ['planning', 'implementation'],
          forbidden_actions: ['publish_external_output'],
          notes: null,
        }),
        actorIdentity,
        now,
      ],
    );
    const data = inserted.rows[0];

    await query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, 'loop.created', null, 'planning', $2, $3::jsonb, $4)`,
      [data.id, actorIdentity, JSON.stringify({ source: 'quick_loop_box', input }), now],
    );

    return NextResponse.json({ ok: true, loop: data });
  }

  const supabase = createServiceClient();
  const key = await buildUniqueKey(supabase, input);

  const { data, error } = await supabase
    .from("loops")
    .insert({
      key,
      name: input,
      description: input,
      summary: input,
      type: "ops",
      status: "planning",
      priority: "medium",
      owner_agent: "systems",
      metadata: {
        created_from: "quick_loop_box",
      },
      plan: [],
      clarification_questions: [],
      approval_scope: {
        approved: false,
        approved_by: null,
        approved_at: null,
        can_execute_unattended: true,
        allowed_actions: ["planning", "implementation"],
        forbidden_actions: ["publish_external_output"],
        notes: null,
      },
      created_by: actorIdentity,
      updated_at: now,
    })
    .select("id, key, status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("loop_events").insert({
    loop_id: data.id,
    event_type: "loop.created",
    from_status: null,
    to_status: "planning",
    actor: actorIdentity,
    payload: { source: "quick_loop_box", input },
    created_at: now,
  });

  return NextResponse.json({ ok: true, loop: data });
}
