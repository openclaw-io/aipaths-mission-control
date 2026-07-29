import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";
import { getExecutionWindowConfig, isExecutionWindowOpenNow } from "@/lib/execution-window";
import { buildLoopExecutionInstruction, buildLoopTaskExecutionInstruction } from "@/lib/loops/execution-instruction";
import { captureRegisteredRepositoryHead, type RegisteredRepository } from "@/lib/work-items/git-artifact";
import {
  getPrimaryExecutionWorkItemLocal,
  isPrimaryExecutionOpen,
  reconcileLoopStatusWithPrimaryExecutionLocal,
  supersedePrimaryExecutionLinksLocal,
} from "@/lib/loops/lifecycle-local";

type ClarificationQuestion = {
  id?: string;
  question?: string | null;
  status?: string | null;
  answer?: string | null;
};

type ClarificationHistoryEntry = {
  response?: string | null;
  responded_at?: string | null;
  responded_by?: string | null;
};

type LoopRow = {
  id: string;
  name: string | null;
  description: string | null;
  summary: string | null;
  status: string;
  workflow_version: number;
  current_plan_revision_id: string | null;
  row_version: string | number;
  priority: "high" | "medium" | "low" | null;
  owner_agent: string | null;
  target_outcome: string | null;
  acceptance_criteria: string[] | null;
  plan: Array<{ title?: string; status?: string; notes?: string | null }> | null;
  clarification_questions: ClarificationQuestion[] | null;
  metadata: {
    original_input?: string | null;
    clarification_history?: ClarificationHistoryEntry[] | null;
  } | null;
  approval_scope: {
    approved?: boolean;
    can_execute_unattended?: boolean;
    allowed_actions?: string[] | null;
    forbidden_actions?: string[] | null;
    notes?: string | null;
  } | null;
};

type TransactionClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalJson(child)]));
  return value;
}
function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}
function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}
function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function materializeV2Task(client: TransactionClient, candidate: LoopRow, now: string) {
  const lockedResult = await client.query<LoopRow>(
    `select id,name,status,priority,owner_agent,approval_scope,workflow_version,current_plan_revision_id,row_version
       from loops where id=$1 for update`,
    [candidate.id],
  );
  const loop = lockedResult.rows[0];
  if (!loop || loop.workflow_version !== 2 || !["queued", "in_progress"].includes(loop.status)) {
    return { action: "skipped" as const, reason: "loop_status_changed" };
  }
  if (!loop.current_plan_revision_id) return { action: "skipped" as const, reason: "current_revision_missing" };
  const revisionResult = await client.query<{
    status: string; content_hash: string | null; plan_snapshot: Record<string, unknown> | null;
  }>(
    "select status,content_hash,plan_snapshot from loop_plan_revisions where id=$1 and loop_id=$2 for update",
    [loop.current_plan_revision_id, loop.id],
  );
  const revision = revisionResult.rows[0];
  const scope = asRecord(loop.approval_scope);
  if (revision?.status !== "approved" || !revision.content_hash || !revision.plan_snapshot
    || sha256(revision.plan_snapshot) !== revision.content_hash) {
    return { action: "skipped" as const, reason: "current_revision_not_approved_exactly" };
  }
  if (scope.approved !== true || scope.can_execute_unattended !== true
    || scope.approved_plan_revision_id !== loop.current_plan_revision_id
    || scope.approved_plan_hash !== revision.content_hash) {
    return { action: "skipped" as const, reason: "approval_scope_not_exact" };
  }
  const snapshot = asRecord(revision.plan_snapshot);
  const snapshotOwner = typeof snapshot.owner_agent === "string" ? snapshot.owner_agent : null;
  if (!loop.owner_agent || loop.owner_agent !== snapshotOwner) {
    return { action: "skipped" as const, reason: "owner_not_exact" };
  }
  const snapshotRepository = asRecord(snapshot.repository);
  const repositoryId = typeof snapshotRepository.id === "string" ? snapshotRepository.id : null;
  const repositoryKey = typeof snapshotRepository.key === "string" ? snapshotRepository.key : null;
  if (!repositoryId || !repositoryKey) return { action: "skipped" as const, reason: "approved_repository_missing" };
  const repository = (await client.query<RegisteredRepository & { key: string }>(
    `select id,key,canonical_root,git_common_dir,object_format,enabled from review_repositories where id=$1 and key=$2 and enabled=true for share`,
    [repositoryId, repositoryKey],
  )).rows[0];
  if (!repository) return { action: "skipped" as const, reason: "approved_repository_disabled_or_changed" };
  const repositoryHead = await captureRegisteredRepositoryHead(repository);

  await client.query(
    `select t.id from loop_tasks t join loop_stages s on s.id=t.stage_id
      where s.plan_revision_id=$1 order by s.position,s.id,t.position,t.id for update of t,s`,
    [loop.current_plan_revision_id],
  );

  const graphRows = await client.query<{
    stage_id: string; stage_key: string; stage_title: string; stage_description: string | null; stage_position: number;
    stage_status: string; id: string; key: string; title: string; description: string | null;
    position: number; status: string; assignee_agent: string | null; dependencies: Array<{ key: string; type: string }>;
  }>(
    `select s.id stage_id,s.key stage_key,s.title stage_title,s.description stage_description,s.position stage_position,s.status stage_status,
            t.id,t.key,t.title,t.description,t.position,t.status,t.assignee_agent,
            coalesce(jsonb_agg(jsonb_build_object('key',dt.key,'type',d.dependency_type)
              order by dt.key,d.dependency_type) filter (where d.task_id is not null),'[]'::jsonb) dependencies
       from loop_stages s join loop_tasks t on t.stage_id=s.id
       left join loop_task_dependencies d on d.task_id=t.id left join loop_tasks dt on dt.id=d.depends_on_task_id
      where s.plan_revision_id=$1 group by s.id,t.id order by s.position,s.id,t.position,t.id`,
    [loop.current_plan_revision_id],
  );
  const graphStages: Array<Record<string, unknown>> = [];
  for (const row of graphRows.rows) {
    let stage = graphStages.find((entry) => entry.key === row.stage_key) as Record<string, unknown> | undefined;
    if (!stage) {
      stage = { key: row.stage_key, title: row.stage_title, description: row.stage_description,
        position: row.stage_position, tasks: [] };
      graphStages.push(stage);
    }
    (stage.tasks as Array<unknown>).push({ key: row.key, title: row.title, description: row.description,
      assignee_agent: row.assignee_agent, position: row.position, dependencies: row.dependencies });
  }
  if (!sameJson(graphStages, snapshot.stages)) {
    return { action: "skipped" as const, reason: "approved_snapshot_graph_drift" };
  }

  const active = await client.query<{ work_item_id: string }>(
    `select r.work_item_id from loop_task_runs r
       join loop_tasks t on t.id=r.task_id join loop_stages s on s.id=t.stage_id
      where s.plan_revision_id=$1 and r.status in ('queued','running')
      order by r.created_at,r.id limit 1 for update of r`,
    [loop.current_plan_revision_id],
  );
  if (active.rows[0]) return { action: "reconciled_existing" as const, workItemId: active.rows[0].work_item_id };

  const eligible = graphRows.rows.find((candidateTask) => {
    if (!["pending", "ready"].includes(candidateTask.status)) return false;
    return !graphRows.rows.some((dependency) => candidateTask.dependencies.some((edge) => (
      edge.type === "hard" && edge.key === dependency.key && dependency.status !== "completed"
    )));
  });
  if (!eligible) return { action: "skipped" as const, reason: "no_eligible_task" };
  const priorRuns = await client.query<{ count: number }>("select count(*)::int count from loop_task_runs where task_id=$1", [eligible.id]);
  if (priorRuns.rows[0]?.count !== 0) return { action: "skipped" as const, reason: "eligible_task_has_run" };
  const snapshotStages = Array.isArray(snapshot.stages) ? snapshot.stages : [];
  const snapshotStage = snapshotStages.map(asRecord).find((entry) => entry.key === eligible.stage_key);
  const snapshotTask = (Array.isArray(snapshotStage?.tasks) ? snapshotStage.tasks : []).map(asRecord)
    .find((entry) => entry.key === eligible.key);
  if (!snapshotTask) return { action: "skipped" as const, reason: "task_missing_from_snapshot" };

  const executionAttemptId = randomUUID();
  const work = await client.query<{ id: string }>(
    `insert into work_items
      (loop_id,parent_id,kind,source_type,source_id,title,instruction,status,priority,owner_agent,requested_by,payload)
     values ($1,null,'task','loop',$2,$3,$4,'ready',$5,$6,'system',$7::jsonb) returning id`,
    [loop.id, eligible.id, `Execute project task: ${String(snapshotTask.title)}`, buildLoopTaskExecutionInstruction({
      taskKey: String(snapshotTask.key), title: String(snapshotTask.title),
      description: typeof snapshotTask.description === "string" ? snapshotTask.description : null,
      acceptanceCriteria: Array.isArray(snapshot.acceptance_criteria) ? snapshot.acceptance_criteria as string[] : [],
      approvalScope: asRecord(snapshot.approval_policy),
    }), loop.priority || "medium", typeof snapshotTask.assignee_agent === "string" ? snapshotTask.assignee_agent : snapshotOwner,
    JSON.stringify({ materialized_from_loop: true, source_loop_id: loop.id, loop_task_id: eligible.id,
      loop_task_key: eligible.key, plan_revision_id: loop.current_plan_revision_id, plan_hash: revision.content_hash,
      relation_type: "task_execution", runtime_contract: "fresh_review_v1", run_role: "implementation", quality_cycle: 1,
      execution_attempt_id: executionAttemptId, execution_generation: 1, dispatch_state: "ready" })],
  );
  const workItemId = work.rows[0]?.id;
  if (!workItemId) throw new Error("work_item_insert_failed");
  await client.query("insert into loop_work_items(loop_id,work_item_id,relation_type) values ($1,$2,'task_execution')", [loop.id, workItemId]);
  await client.query(
    `insert into loop_task_runs(task_id,work_item_id,execution_attempt_id,run_role,quality_cycle,attempt_number,status,repository_id,base_sha,output,updated_at)
     values ($1,$2,$3,'implementation',1,1,'queued',$4,$5,'{}'::jsonb,$6)`,
    [eligible.id, workItemId, executionAttemptId, repository.id, repositoryHead.sha, now],
  );
  await client.query("update loop_tasks set status='in_progress',updated_at=$2 where id=$1 and status in ('pending','ready')", [eligible.id, now]);
  await client.query("update loop_stages set status='in_progress',updated_at=$2 where id=$1 and status in ('pending','ready','in_progress')", [eligible.stage_id, now]);
  const updated = await client.query<{ id: string }>(
    `update loops set status='in_progress',last_started_at=coalesce(last_started_at,$2),updated_at=$2,row_version=row_version+1
      where id=$1 and row_version=$3 and status in ('queued','in_progress') returning id`,
    [loop.id, now, loop.row_version],
  );
  if (!updated.rows[0]) throw new Error("loop_version_changed");
  await client.query(
    `insert into loop_events(loop_id,event_type,from_status,to_status,actor,payload,created_at)
     values ($1,'loop.task_materialized',$2,'in_progress','loop-execution-materializer',$3::jsonb,$4)`,
    [loop.id, loop.status, JSON.stringify({ task_id: eligible.id, task_key: eligible.key, work_item_id: workItemId,
      execution_attempt_id: executionAttemptId, plan_revision_id: loop.current_plan_revision_id,
      plan_hash: revision.content_hash, relation_type: "task_execution" }), now],
  );
  return { action: "materialized" as const, workItemId };
}

