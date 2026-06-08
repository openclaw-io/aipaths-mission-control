import { supabaseAdmin } from "@/lib/supabase/admin";
import { CommunityClient } from "@/components/community/CommunityClient";
import { COMPACT_LINKED_WORK_ITEM_SELECT, compactWorkItemRow } from "@/lib/work-items/compact-payload";
import { COMPACT_COMMUNITY_PIPELINE_SELECT, compactCommunityPipelineItem } from "@/lib/pipeline-items/compact-metadata";

export const dynamic = "force-dynamic";

export interface CommunityItem {
  id: string;
  pipeline_type: string;
  title: string;
  slug: string | null;
  status: string;
  priority: string | null;
  owner_agent: string | null;
  requested_by: string | null;
  source_type: string | null;
  source_id: string | null;
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

export default async function CommunityPage() {
  const [{ data, error }, { data: workItems, error: workError }] = await Promise.all([
    supabaseAdmin
      .from("pipeline_items")
      .select(COMPACT_COMMUNITY_PIPELINE_SELECT)
      .eq("pipeline_type", "community_post")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("work_items")
      .select(COMPACT_LINKED_WORK_ITEM_SELECT)
      .in("source_type", ["pipeline_item", "service"])
      .eq("payload->>pipeline_type", "community_post")
      .order("created_at", { ascending: false }),
  ]);

  if (error) {
    console.error("[CommunityPage] Failed to fetch community items:", error);
  }
  if (workError) {
    console.error("[CommunityPage] Failed to fetch work items:", workError);
  }

  const communityItems = (data ?? []).map((item) => compactCommunityPipelineItem(item as unknown as Record<string, unknown>)) as unknown as CommunityItem[];
  const linkedWorkItems = (workItems ?? []).map((item) => compactWorkItemRow(item as unknown as Record<string, unknown>)).filter((item) => {
    const payload = item.payload || {};
    return payload.pipeline_type === "community_post";
  }) as unknown as LinkedWorkItem[];

  return <CommunityClient initialItems={communityItems} initialWorkItems={linkedWorkItems} />;
}
