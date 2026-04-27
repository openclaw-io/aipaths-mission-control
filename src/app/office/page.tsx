import { createClient } from "@/lib/supabase/server";
import { OfficeClient } from "@/components/office/OfficeClient";

export default async function OfficePage() {
  const supabase = await createClient();

  const [tasksRes, memoryRes, cronRes] = await Promise.all([
    supabase
      .from("work_items")
      .select("id, title, owner_agent, target_agent_id, status, created_at, started_at, completed_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("memories")
      .select("agent, date, content, created_at")
      .eq("type", "journal")
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("cron_health").select("cron_name, last_status"),
  ]);

  const cronRows = cronRes.data ?? [];
  const cronOk = cronRows.filter((r) => r.last_status === "ok").length;

  return (
    <OfficeClient
      initialTasks={tasksRes.data ?? []}
      initialMemory={memoryRes.data ?? []}
      cronOk={cronOk}
      cronTotal={cronRows.length}
    />
  );
}
