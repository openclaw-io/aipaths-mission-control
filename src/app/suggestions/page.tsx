import { supabaseAdmin } from "@/lib/supabase/admin";
import { SuggestionsClient, type SuggestionItem } from "@/components/suggestions/SuggestionsClient";
import { COMPACT_WORK_ITEM_SELECT, compactWorkItemRow } from "@/lib/work-items/compact-payload";

export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  const { data, error } = await supabaseAdmin
    .from("work_items")
    .select(COMPACT_WORK_ITEM_SELECT)
    .in("status", ["blocked", "draft"])
    .eq("payload->>requires_human_approval", "true")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) console.error("[SuggestionsPage] Failed to fetch suggestions:", error);

  const initialItems = (data || []).map((item) => compactWorkItemRow(item as unknown as Record<string, unknown>)) as unknown as SuggestionItem[];

  return <SuggestionsClient initialItems={initialItems} />;
}
