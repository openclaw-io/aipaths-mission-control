import { supabaseAdmin } from "@/lib/supabase/admin";
import { GuidesClient } from "@/components/guides/GuidesClient";
import { COMPACT_LINKED_WORK_ITEM_SELECT, compactWorkItemRow } from "@/lib/work-items/compact-payload";
import { COMPACT_EDITORIAL_PIPELINE_SELECT, compactEditorialPipelineItem } from "@/lib/pipeline-items/compact-metadata";

export const dynamic = "force-dynamic";

export interface GuideItem {
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

export default async function GuidesPage() {
  const [{ data, error }, { data: workItems, error: workError }] = await Promise.all([
    supabaseAdmin
      .from("pipeline_items")
      .select(COMPACT_EDITORIAL_PIPELINE_SELECT)
      .in("pipeline_type", ["doc", "guide"])
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("work_items")
      .select(COMPACT_LINKED_WORK_ITEM_SELECT)
      .in("source_type", ["pipeline_item", "service"])
      .in("payload->>pipeline_type", ["doc", "guide"])
      .order("created_at", { ascending: false }),
  ]);

  if (error) {
    console.error("[GuidesPage] Failed to fetch guide items:", error);
  }
  if (workError) {
    console.error("[GuidesPage] Failed to fetch work items:", workError);
  }

  const guides = (data ?? []).map((item) => compactEditorialPipelineItem(item as unknown as Record<string, unknown>)) as unknown as GuideItem[];
  const linkedWorkItems = (workItems ?? []).map((item) => compactWorkItemRow(item as unknown as Record<string, unknown>)).filter((item) => {
    const payload = item.payload || {};
    const isLegacyManualTransition = item.source_type === "service" && payload.trigger === "manual_transition";
    return ["doc", "guide"].includes(String(payload.pipeline_type)) && !isLegacyManualTransition;
  }) as unknown as LinkedWorkItem[];

  return <GuidesClient initialGuides={guides} initialWorkItems={linkedWorkItems} />;
}
