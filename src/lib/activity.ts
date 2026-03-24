import { createServiceClient } from "@/lib/supabase/admin";

export type ActivityEventType =
  | "task_created"
  | "task_claimed"
  | "task_completed"
  | "task_failed"
  | "agent_woke"
  | "cron_ran"
  | "task_dispatched";

/**
 * Log an activity event. Fire-and-forget (never throws).
 */
export function logActivity(
  agent: string,
  eventType: ActivityEventType,
  title: string,
  detail?: string | null,
  taskId?: string | null
) {
  try {
    const supabase = createServiceClient();
    supabase
      .from("activity_log")
      .insert({
        agent,
        event_type: eventType,
        title,
        detail: detail || null,
        task_id: taskId || null,
      })
      .then(({ error }) => {
        if (error) console.error("[activity] insert failed:", error.message);
      });
  } catch {
    // Never fail
  }
}
