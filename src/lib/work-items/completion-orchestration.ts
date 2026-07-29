import {
  YOUTUBE_GATE_ORDER,
  YOUTUBE_GATE_STATUSES,
  buildGateHistoryEntry,
  derivePipelineItemStatus,
  getGateEntry,
  getScores,
  getYouTubeMetadata,
  type YouTubeGateKey,
  type YouTubeGateStatus,
} from "@/lib/youtube-pipeline";
import { verifyRepositoryCommit } from "@/lib/work-items/git-artifact";

export type JsonRecord = Record<string, unknown>;

export type CompletionQueryClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type WorkItemRow = JsonRecord & {
  id: string;
  status?: string | null;
  title?: string | null;
  priority?: string | null;
  owner_agent?: string | null;
  requested_by?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  payload?: JsonRecord | null;
};

export type PublicationVerificationRequest = {
  type: "blog" | "guide";
  url: string;
  expectedTitle: string;
  expectedSlug?: string | null;
  expectedDescription?: string | null;
};

export type PreparedPublicationVerification = {
  request: PublicationVerificationRequest;
  result: JsonRecord & { ok: boolean; finalUrl?: string | null };
  workItemId: string;
  workItemUpdatedAt: string | null;
  pipelineItemId: string;
  pipelineItemUpdatedAt: string | null;
};

