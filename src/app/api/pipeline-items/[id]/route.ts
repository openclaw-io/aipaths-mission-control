import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { getPipelineItemLocal } from "@/lib/db/pipeline-local";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const useLocalMode = isLocalAuthDisabled();
  const localUser = useLocalMode ? getLocalMissionControlUser() : null;
  const authClient = useLocalMode ? null : await createClient();
  const user = localUser || (await authClient!.auth.getUser()).data.user;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (useLocalMode) {
    const data = await getPipelineItemLocal(id);
    if (!data) {
      return NextResponse.json({ error: "Pipeline item not found" }, { status: 404 });
    }
    return NextResponse.json({ item: data });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("pipeline_items")
    .select("id,pipeline_type,title,slug,status,priority,owner_agent,requested_by,source_type,source_id,scheduled_for,published_at,current_url,content_path,content_format,metadata,created_at,updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Pipeline item not found" }, { status: 404 });
  }

  return NextResponse.json({ item: data });
}
