import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";
import type { PoolClient } from "pg";
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

async function buildUniqueKeyLocal(input: string, client: Pick<PoolClient, "query">) {
  const baseKey = slugify(input) || `loop-${Date.now()}`;
  const { rows } = await client.query<{ key: string }>(`select key from loops where key like $1`, [`${baseKey}%`]);
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
  const input = typeof body?.input === "string" ? body.input : "";

  if (!input.trim()) {
    return NextResponse.json({ error: "Loop input is required" }, { status: 400 });
  }

  const now = new Date().toISOString();

  if (useLocalMode) {
    const dedupeKey = `quick-loop:${actorIdentity}:${input}`;
    const data = await withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [dedupeKey]);
      const existing = await client.query<{ id: string; key: string; status: string }>(
        `select id, key, status from loops where metadata ->> 'create_dedupe_key' = $1 order by created_at desc limit 1`,
        [dedupeKey],
      );
      if (existing.rows[0]) return existing.rows[0];

      const key = await buildUniqueKeyLocal(input, client);
      const inserted = await client.query<{ id: string; key: string; status: string }>(
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
        JSON.stringify({ created_from: 'quick_loop_box', create_dedupe_key: dedupeKey, original_input: input }),
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
      const created = inserted.rows[0];

      await client.query(
        `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
         values ($1, 'loop.created', null, 'planning', $2, $3::jsonb, $4)`,
        [created.id, actorIdentity, JSON.stringify({ source: 'quick_loop_box', input, dedupe_key: dedupeKey }), now],
      );
      return created;
    });

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
        original_input: input,
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
