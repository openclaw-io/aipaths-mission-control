import { randomUUID } from "node:crypto";
import type { ReviewerResult } from "@/lib/reviewer/package";
import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";

export type ReviewerExecutionContext = {
  id: string;
  review_run_id: string;
  work_item_id: string;
  execution_attempt_id: string;
  repository_id: string;
  base_sha: string;
  target_sha: string;
  package_sha256: string;
  status: string;
  work_status: string;
  task_id: string;
  task_status: string;
  task_title: string;
  stage_id: string;
  plan_revision_id: string;
  plan_hash: string;
  loop_id: string;
  loop_status: string;
  quality_cycle: number;
  implementation_run_id: string;
  implementer_session_id: string;
  priority: string | null;
  owner_agent: string | null;
};

export async function applyReviewerResult(
  client: CompletionQueryClient,
  execution: ReviewerExecutionContext,
  result: ReviewerResult,
  reviewerSessionId: string,
) {
  if (execution.status !== "running" || execution.work_status !== "in_progress"
      || execution.loop_status !== "in_progress" || execution.task_status !== "review_pending") {
    throw new Error("reviewer_execution_state_conflict");
  }
  if (!reviewerSessionId || reviewerSessionId === execution.implementer_session_id) throw new Error("reviewer_session_mismatch");
  const pending = await client.query<{ id: string; reviewed_sha: string; task_run_id: string; quality_cycle: number }>(
    `select id,reviewed_sha,task_run_id,quality_cycle from loop_task_reviews
      where review_run_id=$1 and task_id=$2 and status='pending' for update`,
    [execution.review_run_id, execution.task_id],
  );
  if (pending.rows.length !== 1 || pending.rows[0].reviewed_sha !== execution.target_sha
      || pending.rows[0].task_run_id !== execution.implementation_run_id
      || pending.rows[0].quality_cycle !== execution.quality_cycle) throw new Error("fresh_review_pending_row_conflict");
  const now = new Date().toISOString();
  const run = await client.query(
    `update loop_task_runs set status='succeeded',started_at=coalesce(started_at,$2::timestamptz),
       finished_at=greatest($2::timestamptz,started_at),server_session_id=$3::text,
       error=null,output=$4::jsonb,updated_at=greatest($2::timestamptz,started_at)
      where id=$1 and status='running' and target_sha=$5::text returning id`,
    [execution.review_run_id, now, reviewerSessionId, JSON.stringify(result), execution.target_sha],
  );
  if (run.rowCount !== 1) throw new Error("reviewer_run_concurrent_conflict");
  const decision = await client.query(
    `update loop_task_reviews set status=$2::text,reviewer='strong-isolation-reviewer',feedback=$3::text,
       decided_at=$4::timestamptz,reviewer_session_id=$5::text,findings=$6::jsonb,
       decision_id=$7::uuid,updated_at=$4::timestamptz
      where review_run_id=$1::uuid and status='pending' returning id`,
    [execution.review_run_id, result.verdict, result.feedback, now, reviewerSessionId, JSON.stringify(result.findings), randomUUID()],
  );
  if (decision.rowCount !== 1) throw new Error("fresh_review_pending_row_conflict");
  const completedWork = await client.query(
    `update work_items set status='done',completed_at=$2::timestamptz,updated_at=$2::timestamptz,
       payload=payload||jsonb_build_object('dispatch_state','completed','dispatch_completed_at',($2::timestamptz)::text)
      where id=$1 and status='in_progress' returning id`,
    [execution.work_item_id, now],
  );
  if (completedWork.rowCount !== 1) throw new Error("reviewer_work_item_concurrent_conflict");

  if (result.verdict === "approved") {
    await client.query("update loop_tasks set status='completed',updated_at=$2 where id=$1 and status='review_pending'", [execution.task_id, now]);
    const stage = (await client.query<{ complete: boolean }>(
      "select bool_and(status in ('completed','skipped')) complete from loop_tasks where stage_id=$1", [execution.stage_id],
    )).rows[0];
    await client.query("update loop_stages set status=$2,updated_at=$3 where id=$1", [execution.stage_id, stage?.complete ? "completed" : "in_progress", now]);
    await client.query(
      `update loop_tasks candidate set status='ready',updated_at=$2 from loop_stages stage
        where candidate.stage_id=stage.id and stage.plan_revision_id=$1 and candidate.status='pending'
          and not exists (select 1 from loop_task_dependencies d join loop_tasks dependency on dependency.id=d.depends_on_task_id
            where d.task_id=candidate.id and d.dependency_type='hard' and dependency.status<>'completed')`,
      [execution.plan_revision_id, now],
    );
    const aggregate = (await client.query<{ complete: boolean; active_runs: number; unapproved: number }>(
      `select bool_and(t.status in ('completed','skipped')) complete,
          count(r.id) filter (where r.status in ('queued','running'))::int active_runs,
          count(*) filter (where t.status='completed' and not exists (
            select 1 from loop_task_runs impl join loop_task_reviews d on d.task_run_id=impl.id
            join loop_task_runs rr on rr.id=d.review_run_id
            where impl.task_id=t.id and impl.run_role='implementation' and impl.status='succeeded'
              and impl.quality_cycle=(select max(x.quality_cycle) from loop_task_runs x where x.task_id=t.id and x.run_role='implementation')
              and d.status='approved' and d.reviewed_sha IS NOT DISTINCT FROM impl.artifact_sha
              and d.reviewer_session_id is distinct from impl.server_session_id and rr.status='succeeded'))::int unapproved
        from loop_tasks t join loop_stages s on s.id=t.stage_id left join loop_task_runs r on r.task_id=t.id
        where s.plan_revision_id=$1`, [execution.plan_revision_id],
    )).rows[0];
    const loopStatus = aggregate?.complete && aggregate.active_runs === 0 && aggregate.unapproved === 0 ? "in_review" : "in_progress";
    await client.query("update loops set status=$2,updated_at=$3,row_version=row_version+1 where id=$1 and status='in_progress'", [execution.loop_id, loopStatus, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,'loop.task_review_approved','in_progress',$2,'strong-isolation-reviewer',$3::jsonb,$4)`,
      [execution.loop_id, loopStatus, JSON.stringify({ task_id: execution.task_id, review_run_id: execution.review_run_id,
        implementation_run_id: execution.implementation_run_id, quality_cycle: execution.quality_cycle, reviewed_sha: execution.target_sha }), now],
    );
    return { effect: "loop_task_review_approved" };
  }

  if (execution.quality_cycle === 3) {
    await client.query("update loop_tasks set status='blocked',updated_at=$2 where id=$1 and status='review_pending'", [execution.task_id, now]);
    await client.query("update loop_stages set status='blocked',updated_at=$2 where id=$1", [execution.stage_id, now]);
    await client.query("update loops set status='blocked',updated_at=$2,row_version=row_version+1 where id=$1 and status='in_progress'", [execution.loop_id, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,'loop.quality_cycles_exhausted','in_progress','blocked','strong-isolation-reviewer',$2::jsonb,$3)`,
      [execution.loop_id, JSON.stringify({ task_id: execution.task_id, quality_cycle: 3,
        reviewed_sha: execution.target_sha, findings_count: result.findings.length }), now],
    );
    return { effect: "loop_quality_cycles_exhausted" };
  }

  const nextCycle = execution.quality_cycle + 1;
  const attemptId = randomUUID();
  await client.query("update loop_tasks set status='rework_required',updated_at=$2 where id=$1 and status='review_pending'", [execution.task_id, now]);
  const work = await client.query<{ id: string }>(
    `insert into work_items(loop_id,parent_id,kind,source_type,source_id,title,instruction,status,priority,owner_agent,requested_by,payload)
     values ($1,null,'task','loop',$2,$3,$4,'ready',$5,$6,'system',$7::jsonb) returning id`,
    [execution.loop_id, execution.task_id, `Rework project task: ${execution.task_title}`,
      `Quality cycle ${nextCycle}/3. Address the trusted reviewer feedback and structured findings. Report the new exact HEAD commit and worktree; it must be a changed descendant of the rejected artifact.\n\nFeedback: ${result.feedback}\nFindings: ${JSON.stringify(result.findings)}`,
      execution.priority || "medium", execution.owner_agent || "systems", JSON.stringify({
        materialized_from_loop: true, source_loop_id: execution.loop_id, loop_task_id: execution.task_id,
        plan_revision_id: execution.plan_revision_id, plan_hash: execution.plan_hash, relation_type: "task_execution", runtime_contract: "fresh_review_v1",
        run_role: "implementation", quality_cycle: nextCycle, previous_review_run_id: execution.review_run_id,
        execution_attempt_id: attemptId, execution_generation: 1, dispatch_state: "ready",
      })],
  );
  const workItemId = work.rows[0]?.id;
  if (!workItemId) throw new Error("rework_work_item_insert_failed");
  await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [execution.loop_id, workItemId]);
  await client.query(
    `insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,repository_id,base_sha,output,updated_at)
     values ($1,$2,$3,'implementation',$4,(select coalesce(max(attempt_number),0)+1 from loop_task_runs where task_id=$1),'queued',$5,$6,'{}'::jsonb,$7)`,
    [execution.task_id, workItemId, attemptId, nextCycle, execution.repository_id, execution.target_sha, now],
  );
  await client.query("update loop_tasks set status='in_progress',updated_at=$2 where id=$1 and status='rework_required'", [execution.task_id, now]);
  await client.query("update loop_stages set status='in_progress',updated_at=$2 where id=$1", [execution.stage_id, now]);
  await client.query(
    `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
     values ($1,'loop.task_rework_started','in_progress','in_progress','strong-isolation-reviewer',$2::jsonb,$3)`,
    [execution.loop_id, JSON.stringify({ task_id: execution.task_id, previous_review_run_id: execution.review_run_id,
      quality_cycle: nextCycle, findings_count: result.findings.length, work_item_id: workItemId }), now],
  );
  return { effect: "loop_task_rework_started" };
}