export type CompletionOrchestrationInput = {
  existing: WorkItemRow;
  updated: WorkItemRow;
  body: JsonRecord;
  publicationVerification?: PreparedPublicationVerification | null;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function getNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function completePlan(plan: unknown) {
  if (!Array.isArray(plan)) return [];
  return plan.map((step) => (
    step && typeof step === "object" && !Array.isArray(step)
      ? { ...(step as JsonRecord), status: "done" }
      : step
  ));
}

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usefulFindings(findings: unknown[], feedback: string | null) {
  if (feedback) return findings.length > 0;
  return findings.some((finding) => {
    if (typeof finding === "string") return finding.trim().length > 0;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    return Object.values(finding as JsonRecord).some((value) => typeof value === "string" && value.trim().length > 0);
  });
}

async function reconcileV2TaskExecution(
  client: CompletionQueryClient,
  workItem: WorkItemRow,
  body: JsonRecord,
) {
  const linked = await client.query<{
    loop_id: string; loop_status: string; workflow_version: number; current_plan_revision_id: string;
    approval_scope: Record<string, unknown>; revision_status: string; content_hash: string | null;
    task_id: string; task_status: string; task_title: string; task_description: string | null;
    stage_id: string; plan_revision_id: string; run_id: string; run_status: string;
    run_role: "implementation" | "review"; quality_cycle: number; execution_attempt_id: string | null;
    server_session_id: string | null; target_run_id: string | null; target_sha: string | null;
    repository_id: string; base_sha: string; prior_artifact_sha: string | null; prior_repository_id: string | null;
    repository_key: string; canonical_root: string; git_common_dir: string; object_format: "sha1" | "sha256"; repository_enabled: boolean;
    priority: string | null;
  }>(
    `select l.id loop_id,l.status loop_status,l.workflow_version,l.current_plan_revision_id,l.approval_scope,l.priority,
            pr.status revision_status,pr.content_hash,t.id task_id,t.status task_status,t.title task_title,t.description task_description,
            s.id stage_id,s.plan_revision_id,r.id run_id,r.status run_status,r.run_role,r.quality_cycle,
            r.execution_attempt_id,r.server_session_id,r.target_run_id,r.target_sha,r.repository_id,r.base_sha,
            (select prev.artifact_sha from loop_task_runs prev where prev.task_id=r.task_id
              and prev.run_role='implementation' and prev.quality_cycle=r.quality_cycle-1) prior_artifact_sha,
            (select prev.repository_id from loop_task_runs prev where prev.task_id=r.task_id
              and prev.run_role='implementation' and prev.quality_cycle=r.quality_cycle-1) prior_repository_id,
            repo.key repository_key,repo.canonical_root,repo.git_common_dir,repo.object_format,repo.enabled repository_enabled
       from loop_work_items lwi join loops l on l.id=lwi.loop_id
       join loop_task_runs r on r.work_item_id=lwi.work_item_id
       join review_repositories repo on repo.id=r.repository_id
       join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
       join loop_plan_revisions pr on pr.id=s.plan_revision_id and pr.loop_id=l.id
      where lwi.work_item_id=$1 and lwi.relation_type='task_execution'
      order by l.id,t.id,r.id`,
    [workItem.id],
  );
  if (linked.rows.length > 1) throw new Error("v2_task_execution_mapping_cardinality");
  const item = linked.rows[0];
  if (!item) {
    const taskMapping = await client.query<{ present: number }>(
      "select 1 present from loop_work_items where work_item_id=$1 and relation_type='task_execution' limit 1",
      [workItem.id],
    );
    if (taskMapping.rows[0]) throw new Error("v2_task_execution_identity_mismatch");
    return null;
  }
  if (item.workflow_version !== 2 || item.current_plan_revision_id !== item.plan_revision_id) {
    throw new Error("v2_task_execution_revision_mismatch");
  }
  const scope = asRecord(item.approval_scope);
  const payload = asRecord(workItem.payload);
  if (item.revision_status !== "approved" || !item.content_hash
    || scope.approved !== true || scope.can_execute_unattended !== true
    || scope.approved_plan_revision_id !== item.plan_revision_id
    || scope.approved_plan_hash !== item.content_hash
    || payload.plan_revision_id !== item.plan_revision_id || payload.plan_hash !== item.content_hash) {
    throw new Error("v2_task_execution_approval_mismatch");
  }
  if (!item.execution_attempt_id || payload.execution_attempt_id !== item.execution_attempt_id
    || readString(body.execution_attempt_id) !== item.execution_attempt_id
    || workItem.source_type !== "loop" || workItem.source_id !== item.task_id
    || payload.source_loop_id !== item.loop_id || payload.loop_task_id !== item.task_id
    || payload.runtime_contract !== "fresh_review_v1" || payload.run_role !== item.run_role
    || Number(payload.quality_cycle) !== item.quality_cycle) {
    throw new Error("v2_task_execution_identity_mismatch");
  }
  const dispatchSessionId = readString(payload.dispatch_session_id);
  if (item.run_role === "review") throw new Error("fresh_review_dedicated_reviewer_required");
  const now = new Date().toISOString();
  const actor = readString(workItem.owner_agent) || "work-item-completion";

  if (body.status === "in_progress") {
    const expectedTaskStatus = "in_progress";
    if (item.loop_status !== "in_progress" || item.task_status !== expectedTaskStatus || item.run_status !== "queued") {
      throw new Error("v2_task_start_state_conflict");
    }
    await client.query(
      "update loop_task_runs set status='running',started_at=coalesce(started_at,$2),updated_at=$2 where id=$1 and status='queued'",
      [item.run_id, now],
    );
    return { applied: true, effect: `loop_task_${item.run_role}_started`, loopId: item.loop_id };
  }

  if (body.status === "failed" || body.status === "canceled") {
    const runStatus = body.status === "canceled" ? "cancelled" : "failed";
    if (item.loop_status !== "in_progress" || !["in_progress", "review_pending"].includes(item.task_status)
      || !["queued", "running"].includes(item.run_status)) throw new Error("v2_task_terminal_state_conflict");
    await client.query(
      `update loop_task_runs set status=$2,started_at=coalesce(started_at,$3),finished_at=$3,
              error=$4,output=$5::jsonb,updated_at=$3 where id=$1 and status in ('queued','running')`,
      [item.run_id, runStatus, now, readString(body.result), JSON.stringify(asRecord(body.output))],
    );
    await client.query("update loop_tasks set status='blocked',updated_at=$2 where id=$1", [item.task_id, now]);
    await client.query("update loop_stages set status='blocked',updated_at=$2 where id=$1", [item.stage_id, now]);
    await client.query("update loops set status='blocked',updated_at=$2,row_version=row_version+1 where id=$1 and status='in_progress'", [item.loop_id, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,$2,$3,'blocked',$4,$5::jsonb,$6)`,
      [item.loop_id, `loop.task_${body.status}`, item.loop_status, actor,
        JSON.stringify({ task_id: item.task_id, task_run_id: item.run_id, work_item_id: workItem.id,
          execution_attempt_id: item.execution_attempt_id, run_role: item.run_role, quality_cycle: item.quality_cycle }), now],
    );
    return { applied: true, effect: `loop_task_${body.status}`, loopId: item.loop_id };
  }

  if (body.status !== "done") throw new Error("v2_task_status_transition_conflict");
  if (item.loop_status !== "in_progress" || !["queued", "running"].includes(item.run_status)) {
    throw new Error("v2_task_completion_state_conflict");
  }
  if (!dispatchSessionId || !UUID_PATTERN.test(dispatchSessionId)) throw new Error("fresh_review_dispatch_session_required");
  const output: JsonRecord = { ...asRecord(body.output), ...(body.result !== undefined ? { result: body.result } : {}) };

  if (item.run_role === "implementation") {
    if (item.task_status !== "in_progress") throw new Error("v2_task_completion_state_conflict");
    const artifactSha = readString(output.head_sha);
    if (!artifactSha || !SHA_PATTERN.test(artifactSha)) throw new Error("implementation_head_sha_required");
    const repositoryPath = readString(output.repository_path);
    if (!repositoryPath) throw new Error("implementation_repository_path_required");
    if (item.quality_cycle > 1 && (!item.prior_artifact_sha || item.prior_repository_id !== item.repository_id)) {
      throw new Error("implementation_rework_repository_identity_conflict");
    }
    await verifyRepositoryCommit(repositoryPath, artifactSha, {
      id: item.repository_id,
      canonical_root: item.canonical_root,
      git_common_dir: item.git_common_dir,
      object_format: item.object_format,
      enabled: item.repository_enabled,
    }, item.base_sha, item.quality_cycle > 1 ? (item.prior_artifact_sha || undefined) : undefined);
    delete output.repository_path;
    const completedRun = await client.query(
      `update loop_task_runs set status='succeeded',started_at=coalesce(started_at,$2),finished_at=$2,
              error=null,output=$3::jsonb,artifact_sha=$4,server_session_id=$5,updated_at=$2
        where id=$1 and status in ('queued','running')`,
      [item.run_id, now, JSON.stringify(output), artifactSha, dispatchSessionId],
    );
    if (completedRun.rowCount !== 1) throw new Error("v2_task_completion_state_conflict");
    const token = (await client.query<{ id: string }>("select gen_random_uuid() id")).rows[0]?.id;
    if (!token) throw new Error("review_execution_token_failed");
    const reviewWork = await client.query<{ id: string }>(
      `insert into work_items(loop_id,parent_id,kind,source_type,source_id,title,instruction,status,priority,owner_agent,requested_by,payload)
       values ($1,null,'task','loop',$2,$3,$4,'ready',$5,$6,'system',$7::jsonb) returning id`,
      [item.loop_id, item.task_id, `Fresh review: ${item.task_title}`,
        `Fresh read-only review for quality cycle ${item.quality_cycle}/3 of exact SHA ${artifactSha}. This work item is dispatched only by the dedicated strongly isolated reviewer runner. Generic agent notification, PATCH completion, and requeue are forbidden.`,
        item.priority || "medium", actor, JSON.stringify({
          materialized_from_loop: true, source_loop_id: item.loop_id, loop_task_id: item.task_id,
          plan_revision_id: item.plan_revision_id, plan_hash: item.content_hash, relation_type: "task_execution",
          runtime_contract: "fresh_review_v1", run_role: "review", quality_cycle: item.quality_cycle,
          target_run_id: item.run_id, target_sha: artifactSha, execution_attempt_id: token,
          execution_generation: 1, dispatch_state: "ready",
        })],
    );
    const reviewWorkId = reviewWork.rows[0]?.id;
    if (!reviewWorkId) throw new Error("review_work_item_insert_failed");
    await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [item.loop_id, reviewWorkId]);
    const reviewRun = await client.query<{ id: string }>(
      `insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,target_run_id,target_sha,repository_id,base_sha,output,updated_at)
       values ($1,$2,$3,'review',$4,(select coalesce(max(attempt_number),0)+1 from loop_task_runs where task_id=$1),'queued',$5,$6,$7,$8,'{}'::jsonb,$9) returning id`,
      [item.task_id, reviewWorkId, token, item.quality_cycle, item.run_id, artifactSha, item.repository_id, item.base_sha, now],
    );
    await client.query(
      `insert into loop_task_reviews(task_id,task_run_id,review_run_id,quality_cycle,status,reviewed_sha,findings,updated_at)
       values ($1,$2,$3,$4,'pending',$5,'[]'::jsonb,$6)`,
      [item.task_id, item.run_id, reviewRun.rows[0]?.id, item.quality_cycle, artifactSha, now],
    );
    await client.query("update loop_tasks set status='review_pending',updated_at=$2 where id=$1 and status='in_progress'", [item.task_id, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,'loop.task_review_pending','in_progress','in_progress',$2,$3::jsonb,$4)`,
      [item.loop_id, actor, JSON.stringify({ task_id: item.task_id, implementation_run_id: item.run_id,
        review_run_id: reviewRun.rows[0]?.id, quality_cycle: item.quality_cycle, artifact_sha: artifactSha }), now],
    );
    return { applied: true, effect: "loop_task_review_pending", loopId: item.loop_id };
  }

  if (item.task_status !== "review_pending" || !item.target_run_id || !item.target_sha) {
    throw new Error("v2_task_completion_state_conflict");
  }
  const target = (await client.query<{ server_session_id: string | null; artifact_sha: string | null; status: string; run_role: string }>(
    "select server_session_id,artifact_sha,status,run_role from loop_task_runs where id=$1 and task_id=$2 for share",
    [item.target_run_id, item.task_id],
  )).rows[0];
  if (!target || target.run_role !== "implementation" || target.status !== "succeeded"
    || target.artifact_sha !== item.target_sha) throw new Error("fresh_review_target_stale");
  if (!target.server_session_id || target.server_session_id === dispatchSessionId) throw new Error("fresh_review_session_conflict");
  const pendingReviews = await client.query<{
    id: string; task_run_id: string | null; review_run_id: string | null; quality_cycle: number | null;
    reviewed_sha: string | null;
  }>(
    `select id,task_run_id,review_run_id,quality_cycle,reviewed_sha
       from loop_task_reviews where review_run_id=$1 and task_id=$2 and status='pending' for update`,
    [item.run_id, item.task_id],
  );
  if (pendingReviews.rows.length !== 1) throw new Error("fresh_review_pending_row_conflict");
  const pendingReview = pendingReviews.rows[0];
  if (pendingReview.task_run_id !== item.target_run_id || pendingReview.review_run_id !== item.run_id
    || pendingReview.quality_cycle !== item.quality_cycle || pendingReview.reviewed_sha !== item.target_sha) {
    throw new Error("fresh_review_pending_row_conflict");
  }
  const verdict = readString(output.verdict);
  const reviewedSha = readString(output.reviewed_sha);
  const findings = Array.isArray(output.findings) ? output.findings : null;
  const feedback = readString(output.feedback) || readString(body.result);
  if (!verdict || !["approved", "changes_requested"].includes(verdict)) throw new Error("review_verdict_invalid");
  if (!reviewedSha || reviewedSha !== item.target_sha) throw new Error("reviewed_sha_mismatch");
  if (!findings) throw new Error("review_findings_array_required");
  if (verdict === "changes_requested" && !usefulFindings(findings, feedback)) throw new Error("review_changes_feedback_required");

  const completedReviewRun = await client.query(
    `update loop_task_runs set status='succeeded',started_at=coalesce(started_at,$2),finished_at=$2,error=null,
            output=$3::jsonb,server_session_id=$4::uuid,updated_at=$2 where id=$1 and status in ('queued','running')`,
    [item.run_id, now, JSON.stringify(output), dispatchSessionId],
  );
  if (completedReviewRun.rowCount !== 1) throw new Error("fresh_review_run_concurrent_conflict");
  const decidedReview = await client.query(
    `update loop_task_reviews set status=$2,reviewer=$3,feedback=$4,decided_at=$5,reviewed_sha=$6,
            reviewer_session_id=$7::uuid,findings=$8::jsonb,decision_id=gen_random_uuid(),updated_at=$5
      where review_run_id=$1 and task_id=$9 and status='pending'`,
    [item.run_id, verdict, actor, feedback, now, reviewedSha, dispatchSessionId, JSON.stringify(findings), item.task_id],
  );
  if (decidedReview.rowCount !== 1) throw new Error("fresh_review_pending_row_conflict");

  if (verdict === "approved") {
    await client.query("update loop_tasks set status='completed',updated_at=$2 where id=$1 and status='review_pending'", [item.task_id, now]);
    const stageAggregate = await client.query<{ complete: boolean }>(
      "select bool_and(status in ('completed','skipped')) complete from loop_tasks where stage_id=$1", [item.stage_id],
    );
    await client.query("update loop_stages set status=$2,updated_at=$3 where id=$1", [item.stage_id, stageAggregate.rows[0]?.complete ? "completed" : "in_progress", now]);
    await client.query(
      `update loop_tasks candidate set status='ready',updated_at=$2 from loop_stages stage
       where candidate.stage_id=stage.id and stage.plan_revision_id=$1 and candidate.status='pending'
         and not exists (select 1 from loop_task_dependencies d join loop_tasks dependency on dependency.id=d.depends_on_task_id
           where d.task_id=candidate.id and d.dependency_type='hard' and dependency.status<>'completed')`,
      [item.plan_revision_id, now],
    );
    const aggregate = (await client.query<{ complete: boolean; active_runs: number; unapproved: number }>(
      `select bool_and(t.status in ('completed','skipped')) complete,
              count(r.id) filter (where r.status in ('queued','running'))::int active_runs,
              count(*) filter (where t.status='completed' and not exists (
                select 1 from loop_task_runs impl join loop_task_reviews review on review.task_run_id=impl.id
                join loop_task_runs rr on rr.id=review.review_run_id and rr.task_id=t.id
                where impl.task_id=t.id and impl.run_role='implementation' and impl.status='succeeded'
                  and impl.quality_cycle=(select max(x.quality_cycle) from loop_task_runs x where x.task_id=t.id and x.run_role='implementation')
                  and impl.artifact_sha is not null and impl.server_session_id is not null
                  and review.status='approved' and review.reviewed_sha=impl.artifact_sha
                  and review.reviewer_session_id is distinct from impl.server_session_id and rr.status='succeeded'
              ))::int unapproved
         from loop_tasks t join loop_stages s on s.id=t.stage_id left join loop_task_runs r on r.task_id=t.id
        where s.plan_revision_id=$1`, [item.plan_revision_id],
    )).rows[0];
    const nextStatus = aggregate?.complete && aggregate.active_runs === 0 && aggregate.unapproved === 0 ? "in_review" : "in_progress";
    await client.query("update loops set status=$2,updated_at=$3,row_version=row_version+1 where id=$1 and status='in_progress'", [item.loop_id, nextStatus, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,'loop.task_review_approved','in_progress',$2,$3,$4::jsonb,$5)`,
      [item.loop_id, nextStatus, actor, JSON.stringify({ task_id: item.task_id, review_run_id: item.run_id,
        implementation_run_id: item.target_run_id, quality_cycle: item.quality_cycle, reviewed_sha: reviewedSha }), now],
    );
    return { applied: true, effect: "loop_task_review_approved", loopId: item.loop_id };
  }

  if (item.quality_cycle === 3) {
    await client.query("update loop_tasks set status='blocked',updated_at=$2 where id=$1 and status='review_pending'", [item.task_id, now]);
    await client.query("update loop_stages set status='blocked',updated_at=$2 where id=$1", [item.stage_id, now]);
    await client.query("update loops set status='blocked',updated_at=$2,row_version=row_version+1 where id=$1 and status='in_progress'", [item.loop_id, now]);
    await client.query(
      `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
       values ($1,'loop.quality_cycles_exhausted','in_progress','blocked',$2,$3::jsonb,$4)`,
      [item.loop_id, actor, JSON.stringify({ task_id: item.task_id, quality_cycle: 3, reviewed_sha: reviewedSha,
        findings_count: findings.length }), now],
    );
    return { applied: true, effect: "loop_quality_cycles_exhausted", loopId: item.loop_id };
  }

  await client.query("update loop_tasks set status='rework_required',updated_at=$2 where id=$1 and status='review_pending'", [item.task_id, now]);
  const token = (await client.query<{ id: string }>("select gen_random_uuid() id")).rows[0]?.id;
  const nextCycle = item.quality_cycle + 1;
  const implementationWork = await client.query<{ id: string }>(
    `insert into work_items(loop_id,parent_id,kind,source_type,source_id,title,instruction,status,priority,owner_agent,requested_by,payload)
     values ($1,null,'task','loop',$2,$3,$4,'ready',$5,$6,'system',$7::jsonb) returning id`,
    [item.loop_id, item.task_id, `Rework project task: ${item.task_title}`,
      `Quality cycle ${nextCycle}/3 rework for ${item.task_title}. Address the prior review feedback and findings, implement the task, run the required checks, and complete with output.head_sha for the new exact artifact.\n\nFeedback: ${feedback || "See findings."}\nFindings: ${JSON.stringify(findings)}`,
      item.priority || "medium", actor, JSON.stringify({
        materialized_from_loop: true, source_loop_id: item.loop_id, loop_task_id: item.task_id,
        plan_revision_id: item.plan_revision_id, plan_hash: item.content_hash, relation_type: "task_execution",
        runtime_contract: "fresh_review_v1", run_role: "implementation", quality_cycle: nextCycle,
        previous_review_run_id: item.run_id, execution_attempt_id: token, execution_generation: 1, dispatch_state: "ready",
      })],
  );
  const implementationWorkId = implementationWork.rows[0]?.id;
  if (!implementationWorkId || !token) throw new Error("rework_work_item_insert_failed");
  await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [item.loop_id, implementationWorkId]);
  await client.query(
    `insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,repository_id,base_sha,output,updated_at)
     values ($1,$2,$3,'implementation',$4,(select coalesce(max(attempt_number),0)+1 from loop_task_runs where task_id=$1),'queued',$5,$6,'{}'::jsonb,$7)`,
    [item.task_id, implementationWorkId, token, nextCycle, item.repository_id, item.base_sha, now],
  );
  await client.query("update loop_tasks set status='in_progress',updated_at=$2 where id=$1 and status='rework_required'", [item.task_id, now]);
  await client.query("update loop_stages set status='in_progress',updated_at=$2 where id=$1", [item.stage_id, now]);
  await client.query(
    `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
     values ($1,'loop.task_rework_started','in_progress','in_progress',$2,$3::jsonb,$4)`,
    [item.loop_id, actor, JSON.stringify({ task_id: item.task_id, previous_review_run_id: item.run_id,
      quality_cycle: nextCycle, findings_count: findings.length, work_item_id: implementationWorkId }), now],
  );
  return { applied: true, effect: "loop_task_rework_started", loopId: item.loop_id };
}

async function reconcilePrimaryLoopCompletion(
  client: CompletionQueryClient,
  workItem: WorkItemRow,
) {
  const linkedLoop = await client.query<{
    id: string;
    status: string;
    plan: unknown;
  }>(
    `SELECT l.id, l.status, l.plan
       FROM public.loop_work_items lwi
       INNER JOIN public.loops l ON l.id = lwi.loop_id AND l.workflow_version = 1
      WHERE lwi.work_item_id = $1
        AND lwi.relation_type = 'primary_execution'
      LIMIT 1
      FOR UPDATE OF l`,
    [workItem.id],
  );
  const loop = linkedLoop.rows[0];
  if (!loop) return { applied: false, reason: "not_loop_primary_execution" };

  const nextStatus = loop.status === "completed" ? "completed" : "in_review";
  const nextPlan = completePlan(loop.plan);
  const planWasAlreadyDone = Array.isArray(loop.plan)
    && loop.plan.every((step) => (
      !step || typeof step !== "object" || Array.isArray(step) || (step as JsonRecord).status === "done"
    ));
  if (loop.status === nextStatus && planWasAlreadyDone) {
    return { applied: false, reason: "loop_completion_already_reconciled", loopId: loop.id };
  }

  const now = new Date().toISOString();
  await client.query(
    `UPDATE public.loops
        SET status = $2,
            plan = $3::jsonb,
            updated_at = $4::timestamptz
      WHERE id = $1`,
    [loop.id, nextStatus, JSON.stringify(nextPlan), now],
  );
  await client.query(
    `INSERT INTO public.loop_events
       (loop_id, event_type, from_status, to_status, actor, payload, created_at)
     VALUES ($1, 'loop.primary_execution_completed', $2, $3, $4, $5::jsonb, $6::timestamptz)`,
    [
      loop.id,
      loop.status,
      nextStatus,
      readString(workItem.owner_agent) || "work-item-completion",
      JSON.stringify({
        work_item_id: workItem.id,
        relation_type: "primary_execution",
        work_item_status: "done",
        plan_steps_completed: nextPlan.length,
        dispatch_state: readString(asRecord(workItem.payload).dispatch_state),
      }),
      now,
    ],
  );
  return { applied: true, effect: "loop_primary_execution_completed", loopId: loop.id };
}

async function reconcilePrimaryLoopNeedsAttention(
  client: CompletionQueryClient,
  workItem: WorkItemRow,
  terminalStatus: "failed" | "canceled",
) {
  const linkedLoop = await client.query<{ id: string; status: string }>(
    `SELECT l.id, l.status
       FROM public.loop_work_items lwi
       INNER JOIN public.loops l ON l.id = lwi.loop_id AND l.workflow_version = 1
      WHERE lwi.work_item_id = $1
        AND lwi.relation_type = 'primary_execution'
      LIMIT 1
      FOR UPDATE OF l`,
    [workItem.id],
  );
  const loop = linkedLoop.rows[0];
  if (!loop) return { applied: false, reason: "not_loop_primary_execution" };

  const now = new Date().toISOString();
  const eventType = `loop.primary_execution_${terminalStatus}`;
  const reason = `primary_execution_${terminalStatus}_needs_attention`;
  await client.query(
    `UPDATE public.loops
        SET status = 'blocked', updated_at = $2::timestamptz
      WHERE id = $1`,
    [loop.id, now],
  );
  await client.query(
    `INSERT INTO public.loop_events
       (loop_id, event_type, from_status, to_status, actor, payload, created_at)
     VALUES ($1, $2, $3, 'blocked', $4, $5::jsonb, $6::timestamptz)`,
    [
      loop.id,
      eventType,
      loop.status,
      readString(workItem.owner_agent) || "work-item-completion",
      JSON.stringify({
        reason,
        work_item_id: workItem.id,
        relation_type: "primary_execution",
        work_item_status: terminalStatus,
        dispatch_state: readString(asRecord(workItem.payload).dispatch_state),
      }),
      now,
    ],
  );
  return { applied: true, effect: `loop_primary_execution_${terminalStatus}`, loopId: loop.id };
}

function resolvePipelineAction(workItem: WorkItemRow, pipelineItem: JsonRecord) {
  const payload = asRecord(workItem.payload);
  let pipelineType = readString(payload.pipeline_type) || readString(pipelineItem.pipeline_type) || "";
  let action = readString(payload.action) || "";
  const title = String(workItem.title || "").toLowerCase();
  const relationType = readString(payload.relation_type) || "";
  if (!action && pipelineType === "community_post") {
    if (relationType === "publish" || title.includes("publish")) action = "publish_community_post";
    else if (relationType === "schedule" || title.includes("schedule")) action = "schedule_community_post";
    else action = title.includes("revise") ? "revise_community_announcement" : "draft_guide_announcement";
  } else if (!action && ["blog", "doc", "guide"].includes(pipelineType)) {
    if (title.includes("publish")) action = pipelineType === "blog" ? "publish_blog" : "publish_guide";
    if (title.includes("localize")) action = pipelineType === "blog" ? "localize_blog_to_en" : "localize_guide_to_en";
  }
  pipelineType = pipelineType === "doc" ? "guide" : pipelineType;
  return { pipelineType, action, relationType };
}

/** Pure description of the network verification needed for this completion. */
export function buildPublicationVerificationRequest(
  workItem: WorkItemRow,
  pipelineItem: JsonRecord,
  body: JsonRecord,
): PublicationVerificationRequest | null {
  if (body.status !== "done") return null;
  const { pipelineType, action } = resolvePipelineAction(workItem, pipelineItem);
  const isBlog = pipelineType === "blog";
  const isGuide = pipelineType === "guide";
  if ((!isBlog && !isGuide) || (action !== "publish_blog" && action !== "publish_guide")) return null;
  const metadata = asRecord(pipelineItem.metadata);
  return {
    type: isGuide ? "guide" : "blog",
    url: extractCurrentUrl(body) || "",
    expectedTitle: typeof pipelineItem.title === "string" ? pipelineItem.title : "",
    expectedSlug: readString(pipelineItem.slug),
    expectedDescription: getNestedString(metadata, ["seo", "meta_description"])
      || getNestedString(metadata, ["draft_summary"])
      || getNestedString(metadata, ["summary"]),
  };
}

function extractCurrentUrl(body: JsonRecord) {
  const direct = readString(body.current_url);
  if (direct) return direct;
  const outputUrl = getNestedString(body.output, ["current_url"]);
  if (outputUrl) return outputUrl;
  const resultUrl = readString(body.result)?.match(/https?:\/\/\S+/)?.[0];
  return resultUrl?.replace(/[),.;]+$/, "") || null;
}

function extractCommunityCopy(body: JsonRecord) {
  const outputCopy = getNestedString(body.output, ["copy", "text"])
    || getNestedString(body.output, ["copy"])
    || getNestedString(body.output, ["text"]);
  if (outputCopy) return outputCopy;

  const result = readString(body.result);
  if (!result) return null;
  const labeledDraft = result.match(/(?:Draft community\/news post \(Spanish\)|Draft community\/news post|Draft news post|Borrador(?: listo)?(?: para aprobaci[oó]n)?(?:\s*[—:-]\s*noticia comunidad)?|Copy|Final copy|Texto final)\s*[:\n]+([\s\S]+)/i)?.[1]?.trim();
  const candidate = (labeledDraft || result)
    .replace(/\n+Recommendation:[\s\S]*$/i, "")
    .replace(/\n+Recomendaci[oó]n:[\s\S]*$/i, "")
    .trim();
  return /^(drafted|sent|validated|recommendation|publish after|copy listo|borrador listo|no publicado|hecho|listo)[\s\S]{0,220}$/i.test(candidate)
    ? null
    : candidate;
}

function extractScheduledFor(body: JsonRecord) {
  const direct = readString(body.scheduled_for);
  if (direct) return direct;
  const output = getNestedString(body.output, ["scheduled_for"])
    || getNestedString(body.output, ["schedule", "scheduled_for"]);
  if (output) return output;
  return readString(body.result)?.match(/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})/)?.[0] || null;
}

function isYouTubeGateKey(value: unknown): value is YouTubeGateKey {
  return typeof value === "string" && (YOUTUBE_GATE_ORDER as readonly string[]).includes(value);
}

function isYouTubeGateStatus(value: unknown): value is YouTubeGateStatus {
  return typeof value === "string" && (YOUTUBE_GATE_STATUSES as readonly string[]).includes(value);
}

function extractYouTubeGateStatus(body: JsonRecord) {
  const value = body.gate_status || getNestedString(body.output, ["gate_status"]);
  return isYouTubeGateStatus(value) ? value : null;
}

function extractYouTubeEvidenceSummary(body: JsonRecord) {
  return getNestedString(body.output, ["evidence_summary"])
    || getNestedString(body.output, ["summary"])
    || getNestedString(body.output, ["recommendation"])
    || readString(body.result)?.slice(0, 1800)
    || null;
}

function communityPublishTarget(metadata: JsonRecord) {
  const destinationKey = readString(metadata.intel_destination_key);
  const destinationLabel = readString(metadata.destination_label)?.toLowerCase() || "";
  const kind = readString(metadata.kind);
  const sourceType = readString(asRecord(metadata.source).type);

  if (destinationKey === "news" || destinationLabel === "news" || kind === "news" || metadata.intel) {
    return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia" };
  }
  if (destinationKey === "poll" || destinationLabel.includes("encuesta") || kind === "poll") {
    return { channelId: "1283759728798994533", channelName: "📔_encuestas" };
  }
  if (["blog", "guide", "doc", "video"].includes(String(sourceType || destinationKey || kind || ""))) {
    return { channelId: "1445797470662692864", channelName: "_📣anuncios" };
  }
  return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia" };
}

function isPublished(item: JsonRecord) {
  return item.status === "published" || item.status === "live" || Boolean(item.published_at) || Boolean(item.current_url);
}

async function ensureMappedWorkItem(client: CompletionQueryClient, input: {
  pipelineItemId: string;
  mapPipelineItemId?: string;
  relationType: string;
  mapRelationType?: string;
  action: string;
  title: string;
  instruction: string;
  ownerAgent: string;
  requestedBy: string;
  priority: string;
  scheduledFor?: string | null;
  trigger: string;
  payloadExtra?: JsonRecord;
}) {
  const existing = await client.query<WorkItemRow>(
    `SELECT *
       FROM public.work_items
      WHERE source_type = ANY($1::text[])
        AND source_id = $2
        AND status = ANY($3::text[])
        AND payload ->> 'action' = $4
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [["pipeline_item", "service"], input.pipelineItemId, ["draft", "ready", "blocked", "in_progress", "done"], input.action],
  );
  if (existing.rows[0]) return { row: existing.rows[0], created: false };

  const payload = {
    trigger: input.trigger,
    pipeline_type: input.payloadExtra?.pipeline_type,
    pipeline_item_id: input.pipelineItemId,
    relation_type: input.relationType,
    action: input.action,
    ...(input.payloadExtra || {}),
  };
  const inserted = await client.query<WorkItemRow>(
    `INSERT INTO public.work_items (
       kind, source_type, source_id, title, instruction, status, priority,
       owner_agent, target_agent_id, requested_by, scheduled_for, payload
     ) VALUES ('task', 'pipeline_item', $1, $2, $3, 'ready', $4, $5, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.pipelineItemId,
      input.title,
      input.instruction,
      input.priority,
      input.ownerAgent,
      input.requestedBy,
      input.scheduledFor || null,
      JSON.stringify(payload),
    ],
  );
  const row = inserted.rows[0];
  const mapPipelineItemId = input.mapPipelineItemId || input.pipelineItemId;
  const mapRelationType = input.mapRelationType || input.relationType;
  await client.query(
    `INSERT INTO public.pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (pipeline_item_id, work_item_id, relation_type) DO NOTHING`,
    [mapPipelineItemId, row.id, mapRelationType],
  );
  await client.query(
    `INSERT INTO public.pipeline_events (pipeline_item_id, event_type, actor, payload)
     VALUES ($1, 'pipeline_item.work_item_created', 'work-item-completion', $2::jsonb)`,
    [mapPipelineItemId, JSON.stringify({ work_item_id: row.id, relation_type: input.relationType, action: input.action })],
  );
  return { row, created: true };
}

async function ensureCommunityPublishWorkItem(client: CompletionQueryClient, item: JsonRecord, workItem: WorkItemRow, scheduledFor: string) {
  const metadata = asRecord(item.metadata);
  const copy = asRecord(metadata.copy);
  const target = communityPublishTarget(metadata);
  const title = readString(item.title) || readString(workItem.title) || "Community post";
  return ensureMappedWorkItem(client, {
    pipelineItemId: String(item.id),
    relationType: "publish",
    action: "publish_community_post",
    title: `Publish community post: ${title}`,
    instruction: [
      `Publish community post "${title}".`,
      `Pipeline item ID: ${item.id}.`,
      `Publish to <#${target.channelId}> (${target.channelName}).`,
      "Publish only the approved copy and wrap raw URLs as <https://...> to suppress previews.",
      "Complete this work item with current_url and published_at when available.",
      readString(copy.text) ? `Approved copy:\n${copy.text}` : null,
    ].filter(Boolean).join("\n\n"),
    ownerAgent: "community",
    requestedBy: readString(item.requested_by) || readString(workItem.requested_by) || "mission-control",
    priority: readString(item.priority) || readString(workItem.priority) || "medium",
    scheduledFor,
    trigger: "community_schedule",
    payloadExtra: {
      pipeline_type: "community_post",
      schedule_kind: "publication",
      target_channel_id: target.channelId,
      target_channel_name: target.channelName,
      log_channel_id: "1473660854800224316",
      suppress_link_previews: true,
    },
  });
}

