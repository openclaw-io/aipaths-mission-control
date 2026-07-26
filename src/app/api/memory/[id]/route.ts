import { NextResponse } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRow } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const useLocalMode = isLocalAuthDisabled();
  const authClient = useLocalMode ? null : await createClient();
  const user = useLocalMode
    ? getLocalMissionControlUser()
    : (await authClient!.auth.getUser()).data.user;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = useLocalMode ? null : createServiceClient();
  const localData = useLocalMode
    ? await query(
        `select id, agent, type, title, content, tags, date, created_at, updated_at
           from memories
          where id = $1
          limit 1`,
        [id]
      ).then((res) => (res.rows[0] ? normalizeRow(res.rows[0]) : null))
    : null;
  const remoteResult = useLocalMode
    ? null
    : await supabase!
        .from("memories")
        .select("id, agent, type, title, content, tags, date, created_at, updated_at")
        .eq("id", id)
        .maybeSingle();
  const data = useLocalMode ? localData : (remoteResult?.data ?? null);
  const error = useLocalMode ? null : (remoteResult?.error ?? null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  return NextResponse.json({ memory: data });
}
