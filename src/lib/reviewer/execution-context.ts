import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";
import type { ReviewerExecutionContext } from "@/lib/reviewer/review-completion";

export async function lockReviewerExecution(client: CompletionQueryClient, executionId: string) {
  const result = await client.query<ReviewerExecutionContext & {
    capability_hash: Buffer;
    capability_expires_at: string | Date;
    capability_consumed_at: string | Date | null;
    capability_revoked_at: string | Date | null;
    reviewer_session_id: string | null;
    work_status: string;
    heartbeat_at: string | Date;
  }>(
    `select e.*,r.task_id,r.quality_cycle,r.target_run_id implementation_run_id,
        impl.server_session_id implementer_session_id,t.status task_status,t.title task_title,
        wi.status work_status,
        s.id stage_id,s.plan_revision_id,p.content_hash plan_hash,l.id loop_id,l.status loop_status,l.priority,l.owner_agent
      from reviewer_executions e join loop_task_runs r on r.id=e.review_run_id
      join loop_task_runs impl on impl.id=r.target_run_id
      join work_items wi on wi.id=e.work_item_id
      join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
      join loop_plan_revisions p on p.id=s.plan_revision_id join loops l on l.id=p.loop_id
      where e.id=$1 for update of e,l,t,r`,
    [executionId],
  );
  return result.rows[0] || null;
}
