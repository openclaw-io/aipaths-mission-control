import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import type { ClarificationQuestion } from "@/lib/loops/read-model";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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
  const responseText = typeof body?.response === "string" ? body.response.trim() : "";

  if (!responseText) {
    return NextResponse.json({ error: "Clarification response is required" }, { status: 400 });
  }

  const now = new Date().toISOString();

  if (useLocalMode) {
    const loopRows = await query<{ id: string; status: string; clarification_questions: ClarificationQuestion[] | null; metadata: Record<string, unknown> | null }>(
      `select id, status, clarification_questions, metadata from loops where id = $1 limit 1`,
      [id],
    );
    const loop = loopRows.rows[0];
    if (!loop) return NextResponse.json({ error: "Loop not found" }, { status: 404 });

    const questions = ((loop.clarification_questions || []) as ClarificationQuestion[]).map((q) =>
      q.status === "open" ? { ...q, status: "answered" } : q
    );
    const metadata = {
      ...((loop.metadata || {}) as Record<string, unknown>),
      clarification_history: [
        ...((((loop.metadata || {}) as Record<string, unknown>).clarification_history as unknown[]) || []),
        { responded_at: now, responded_by: actorIdentity, response: responseText },
      ],
    };

    await query(
      `update loops set status = 'needs_approval', clarification_questions = $1::jsonb, metadata = $2::jsonb, updated_at = $3 where id = $4`,
      [JSON.stringify(questions), JSON.stringify(metadata), now, id],
    );
    await query(
      `insert into loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
       values ($1, 'loop.ready_for_approval', $2, 'needs_approval', $3, $4::jsonb, $5)`,
      [id, loop.status, actorIdentity, JSON.stringify({ source: 'clarification_answered', response: responseText }), now],
    );
    return NextResponse.json({ ok: true, id, status: 'needs_approval' });
  }

  const supabase = createServiceClient();

  const { data: loop, error: loadError } = await supabase
    .from("loops")
    .select("id, status, clarification_questions, metadata")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!loop) {
    return NextResponse.json({ error: "Loop not found" }, { status: 404 });
  }

  const questions = ((loop.clarification_questions || []) as ClarificationQuestion[]).map((q) =>
    q.status === "open" ? { ...q, status: "answered" } : q
  );

  const metadata = {
    ...((loop.metadata || {}) as Record<string, unknown>),
    clarification_history: [
      ...((((loop.metadata || {}) as Record<string, unknown>).clarification_history as unknown[]) || []),
      {
        responded_at: now,
        responded_by: actorIdentity,
        response: responseText,
      },
    ],
  };

  const nextStatus = "needs_approval";

  const { error: updateError } = await supabase
    .from("loops")
    .update({
      status: nextStatus,
      clarification_questions: questions,
      metadata,
      updated_at: now,
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("loop_events").insert({
    loop_id: id,
    event_type: "loop.ready_for_approval",
    from_status: loop.status,
    to_status: nextStatus,
    actor: actorIdentity,
    payload: {
      source: "clarification_answered",
      response: responseText,
    },
  });

  if (eventError) {
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id, status: nextStatus });
}
