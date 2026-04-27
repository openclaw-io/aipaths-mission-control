import { supabaseAdmin } from "@/lib/supabase/admin";
import { SuggestionsClient, type SuggestionItem } from "@/components/suggestions/SuggestionsClient";

export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  const { data, error } = await supabaseAdmin
    .from("work_items")
    .select("id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,scheduled_for,payload")
    .in("status", ["blocked", "draft"])
    .eq("payload->>requires_human_approval", "true")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) console.error("[SuggestionsPage] Failed to fetch suggestions:", error);

  return <SuggestionsClient initialItems={(data || []) as SuggestionItem[]} />;
}
