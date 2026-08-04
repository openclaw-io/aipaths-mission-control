import { randomUUID } from "node:crypto";
import type { CompletionQueryClient } from "@/lib/work-items/completion-orchestration";
import type { QaResult } from "@/lib/qa/result";

export type QaExecutionContext = {
  id: string; qa_run_id: string; task_id: string; work_item_id: string; execution_attempt_id: string;
  target_run_id: string; target_sha: string; policy_hash: string; status: string;
  capability_hash: Buffer; capability_expires_at: string | Date; capability_consumed_at: string | Date | null;
  capability_revoked_at: string | Date | null; qa_session_id: string | null; heartbeat_at: string | Date;
  pid: number | null; runner_birth_token: string | null; planner_session_id: string | null;
  quality_cycle: number; qa_run_status: string; work_status: string; task_status: string; task_title: string;
  stage_id: string; plan_revision_id: string; plan_hash: string; loop_id: string; loop_status: string;
  priority: string | null; owner_agent: string | null; repository_id: string; base_sha: string;
  implementer_session_id: string; reviewer_session_id: string;
  task_metadata: Record<string, unknown>; work_payload: Record<string, unknown>;
  revision_status: string; current_plan_revision_id: string | null;
};

export async function lockQaExecution(client: CompletionQueryClient, executionId: string) {
  const authorityLock = await client.query<{ locked: boolean }>(
    "select lock_visual_qa_execution($1) locked", [executionId]);
  if (authorityLock.rows[0]?.locked !== true) return null;
  const result = await client.query<QaExecutionContext>(
    `select e.*,qr.status qa_run_status,qr.quality_cycle,qr.repository_id,qr.base_sha,
       wi.status work_status,wi.payload work_payload,t.status task_status,t.title task_title,t.metadata task_metadata,
       s.id stage_id,s.plan_revision_id,p.content_hash plan_hash,p.status revision_status,l.current_plan_revision_id,
       l.id loop_id,l.status loop_status,l.priority,l.owner_agent,
       impl.server_session_id implementer_session_id,d.reviewer_session_id
     from qa_executions e join loop_task_runs qr on qr.id=e.qa_run_id and qr.task_id=e.task_id
     join loop_task_runs impl on impl.id=e.target_run_id and impl.task_id=e.task_id
     join loop_task_reviews d on d.task_id=e.task_id and d.task_run_id=e.target_run_id
       and d.quality_cycle=qr.quality_cycle and d.status='approved'
     join work_items wi on wi.id=e.work_item_id join loop_tasks t on t.id=e.task_id
     join loop_stages s on s.id=t.stage_id join loop_plan_revisions p on p.id=s.plan_revision_id
     join loops l on l.id=p.loop_id where e.id=$1 for update of qr,wi,t,l`,
    [executionId],
  );
  return result.rows[0] || null;
}

async function block(client: CompletionQueryClient, execution: QaExecutionContext, now: string, event: string, payload: object) {
  await client.query("update loop_tasks set status='blocked',updated_at=$2 where id=$1 and status='qa_pending'", [execution.task_id, now]);
  await client.query("update loop_stages set status='blocked',updated_at=$2 where id=$1", [execution.stage_id, now]);
  await client.query("update loops set status='blocked',updated_at=$2,row_version=row_version+1 where id=$1 and status='in_progress'", [execution.loop_id, now]);
  await client.query(`insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
    values ($1,$2,'in_progress','blocked','visual-qa',$3::jsonb,$4)`, [execution.loop_id, event, JSON.stringify(payload), now]);
}

async function persistQaEvidenceDescriptors(
  client: CompletionQueryClient,
  execution: QaExecutionContext,
  result: QaResult,
  resultHash: string,
) {
  const persisted = await client.query<{ persisted: number }>(
    "select persist_visual_qa_evidence($1,$2) persisted",
    [execution.id, resultHash],
  );
  if (persisted.rows[0]?.persisted !== result.evidence.length) {
    throw new Error("qa_evidence_persistence_mismatch");
  }
}

