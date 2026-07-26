import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { BlogsClient } from "@/components/blogs/BlogsClient";
import { COMPACT_LINKED_WORK_ITEM_SELECT, compactWorkItemRow } from "@/lib/work-items/compact-payload";
import { COMPACT_EDITORIAL_PIPELINE_SELECT, compactEditorialPipelineItem } from "@/lib/pipeline-items/compact-metadata";

export const dynamic = "force-dynamic";

export interface BlogItem {
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

export default async function BlogsPage() {
  const useLocalMode = isLocalAuthDisabled();

  const [pipelineRows, workRows] = useLocalMode
    ? await Promise.all([
        query<Record<string, unknown>>(`select * from pipeline_items where pipeline_type = 'blog' order by created_at desc`),
        query<Record<string, unknown>>(`select * from work_items where source_type = any($1::text[]) and payload ->> 'pipeline_type' = 'blog' order by created_at desc`, [["pipeline_item", "service"]]),
      ])
    : await Promise.all([
        supabaseAdmin
          .from("pipeline_items")
          .select(COMPACT_EDITORIAL_PIPELINE_SELECT),
        supabaseAdmin
          .from("work_items")
          .select(COMPACT_LINKED_WORK_ITEM_SELECT)
          .in("source_type", ["pipeline_item", "service"])
          .eq("payload->>pipeline_type", "blog"),
      ]);

  const blogs = normalizeRows(((pipelineRows as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }).rows ?? (pipelineRows as { data?: Record<string, unknown>[] }).data ?? [])).map((item) => compactEditorialPipelineItem(item as unknown as Record<string, unknown>)) as unknown as BlogItem[];
  const linkedWorkItems = normalizeRows(((workRows as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }).rows ?? (workRows as { data?: Record<string, unknown>[] }).data ?? [])).map((item) => compactWorkItemRow(item as unknown as Record<string, unknown>)).filter((item) => {
    const payload = item.payload || {};
    const isLegacyManualTransition = item.source_type === "service" && payload.trigger === "manual_transition";
    return payload.pipeline_type === "blog" && !isLegacyManualTransition;
  }) as unknown as LinkedWorkItem[];

  return <BlogsClient initialBlogs={blogs} initialWorkItems={linkedWorkItems} />;
}
