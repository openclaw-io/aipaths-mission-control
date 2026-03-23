import { createClient } from "@/lib/supabase/server";
import { OfficeClient } from "@/components/office/OfficeClient";

export default async function OfficePage() {
  const supabase = await createClient();

  const [tasksRes, memoryRes, cronRes] = await Promise.all([
    supabase
      .from("agent_tasks")
      .select("id, title, agent, status, created_at, started_at, completed_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("agent_memory")
      .select("agent, date, content")
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
