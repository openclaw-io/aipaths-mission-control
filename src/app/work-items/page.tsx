import { supabaseAdmin } from "@/lib/supabase/admin";
import { WorkItemsClient, type RecurringWorkRule, type WorkEvent, type WorkItem } from "@/components/work-items/WorkItemsClient";
import { COMPACT_WORK_QUEUE_ITEM_SELECT, compactWorkItemRow } from "@/lib/work-items/compact-payload";

export const dynamic = "force-dynamic";

export default async function WorkItemsPage() {
  const [itemsRes, eventsRes, rulesRes] = await Promise.all([
    supabaseAdmin
      .from("work_items")
      .select(COMPACT_WORK_QUEUE_ITEM_SELECT)
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("event_log")
      .select("id,domain,event_type,entity_type,entity_id,actor,payload,created_at")
      .eq("domain", "work")
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("recurring_work_rules")
      .select("*, recurring_work_occurrences(id, scheduled_for, work_item_id, status)")
      .order("created_at", { ascending: false }),
  ]);

  if (itemsRes.error) {
    console.error("[WorkItemsPage] Failed to fetch work items:", itemsRes.error);
  }

  if (eventsRes.error) {
    console.error("[WorkItemsPage] Failed to fetch work events:", eventsRes.error);
  }

  if (rulesRes.error) {
    console.error("[WorkItemsPage] Failed to fetch recurring rules:", rulesRes.error);
  }

  const initialItems = (itemsRes.data || []).map((item) => compactWorkItemRow(item as unknown as Record<string, unknown>)) as unknown as WorkItem[];

  return <WorkItemsClient initialItems={initialItems} initialEvents={(eventsRes.data || []) as WorkEvent[]} initialRules={(rulesRes.data || []) as RecurringWorkRule[]} />;
}
