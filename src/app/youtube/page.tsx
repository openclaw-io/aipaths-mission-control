import { supabaseAdmin } from "@/lib/supabase/admin";
import { YouTubeDecisionBoard } from "@/components/youtube/YouTubeDecisionBoard";

export const dynamic = "force-dynamic";

export interface VideoPipelineItem {
  id: string;
  pipeline_type: string;
  title: string;
  slug: string | null;
  status: string;
  priority: string | null;
  owner_agent: string | null;
  target_agent_id?: string | null;
  requested_by: string | null;
  source_type: string | null;
  source_id: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  current_url: string | null;
  content_path: string | null;
  content_format: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LinkedWorkItem {
  id: string;
  source_id: string;
  source_type: string;
  title: string;
  status: string;
  owner_agent: string | null;
  target_agent_id?: string | null;
  created_at: string;
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
}

export default async function YouTubePage() {
  const [{ data, error }, { data: workItems, error: workError }] = await Promise.all([
    supabaseAdmin
      .from("pipeline_items")
      .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
      .eq("pipeline_type", "video")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("work_items")
      .select("id, source_id, source_type, title, status, owner_agent, target_agent_id, created_at, scheduled_for, payload")
      .in("source_type", ["pipeline_item", "service"])
      .order("created_at", { ascending: false }),
  ]);

  if (error) {
    console.error("[YouTubePage] Failed to fetch video items:", error);
  }
  if (workError) {
    console.error("[YouTubePage] Failed to fetch work items:", workError);
  }

  const videos: VideoPipelineItem[] = data ?? [];
  const linkedWorkItems: LinkedWorkItem[] = (workItems ?? []).filter((item) => {
    const payload = item.payload || {};
    return payload.pipeline_type === "video";
  });

  return <YouTubeDecisionBoard initialItems={videos} initialWorkItems={linkedWorkItems} />;
}