async function resolveGuideSchedule(client: CompletionQueryClient, pipelineItem: JsonRecord, metadata: JsonRecord) {
  const existing = readString(pipelineItem.scheduled_for) || getNestedString(metadata, ["schedule", "scheduled_for"]);
  if (existing) return { scheduledFor: existing, source: "existing" };

  const occupiedResult = await client.query<{ scheduled_for: string | Date }>(
    `SELECT scheduled_for
       FROM public.work_items
      WHERE status = ANY($1::text[])
        AND scheduled_for IS NOT NULL
        AND scheduled_for > now()
        AND payload ->> 'schedule_kind' = 'publication'`,
    [["draft", "ready", "blocked", "in_progress"]],
  );
  const occupied = new Set(occupiedResult.rows.map((row) => new Date(row.scheduled_for).toISOString()));
  const candidate = new Date();
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCHours(12, 0, 0, 0);
  for (let day = 0; day < 30; day += 1) {
    if (candidate.getUTCDay() !== 0 && candidate.getUTCDay() !== 6) {
      for (const hour of [12, 19]) {
        candidate.setUTCHours(hour, 0, 0, 0);
        if (!occupied.has(candidate.toISOString())) return { scheduledFor: candidate.toISOString(), source: "auto_allocated" };
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return { scheduledFor: candidate.toISOString(), source: "auto_allocated" };
}

async function createGuideAnnouncement(client: CompletionQueryClient, guide: JsonRecord, url: string, workItem: WorkItemRow) {
  const existing = await client.query<JsonRecord>(
    `SELECT * FROM public.pipeline_items
      WHERE pipeline_type = 'community_post' AND source_id = $1
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [guide.id],
  );
  let communityItem = existing.rows[0];
  if (!communityItem) {
    const title = readString(guide.title) || "published guide";
    const slug = readString(guide.slug);
    const inserted = await client.query<JsonRecord>(
      `INSERT INTO public.pipeline_items (
         pipeline_type, title, slug, status, priority, owner_agent, requested_by,
         source_type, source_id, metadata
       ) VALUES ('community_post', $1, $2, 'draft', $3, 'community', $4, 'manual', $5, $6::jsonb)
       RETURNING *`,
      [
        `Announce guide: ${title}`,
        slug ? `announce-${slug}` : null,
        readString(guide.priority) || "medium",
        readString(workItem.requested_by) || readString(guide.requested_by) || "mission-control",
        guide.id,
        JSON.stringify({
          kind: "guide_announcement",
          channel: "discord",
          source: { type: readString(guide.pipeline_type) || "guide", pipeline_item_id: guide.id, url, title, slug },
          copy: { text: "", poll_options: [] },
          automation: { trigger: "published_content_verified", created_at: new Date().toISOString() },
        }),
      ],
    );
    communityItem = inserted.rows[0];
  }

  const guideTitle = readString(guide.title) || "published guide";
  await ensureMappedWorkItem(client, {
    pipelineItemId: String(communityItem.id),
    relationType: "distribute_community",
    action: "draft_guide_announcement",
    title: `Draft Discord announcement: ${guideTitle}`,
    instruction: [
      `Community post item: ${communityItem.title}`,
      "Draft a concise Discord announcement for this newly published guide.",
      "Include the guide link and leave it ready for review; do not publish directly.",
      `Guide: ${guideTitle}`,
      `URL: ${url}`,
    ].join("\n\n"),
    ownerAgent: "community",
    requestedBy: readString(workItem.requested_by) || readString(guide.requested_by) || "mission-control",
    priority: readString(guide.priority) || "medium",
    trigger: "published_content_verified",
    payloadExtra: { pipeline_type: "community_post", source_guide_pipeline_item_id: guide.id },
  });
}

async function updatePipelineItem(client: CompletionQueryClient, id: string, status: string, metadata: JsonRecord, extra: {
  scheduledFor?: string | null;
  publishedAt?: string | null;
  currentUrl?: string | null;
} = {}) {
  await client.query(
    `UPDATE public.pipeline_items
        SET status = $2,
            metadata = $3::jsonb,
            scheduled_for = CASE WHEN $4::boolean THEN $5::timestamptz ELSE scheduled_for END,
            published_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE published_at END,
            current_url = CASE WHEN $8::boolean THEN $9::text ELSE current_url END,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      status,
      JSON.stringify(metadata),
      extra.scheduledFor !== undefined,
      extra.scheduledFor ?? null,
      extra.publishedAt !== undefined,
      extra.publishedAt ?? null,
      extra.currentUrl !== undefined,
      extra.currentUrl ?? null,
    ],
  );
}

export async function orchestrateWorkItemCompletion(
  client: CompletionQueryClient,
  input: CompletionOrchestrationInput,
) {
  const { existing, updated, body, publicationVerification } = input;
  // Runtime identity comes from the locked persisted row, never from an
  // agent-mutated payload assembled earlier in this transaction.
  const v2TaskExecution = await reconcileV2TaskExecution(client, existing, body);
  if (v2TaskExecution) return v2TaskExecution;

  // V1 primary_execution orchestration is intentionally unchanged below.
  if (body.status === "canceled" && existing.status !== "canceled") {
    return reconcilePrimaryLoopNeedsAttention(client, updated, "canceled");
  }
  if (body.status === "failed" && existing.status !== "failed") {
    return reconcilePrimaryLoopNeedsAttention(client, updated, "failed");
  }
  if (body.status !== "done" || existing.status === "done") return { applied: false, reason: "not_a_new_completion" };

  const loopCompletion = await reconcilePrimaryLoopCompletion(client, updated);

  const payload = asRecord(updated.payload);
  const sourcePipelineItemId = ["pipeline_item", "service"].includes(String(updated.source_type || ""))
    ? readString(updated.source_id)
    : null;
  const pipelineItemId = readString(payload.pipeline_item_id) || sourcePipelineItemId;
  if (!pipelineItemId) {
    return loopCompletion.applied
      ? loopCompletion
      : { applied: false, reason: "not_pipeline_backed" };
  }

  const pipelineResult = await client.query<JsonRecord>(
    "SELECT * FROM public.pipeline_items WHERE id = $1 LIMIT 1 FOR UPDATE",
    [pipelineItemId],
  );
  const pipelineItem = pipelineResult.rows[0];
  if (!pipelineItem) return { applied: false, reason: "pipeline_item_not_found" };

  const { pipelineType, action, relationType } = resolvePipelineAction(updated, pipelineItem);

  const now = new Date().toISOString();
  const metadata = asRecord(pipelineItem.metadata);

  if (pipelineType === "video" && action.startsWith("youtube_gate_")) {
    const candidateGate = relationType || action.replace("youtube_gate_", "");
    if (isYouTubeGateKey(candidateGate)) {
      const youtubeMetadata = getYouTubeMetadata(metadata);
      const previousGate = getGateEntry(youtubeMetadata, candidateGate);
      const nextStatus = extractYouTubeGateStatus(body)
        || (previousGate.status === "not_started" || !previousGate.status ? "in_progress" : previousGate.status);
      const evidenceSummary = extractYouTubeEvidenceSummary(body);
      const nextMetadata = {
        ...youtubeMetadata,
        gates: {
          ...asRecord(youtubeMetadata.gates),
          [candidateGate]: {
            ...previousGate,
            status: nextStatus,
            evidence_summary: evidenceSummary || previousGate.evidence_summary,
            work_item_id: updated.id,
            updated_at: now,
            history: [
              ...(Array.isArray(previousGate.history) ? previousGate.history : []),
              buildGateHistoryEntry({
                at: now,
                by: readString(updated.owner_agent) || "youtube",
                status: nextStatus,
                reason: previousGate.reason || null,
                evidenceSummary: evidenceSummary || previousGate.evidence_summary || null,
                nextAction: previousGate.next_action || null,
                scores: getScores(youtubeMetadata),
              }),
            ],
          },
        },
        runtime_feedback: {
          ...asRecord(youtubeMetadata.runtime_feedback),
          last_status: "youtube_gate_work_completed",
          last_work_item_id: updated.id,
          last_gate_key: candidateGate,
          updated_at: now,
        },
      };
      await updatePipelineItem(
        client,
        pipelineItemId,
        derivePipelineItemStatus(nextMetadata, {
          currentStatus: readString(pipelineItem.status),
          publishedAt: pipelineItem.published_at ? String(pipelineItem.published_at) : null,
        }),
        nextMetadata,
      );
      return { applied: true, effect: "youtube_gate" };
    }
  }

  if (pipelineType === "community_post") {
    if (action === "publish_community_post") {
      const currentUrl = extractCurrentUrl(body);
      await updatePipelineItem(client, pipelineItemId, "published", {
        ...metadata,
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: "published",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      }, {
        publishedAt: readString(body.published_at) || now,
        currentUrl,
      });
      return { applied: true, effect: "community_published" };
    }

    const draftActions = new Set([
      "draft_guide_announcement",
      "revise_community_announcement",
      "draft_community_news",
      "develop_community_post",
    ]);
    if (draftActions.has(action)) {
      const copyText = extractCommunityCopy(body);
      const copyMetadata = asRecord(metadata.copy);
      await updatePipelineItem(client, pipelineItemId, copyText ? "ready_for_review" : "draft", {
        ...metadata,
        copy: { ...copyMetadata, text: copyText || copyMetadata.text || "" },
        ...(!copyText ? {
          review: {
            ...asRecord(metadata.review),
            notes: "Community work item completed without announcement copy. Needs a clean re-draft before review.",
            last_requested_at: now,
            last_requested_by: "system",
          },
        } : {}),
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: copyText ? "copy_saved" : "completed_without_copy",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      });
      return { applied: true, effect: "community_draft" };
    }

    if (action === "schedule_community_post") {
      const scheduledFor = extractScheduledFor(body);
      const alreadyPublished = isPublished(pipelineItem);
      const publishWork = scheduledFor && !alreadyPublished
        ? await ensureCommunityPublishWorkItem(client, pipelineItem, updated, scheduledFor)
        : null;
      const previousSchedule = asRecord(metadata.schedule);
      const publishWorkItemId = alreadyPublished
        ? readString(previousSchedule.publish_work_item_id)
        : readString(publishWork?.row.id);
      await updatePipelineItem(client, pipelineItemId, alreadyPublished
        ? String(pipelineItem.status)
        : scheduledFor ? "scheduled" : "approved", {
        ...metadata,
        schedule: {
          ...previousSchedule,
          scheduled_for: scheduledFor,
          scheduled_at: now,
          scheduled_by: readString(updated.owner_agent) || "community",
          source: "work_items",
          publish_work_item_id: publishWorkItemId,
        },
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: alreadyPublished
            ? "schedule_skipped_already_published"
            : scheduledFor ? "publish_work_item_scheduled" : "schedule_missing_date",
          last_work_item_id: updated.id,
          publish_work_item_id: publishWorkItemId,
          updated_at: now,
        },
      }, { scheduledFor: null });
      return { applied: true, effect: "community_scheduled" };
    }
  }

  if (pipelineType === "email_campaign") {
    const emailDraft = asRecord(asRecord(body.output).email_draft);
    if (Object.keys(emailDraft).length) {
      await updatePipelineItem(client, pipelineItemId, "ready_for_review", {
        ...metadata,
        draft: emailDraft,
        review: {
          ...asRecord(metadata.review),
          status: "ready_for_review",
          ready_at: now,
          source_work_item_id: updated.id,
        },
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: "draft_saved",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      });
      return { applied: true, effect: "email_draft" };
    }
  }

  const isBlog = pipelineType === "blog";
  const isGuide = pipelineType === "guide";
  const localizeAction = action === "localize_blog_to_en" || action === "localize_guide_to_en";
  if ((isBlog || isGuide) && localizeAction) {
    const localization = { ...asRecord(metadata.localization), en_ready: true, translated_at: now };
    if (isBlog) {
      await updatePipelineItem(client, pipelineItemId, "final_check", {
        ...metadata,
        localization,
        final_check: {
          ...asRecord(metadata.final_check),
          status: "ready",
          ready_at: now,
          source_work_item_id: updated.id,
        },
      });
    } else {
      const schedule = await resolveGuideSchedule(client, pipelineItem, metadata);
      const publishWork = await ensureMappedWorkItem(client, {
        pipelineItemId,
        relationType: "publish",
        action: "publish_guide",
        title: `Publish guide: ${readString(pipelineItem.title) || readString(updated.title) || "Guide"}`,
        instruction: [
          `Pipeline guide item: ${readString(pipelineItem.title) || readString(updated.title) || "Guide"}`,
          "Publish the guide to the website.",
          "When done, complete the work item with current_url and optional notes.",
        ].join("\n\n"),
        ownerAgent: "dev",
        requestedBy: readString(updated.requested_by) || "mission-control",
        priority: readString(pipelineItem.priority) || readString(updated.priority) || "medium",
        scheduledFor: schedule.scheduledFor,
        trigger: "work_item_completion",
        payloadExtra: { pipeline_type: "guide", schedule_kind: "publication" },
      });
      await updatePipelineItem(client, pipelineItemId, "scheduled", {
        ...metadata,
        localization,
        schedule: {
          ...asRecord(metadata.schedule),
          scheduled_for: schedule.scheduledFor,
          scheduled_at: now,
          scheduled_by: readString(updated.owner_agent) || "content",
          source: schedule.source,
          publish_work_item_id: publishWork.row.id,
        },
      }, { scheduledFor: schedule.scheduledFor });
    }
    return { applied: true, effect: "content_localized" };
  }

  const publishAction = action === "publish_blog" || action === "publish_guide";
  if ((isBlog || isGuide) && publishAction) {
    const publishUrl = extractCurrentUrl(body);
    const verificationRequest = buildPublicationVerificationRequest(updated, pipelineItem, body);
    if (!verificationRequest || !publicationVerification) {
      throw new Error("Publication verification must be completed before opening the completion transaction");
    }
    const verificationSnapshotMatches = publicationVerification.workItemId === String(existing.id)
      && publicationVerification.workItemUpdatedAt === (existing.updated_at ? String(existing.updated_at) : null)
      && publicationVerification.pipelineItemId === String(pipelineItem.id)
      && publicationVerification.pipelineItemUpdatedAt === (pipelineItem.updated_at ? String(pipelineItem.updated_at) : null);
    if (!verificationSnapshotMatches) {
      throw new Error("Publication verification snapshot changed; retry completion against the current rows");
    }
    if (JSON.stringify(verificationRequest) !== JSON.stringify(publicationVerification.request)) {
      throw new Error("Publication verification became stale; retry completion against the current pipeline item");
    }
    const verification = publicationVerification.result;
    const verificationMetadata = {
      ...asRecord(metadata.publication_verification),
      checked_at: now,
      work_item_id: updated.id,
      url: publishUrl,
      result: verification,
    };
    if (verification.ok) {
      const liveUrl = readString(verification.finalUrl) || publishUrl;
      await updatePipelineItem(client, pipelineItemId, "live", {
        ...metadata,
        publication_verification: verificationMetadata,
      }, {
        publishedAt: readString(body.published_at) || now,
        currentUrl: liveUrl,
      });
      if (isGuide && liveUrl) await createGuideAnnouncement(client, pipelineItem, liveUrl, updated);
    } else {
      await updatePipelineItem(client, pipelineItemId, String(pipelineItem.status), {
        ...metadata,
        publication_verification: verificationMetadata,
      });
      await client.query(
        `INSERT INTO public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
         VALUES ('content', 'published_content.verification_failed', 'pipeline_item', $1, $2, $3::jsonb)`,
        [pipelineItemId, readString(updated.owner_agent) || "dev", JSON.stringify({
          pipeline_type: pipelineType,
          action,
          work_item_id: updated.id,
          verification,
        })],
      );
    }
    return { applied: true, effect: "content_published", verified: verification.ok };
  }

  return { applied: false, reason: "no_completion_effect" };
}
