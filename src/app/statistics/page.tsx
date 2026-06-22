import { supabaseAdmin } from "@/lib/supabase/admin";
import { YouTubeLearningDashboard } from "@/components/youtube/YouTubeLearningDashboard";
import type { VideoPipelineItem } from "@/app/youtube/page";

export const dynamic = "force-dynamic";

export default async function StatisticsPage() {
  const { data, error } = await supabaseAdmin
    .from("pipeline_items")
    .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
    .eq("pipeline_type", "video")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[StatisticsPage] Failed to fetch video stats items:", error);
  }

  const videos: VideoPipelineItem[] = data ?? [];

  return <YouTubeLearningDashboard initialItems={videos} />;
}
