import { OfficeClient } from "@/components/office/OfficeClient";
import { getOfficeState } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

export default async function OfficePage() {
  const { tasks, memory, cronRows } = await getOfficeState();
  const cronOk = cronRows.filter((r: { last_status?: string | null }) => r.last_status === "ok").length;

  return (
    <OfficeClient
      initialTasks={tasks as never}
      initialMemory={memory as never}
      cronOk={cronOk}
      cronTotal={cronRows.length}
    />
  );
}