export async function applyQaResult(client: CompletionQueryClient, execution: QaExecutionContext, result: QaResult,
  resultHash: string, qaSessionId: string, rawCapability: string) {
  if (execution.status !== "running" || execution.qa_run_status !== "running" || execution.work_status !== "in_progress"
    || execution.task_status !== "qa_pending" || execution.loop_status !== "in_progress") throw new Error("qa_execution_state_conflict");
  if (!qaSessionId || qaSessionId !== execution.qa_session_id
    || qaSessionId === execution.implementer_session_id || qaSessionId === execution.reviewer_session_id) {
    throw new Error("qa_session_mismatch");
  }
  if (!execution.planner_session_id && result.verdict !== "infrastructure_failure") {
    throw new Error("qa_planner_session_unbound");
  }
  if (result.tested_sha !== execution.target_sha) throw new Error("qa_tested_sha_mismatch");
  const now = new Date().toISOString();
  const infrastructure = result.verdict === "infrastructure_failure";
  const runStatus = infrastructure ? "failed" : "succeeded";
  const compactOutput = { qa_execution_id: execution.id, result_hash: resultHash,
    verdict: result.verdict, tested_sha: result.tested_sha };
  const run = await client.query(
    `update loop_task_runs set status=$2,started_at=coalesce(started_at,$3),finished_at=$3,
      server_session_id=$4,error=$5,output=$6::jsonb,updated_at=$3 where id=$1 and status='running' and target_sha=$7 returning id`,
    [execution.qa_run_id, runStatus, now, qaSessionId, infrastructure ? result.error : null,
      JSON.stringify(compactOutput), execution.target_sha],
  );
  if (run.rowCount !== 1) throw new Error("qa_run_concurrent_conflict");
  const completed = await client.query<{ completed: boolean }>(
    "select complete_visual_qa_execution($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) completed",
    [execution.id,execution.execution_attempt_id,execution.target_sha,execution.policy_hash,qaSessionId,rawCapability,
      JSON.stringify(result),resultHash,now],
  );
  if (!completed.rows[0]?.completed) throw new Error("qa_completion_concurrent_conflict");
  await persistQaEvidenceDescriptors(client, execution, result, resultHash);

  if (infrastructure) {
    await block(client, execution, now, "loop.qa_infrastructure_failure", {
      task_id: execution.task_id, qa_run_id: execution.qa_run_id, quality_cycle: execution.quality_cycle,
      target_sha: execution.target_sha, error: result.error,
    });
    return { effect: "loop_qa_infrastructure_failure" };
  }
  if (result.verdict === "changes") {
    if (execution.quality_cycle === 3) {
      await block(client, execution, now, "loop.quality_cycles_exhausted", {
        task_id: execution.task_id, qa_run_id: execution.qa_run_id, quality_cycle: 3,
        target_sha: execution.target_sha, findings_count: result.findings.length,
      });
      return { effect: "loop_quality_cycles_exhausted" };
    }
    const nextCycle = execution.quality_cycle + 1;
    const attemptId = randomUUID();
    await client.query("update loop_tasks set status='rework_required',updated_at=$2 where id=$1 and status='qa_pending'", [execution.task_id, now]);
    const implementationWork = await client.query<{ id: string }>(
      `insert into work_items(loop_id,parent_id,kind,source_type,source_id,title,instruction,status,priority,owner_agent,requested_by,payload)
       values ($1,null,'task','loop',$2,$3,$4,'ready',$5,$6,'system',$7::jsonb) returning id`,
      [execution.loop_id, execution.task_id, `Rework project task: ${execution.task_title}`,
        `Quality cycle ${nextCycle}/3. Address the structured visual QA findings for exact SHA ${execution.target_sha}.\n\nFindings: ${JSON.stringify(result.findings)}`,
        execution.priority || "medium", execution.owner_agent || "systems", JSON.stringify({
          materialized_from_loop: true,source_loop_id: execution.loop_id,loop_task_id: execution.task_id,
          plan_revision_id: execution.plan_revision_id,plan_hash: execution.plan_hash,relation_type: "task_execution",
          runtime_contract: "fresh_review_v1",run_role: "implementation",quality_cycle: nextCycle,
          previous_qa_run_id: execution.qa_run_id,execution_attempt_id: attemptId,execution_generation: 1,dispatch_state: "ready",
        })],
    );
    const workItemId = implementationWork.rows[0]?.id;
    if (!workItemId) throw new Error("qa_rework_work_item_insert_failed");
    await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [execution.loop_id, workItemId]);
    await client.query(
      `insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,repository_id,base_sha,output,updated_at)
       values ($1,$2,$3,'implementation',$4,(select coalesce(max(attempt_number),0)+1 from loop_task_runs where task_id=$1),
       'queued',$5,$6,'{}'::jsonb,$7)`,
      [execution.task_id, workItemId, attemptId, nextCycle, execution.repository_id, execution.target_sha, now],
    );
    await client.query("update loop_tasks set status='in_progress',updated_at=$2 where id=$1 and status='rework_required'", [execution.task_id, now]);
    await client.query("update loop_stages set status='in_progress',updated_at=$2 where id=$1", [execution.stage_id, now]);
    await client.query(`insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
      values ($1,'loop.task_rework_started','in_progress','in_progress','visual-qa',$2::jsonb,$3)`,
      [execution.loop_id, JSON.stringify({ task_id: execution.task_id, previous_qa_run_id: execution.qa_run_id,
        quality_cycle: nextCycle, findings_count: result.findings.length, work_item_id: workItemId }), now]);
    return { effect: "loop_task_rework_started" };
  }

  await client.query("update loop_tasks set status='completed',updated_at=$2 where id=$1 and status='qa_pending'", [execution.task_id, now]);
  const stage = (await client.query<{ complete: boolean }>(
    "select bool_and(status in ('completed','skipped')) complete from loop_tasks where stage_id=$1", [execution.stage_id])).rows[0];
  await client.query("update loop_stages set status=$2,updated_at=$3 where id=$1", [execution.stage_id, stage?.complete ? "completed" : "in_progress", now]);
  await client.query(`update loop_tasks candidate set status='ready',updated_at=$2 from loop_stages stage
    where candidate.stage_id=stage.id and stage.plan_revision_id=$1 and candidate.status='pending'
      and not exists (select 1 from loop_task_dependencies d join loop_tasks dependency on dependency.id=d.depends_on_task_id
        where d.task_id=candidate.id and d.dependency_type='hard' and dependency.status<>'completed')`, [execution.plan_revision_id, now]);
  const aggregate = (await client.query<{ complete: boolean; active_runs: number; invalid: number }>(
    `select bool_and(t.status in ('completed','skipped')) complete,
       count(r.id) filter(where r.status in ('queued','running'))::int active_runs,
       count(*) filter(where t.status='completed' and not exists (
         select 1 from loop_task_runs impl join loop_task_reviews d on d.task_run_id=impl.id and d.status='approved'
         join loop_task_runs rr on rr.id=d.review_run_id and rr.status='succeeded'
         where impl.task_id=t.id and impl.run_role='implementation' and impl.status='succeeded'
           and impl.quality_cycle=(select max(x.quality_cycle) from loop_task_runs x where x.task_id=t.id and x.run_role='implementation')
           and d.reviewed_sha IS NOT DISTINCT FROM impl.artifact_sha and (
             not (t.metadata ? 'qa_policy') or (public.qa_policy_is_valid(t.metadata->'qa_policy') and (
               t.metadata->'qa_policy'->'required'='false'::jsonb or exists (
               select 1 from loop_task_runs qr join qa_executions qe on qe.qa_run_id=qr.id
               join work_items qwi on qwi.id=qr.work_item_id
               where qr.task_id=t.id and qr.run_role='qa' and qr.quality_cycle IS NOT DISTINCT FROM impl.quality_cycle
               and qr.target_sha IS NOT DISTINCT FROM impl.artifact_sha and qr.status='succeeded'
               and qwi.payload->'qa_policy' IS NOT DISTINCT FROM t.metadata->'qa_policy'
               and qe.target_sha IS NOT DISTINCT FROM impl.artifact_sha
               and ((qe.status='succeeded' and jsonb_typeof(qe.result->'verdict')='string'
                     and qe.result->>'verdict' IS NOT DISTINCT FROM 'pass'
                     and public.qa_result_is_valid(qe.result,qe.target_sha,qwi.payload->'qa_policy')
                     and qe.result_hash IS NOT DISTINCT FROM public.qa_jsonb_sha256(qe.result))
                 or (qe.id=$2::uuid and qe.status='running'))))))))::int invalid
               from loop_tasks t join loop_stages s on s.id=t.stage_id left join loop_task_runs r on r.task_id=t.id
               where s.plan_revision_id=$1`, [execution.plan_revision_id, execution.id])).rows[0];
  const loopStatus = aggregate?.complete && aggregate.active_runs === 0 && aggregate.invalid === 0 ? "in_review" : "in_progress";
  await client.query("update loops set status=$2,updated_at=$3,row_version=row_version+1 where id=$1 and status='in_progress'", [execution.loop_id, loopStatus, now]);
  await client.query(`insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
    values ($1,'loop.task_qa_passed','in_progress',$2,'visual-qa',$3::jsonb,$4)`,
    [execution.loop_id, loopStatus, JSON.stringify({ task_id: execution.task_id,qa_run_id: execution.qa_run_id,
      quality_cycle: execution.quality_cycle,target_sha: execution.target_sha }), now]);
  return { effect: "loop_task_qa_passed" };
}

export async function failQaExecution(client: CompletionQueryClient, execution: QaExecutionContext, error: string) {
  const now = new Date().toISOString();
  await client.query(`update loop_task_runs set status='failed',started_at=coalesce(started_at,$2),finished_at=$2,error=$3,updated_at=$2
    where id=$1 and status in ('queued','running')`, [execution.qa_run_id, now, error]);
  await block(client, execution, now, "loop.qa_execution_failed", { task_id: execution.task_id,qa_run_id: execution.qa_run_id,error });
}
