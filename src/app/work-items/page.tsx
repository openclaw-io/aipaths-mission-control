import { supabaseAdmin } from "@/lib/supabase/admin";
import { WorkItemsClient, type ScheduledPipelineItem, type WorkEvent, type WorkItem } from "@/components/work-items/WorkItemsClient";

export const dynamic = "force-dynamic";

export default async function WorkItemsPage() {
  const [itemsRes, eventsRes, scheduledPipelineRes] = await Promise.all([
    supabaseAdmin
      .from("work_items")
      .select("id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,started_at,completed_at,scheduled_for,payload")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("event_log")
      .select("id,domain,event_type,entity_type,entity_id,actor,payload,created_at")
      .eq("domain", "work")
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("pipeline_items")
      .select("id,title,status,pipeline_type,owner_agent,scheduled_for,created_at,updated_at")
      .not("scheduled_for", "is", null)
      .in("status", ["scheduled", "approved"])
      .order("scheduled_for", { ascending: true })
      .limit(200),
  ]);

  if (itemsRes.error) {
    console.error("[WorkItemsPage] Failed to fetch work items:", itemsRes.error);
  }

  if (eventsRes.error) {
    console.error("[WorkItemsPage] Failed to fetch work events:", eventsRes.error);
  }

  if (scheduledPipelineRes.error) {
    console.error("[WorkItemsPage] Failed to fetch scheduled pipeline items:", scheduledPipelineRes.error);
  }

  return (
    <WorkItemsClient
      initialItems={(itemsRes.data || []) as WorkItem[]}
      initialEvents={(eventsRes.data || []) as WorkEvent[]}
      initialScheduledPipelineItems={(scheduledPipelineRes.data || []) as ScheduledPipelineItem[]}
    />
  );
}