export const dynamic = "force-dynamic";

function checkInternalAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

export async function POST(request: NextRequest) {
  if (!checkInternalAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();
  const executionWindowConfig = await getExecutionWindowConfig();

  if (!executionWindowConfig) {
    return NextResponse.json({ error: "execution_window_config_missing" }, { status: 500 });
  }

  const windowState = isExecutionWindowOpenNow(executionWindowConfig, new Date());
  if (!windowState.open) {
    return NextResponse.json({
      materialized: 0,
      skipped: 0,
      details: [],
      window: {
        open: false,
        source: windowState.source,
        mode: windowState.mode,
      },
    });
  }

  const { rows: loops } = await query(`
    SELECT id,name,description,summary,status,priority,owner_agent,target_outcome,acceptance_criteria,plan,clarification_questions,metadata,approval_scope,last_approved_at,updated_at,workflow_version,current_plan_revision_id,row_version
    FROM public.loops
    WHERE (status = 'queued' OR (workflow_version=2 AND status='in_progress'))
      AND (workflow_version <> 2 OR NOT EXISTS (
        SELECT 1 FROM loop_plan_revisions pr
        JOIN loop_stages s ON s.plan_revision_id=pr.id
        JOIN loop_tasks t ON t.stage_id=s.id
        JOIN loop_task_runs r ON r.task_id=t.id
        WHERE pr.id=loops.current_plan_revision_id AND r.status IN ('queued','running')
      ))
    ORDER BY updated_at ASC, id ASC
    LIMIT 20
  `);

  if (!loops.length) return NextResponse.json({ materialized: 0, skipped: 0, details: [] });

  let materialized = 0;
  let skipped = 0;
  const details: Array<{ loopId: string; action: string; reason?: string; workItemId?: string }> = [];

  for (const loop of loops as LoopRow[]) {
    // V2 authorization and ownership are checked again only from the approved
    // snapshot while holding the Loop lock. V1 retains its legacy preflight.
    if (loop.workflow_version === 1 && (!loop.approval_scope?.approved || !loop.approval_scope?.can_execute_unattended)) {
      skipped++;
      details.push({ loopId: loop.id, action: "skipped", reason: "approval_scope_not_ready" });
      continue;
    }

    if (loop.workflow_version === 1 && !loop.owner_agent) {
      skipped++;
      details.push({ loopId: loop.id, action: "skipped", reason: "missing_owner_agent" });
      continue;
    }

    try {
      const outcome = await withTransaction(async (client) => {
        if (loop.workflow_version === 2) {
          return materializeV2Task(client, loop, now);
        }
        // Explicit V1 branch: retain the original primary_execution runtime.
        const primaryExecution = await getPrimaryExecutionWorkItemLocal(loop.id, client);

        if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
          await reconcileLoopStatusWithPrimaryExecutionLocal(client, {
            loopId: loop.id,
            loopStatus: loop.status,
            primaryExecution,
            actor: "loop-execution-materializer",
            reason: "materialize_queued_existing_primary_execution",
            loopUpdates: { last_started_at: now },
            now,
          });

          return { action: "reconciled_existing" as const, workItemId: primaryExecution.workItemId };
        }

        const workItem = await client.query<{ id: string }>(`
          INSERT INTO public.work_items (
            loop_id,
            parent_id,
            kind,
            source_type,
            source_id,
            title,
            instruction,
            status,
            priority,
            owner_agent,
            requested_by,
            payload
          ) VALUES ($1, NULL, 'task', 'loop', $2, $3, $4, 'ready', $5, $6, 'system', $7::jsonb)
          RETURNING id
        `, [
          loop.id,
          loop.id,
          `Execute loop: ${loop.name || "Untitled Loop"}`,
          buildLoopExecutionInstruction(loop),
          loop.priority || "medium",
          loop.owner_agent,
          JSON.stringify({
            materialized_from_loop: true,
            source_loop_id: loop.id,
            source_loop_title: loop.name || "Untitled Loop",
            materializer: "loop-execution-materializer",
            loop_status_at_materialization: loop.status,
            execution_attempt_id: randomUUID(),
            execution_generation: 1,
            dispatch_state: "ready",
          }),
        ]);

        const workItemId = workItem.rows[0]?.id;
        if (!workItemId) throw new Error("work_item_insert_failed");

        await supersedePrimaryExecutionLinksLocal(client, loop.id, workItemId, "loop-execution-materializer");

        await client.query(`
          INSERT INTO public.loop_work_items (loop_id, work_item_id, relation_type)
          VALUES ($1, $2, 'primary_execution')
        `, [loop.id, workItemId]);

        const loopUpdate = await client.query(`
          UPDATE public.loops
          SET status = 'in_progress',
              last_started_at = $1::timestamptz,
              updated_at = $1::timestamptz
          WHERE id = $2
            AND status = 'queued'
          RETURNING id
        `, [now, loop.id]);

        if (!loopUpdate.rows[0]) throw new Error("loop_status_changed");

        await client.query(`
          INSERT INTO public.loop_events (loop_id, event_type, from_status, to_status, actor, payload)
          VALUES
            ($1, 'loop.execution_materialized', 'queued', 'in_progress', 'loop-execution-materializer', $2::jsonb),
            ($1, 'loop.started', 'queued', 'in_progress', 'loop-execution-materializer', $3::jsonb)
        `, [
          loop.id,
          JSON.stringify({
            work_item_id: workItemId,
            relation_type: "primary_execution",
          }),
          JSON.stringify({
            work_item_id: workItemId,
            owner_agent: loop.owner_agent,
          }),
        ]);

        return { action: "materialized" as const, workItemId };
      });

      if (outcome.action === "reconciled_existing") {
        skipped++;
        details.push({ loopId: loop.id, action: "reconciled_existing", workItemId: outcome.workItemId });
      } else if (outcome.action === "materialized") {
        materialized++;
        details.push({ loopId: loop.id, action: "materialized", workItemId: outcome.workItemId });
      } else {
        skipped++;
        details.push({ loopId: loop.id, action: "skipped", reason: outcome.reason });
      }
    } catch (error) {
      skipped++;
      details.push({
        loopId: loop.id,
        action: "skipped",
        reason: error instanceof Error ? error.message : "materialization_failed",
      });
    }
  }

  return NextResponse.json({
    materialized,
    skipped,
    details,
    window: {
      open: true,
      source: windowState.source,
      mode: windowState.mode,
    },
  });
}