/** Terminal runner failures always close the pending review and block the Loop. */
export async function failReviewerExecution(
  client: CompletionQueryClient,
  execution: ReviewerExecutionContext,
  error: string,
  status: "failed" | "cancelled" | "blocked" = "failed",
) {
  const now = new Date().toISOString();
  const runStatus = status === "cancelled" ? "cancelled" : "failed";
  await client.query(
    `update loop_task_runs set status=$2,started_at=coalesce(started_at,$3),finished_at=$3,error=$4,updated_at=$3
      where id=$1 and status in ('queued','running')`,
    [execution.review_run_id, runStatus, now, error],
  );
  await client.query(
    `update loop_task_reviews set status='rejected',reviewer='strong-isolation-reviewer',feedback=$2,
       decided_at=$3,reviewer_session_id=$4,decision_id=$5,updated_at=$3
      where review_run_id=$1 and status='pending'`,
    [execution.review_run_id, error, now, `failed:${execution.id}`, randomUUID()],
  );
  await client.query("update work_items set status='failed',completed_at=$2,updated_at=$2 where id=$1 and status in ('ready','in_progress')", [execution.work_item_id, now]);
  await client.query("update loop_tasks set status='blocked',updated_at=$2 where id=$1 and status='review_pending'", [execution.task_id, now]);
  await client.query("update loop_stages set status='blocked',updated_at=$2 where id=$1", [execution.stage_id, now]);
  await client.query("update loops set status='blocked',updated_at=$2,row_version=row_version+1 where id=$1 and status='in_progress'", [execution.loop_id, now]);
  await client.query(
    `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
     values ($1,'loop.reviewer_execution_failed','in_progress','blocked','strong-isolation-reviewer',$2::jsonb,$3)`,
    [execution.loop_id, JSON.stringify({ execution_id: execution.id, review_run_id: execution.review_run_id, error }), now],
  );
}
