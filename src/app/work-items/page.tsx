import { WorkItemsClient, type RecurringWorkRule, type WorkEvent, type WorkItem } from "@/components/work-items/WorkItemsClient";
import { getWorkItemsBoard } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

export default async function WorkItemsPage() {
  let initialItems: WorkItem[] = [];
  let initialEvents: WorkEvent[] = [];
  let initialRules: RecurringWorkRule[] = [];

  try {
    const board = await getWorkItemsBoard(true);
    initialItems = board.items as WorkItem[];
    initialEvents = board.events as WorkEvent[];
    initialRules = board.rules as RecurringWorkRule[];
  } catch (error) {
    console.error("[WorkItemsPage] Failed to fetch local Postgres board:", error);
  }

  return (
    <WorkItemsClient
      initialItems={initialItems}
      initialEvents={initialEvents}
      initialRules={initialRules}
    />
  );
}
