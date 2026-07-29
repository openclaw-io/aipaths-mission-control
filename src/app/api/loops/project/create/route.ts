import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { withTransaction } from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LIMITS = { stages: 50, tasks: 200, dependencies: 1000, criteria: 50 } as const;

type Dependency = { key: string; type: "hard" | "soft" };
type TaskInput = {
  key: string;
  title: string;
  description: string | null;
  assigneeAgent: string | null;
  dependencies: Dependency[];
};
type StageInput = { key: string; title: string; description: string | null; tasks: TaskInput[] };
type V2CreateInput = {
  idempotencyKey: string;
  title: string;
  input: string;
  ownerAgent: string;
  acceptanceCriteria: string[];
  stages: StageInput[];
  approvalScope: { allowed_actions: string[]; forbidden_actions: string[]; notes: string | null };
  repository: string;
};

function text(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function stringList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    const parsed = text(item, maxLength);
    if (!parsed) return null;
    result.push(parsed);
  }
  return result;
}

function parseV2Create(value: unknown): { ok: true; value: V2CreateInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid_body" };
  const body = value as Record<string, unknown>;
  const idempotencyKey = text(body.idempotency_key, 128);
  const title = text(body.title, 200);
  const input = text(body.input, 20_000);
  const ownerAgent = text(body.owner_agent, 100);
  const repository = text(body.repository_id ?? body.repository_key ?? body.repository, 80);
  const acceptanceCriteria = stringList(body.acceptance_criteria, LIMITS.criteria, 1_000);
  if (!idempotencyKey) return { ok: false, error: "invalid_idempotency_key" };
  if (!title) return { ok: false, error: "invalid_title" };
  if (!input) return { ok: false, error: "invalid_input" };
  if (!ownerAgent) return { ok: false, error: "invalid_owner_agent" };
  if (!repository || !KEY_PATTERN.test(repository)) return { ok: false, error: "registered_repository_required" };
  if (!acceptanceCriteria || acceptanceCriteria.length === 0) return { ok: false, error: "invalid_acceptance_criteria" };
  if (!Array.isArray(body.stages) || body.stages.length === 0 || body.stages.length > LIMITS.stages) {
    return { ok: false, error: "invalid_stages" };
  }

  const stages: StageInput[] = [];
  const stageKeys = new Set<string>();
  const taskKeys = new Set<string>();
  let taskCount = 0;
  let dependencyCount = 0;
  for (const rawStage of body.stages) {
    if (!rawStage || typeof rawStage !== "object" || Array.isArray(rawStage)) return { ok: false, error: "invalid_stage" };
    const stage = rawStage as Record<string, unknown>;
    const key = text(stage.key, 80);
    const stageTitle = text(stage.title, 200);
    const description = stage.description == null ? null : text(stage.description, 5_000);
    if (!key || !KEY_PATTERN.test(key) || stageKeys.has(key)) return { ok: false, error: "invalid_or_duplicate_stage_key" };
    if (!stageTitle || (stage.description != null && !description)) return { ok: false, error: "invalid_stage_text" };
    if (!Array.isArray(stage.tasks) || stage.tasks.length === 0) return { ok: false, error: "stage_tasks_required" };
    stageKeys.add(key);
    const tasks: TaskInput[] = [];
    for (const rawTask of stage.tasks) {
      if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) return { ok: false, error: "invalid_task" };
      const task = rawTask as Record<string, unknown>;
      const taskKey = text(task.key, 80);
      const taskTitle = text(task.title, 200);
      const taskDescription = task.description == null ? null : text(task.description, 10_000);
      const assigneeAgent = task.assignee_agent == null ? null : text(task.assignee_agent, 100);
      if (!taskKey || !KEY_PATTERN.test(taskKey) || taskKeys.has(taskKey)) return { ok: false, error: "invalid_or_duplicate_task_key" };
      if (!taskTitle || (task.description != null && !taskDescription) || (task.assignee_agent != null && !assigneeAgent)) {
        return { ok: false, error: "invalid_task_text" };
      }
      const rawDependencies = task.depends_on ?? task.dependencies ?? [];
      if (!Array.isArray(rawDependencies)) return { ok: false, error: "invalid_dependencies" };
      const dependencies: Dependency[] = [];
      const localDependencies = new Set<string>();
      for (const rawDependency of rawDependencies) {
        const dependencyKey = typeof rawDependency === "string"
          ? text(rawDependency, 80)
          : rawDependency && typeof rawDependency === "object" && !Array.isArray(rawDependency)
            ? text((rawDependency as Record<string, unknown>).key, 80)
            : null;
        const dependencyType = typeof rawDependency === "object" && rawDependency !== null && !Array.isArray(rawDependency)
          ? ((rawDependency as Record<string, unknown>).type ?? "hard")
          : "hard";
        if (!dependencyKey || !KEY_PATTERN.test(dependencyKey) || localDependencies.has(dependencyKey)
          || (dependencyType !== "hard" && dependencyType !== "soft")) {
          return { ok: false, error: "invalid_dependencies" };
        }
        localDependencies.add(dependencyKey);
        dependencies.push({ key: dependencyKey, type: dependencyType });
      }
      dependencies.sort((left, right) => left.key.localeCompare(right.key) || left.type.localeCompare(right.type));
      taskKeys.add(taskKey);
      taskCount += 1;
      dependencyCount += dependencies.length;
      tasks.push({ key: taskKey, title: taskTitle, description: taskDescription, assigneeAgent, dependencies });
    }
    stages.push({ key, title: stageTitle, description, tasks });
  }
  if (taskCount > LIMITS.tasks || dependencyCount > LIMITS.dependencies) return { ok: false, error: "project_graph_too_large" };

  const taskByKey = new Map(stages.flatMap((stage) => stage.tasks).map((task) => [task.key, task]));
  for (const task of taskByKey.values()) {
    for (const dependency of task.dependencies) {
      if (!taskByKey.has(dependency.key) || dependency.key === task.key) return { ok: false, error: "invalid_dependency_reference" };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dependency of taskByKey.get(key)?.dependencies ?? []) if (!visit(dependency.key)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  for (const key of taskByKey.keys()) if (!visit(key)) return { ok: false, error: "dependency_cycle" };

  const rawScope = body.approval_scope && typeof body.approval_scope === "object" && !Array.isArray(body.approval_scope)
    ? body.approval_scope as Record<string, unknown>
    : {};
  const allowed = rawScope.allowed_actions === undefined ? ["implementation"] : stringList(rawScope.allowed_actions, 50, 200);
  const forbidden = rawScope.forbidden_actions === undefined ? ["publish_external_output"] : stringList(rawScope.forbidden_actions, 50, 200);
  const notes = rawScope.notes == null ? null : text(rawScope.notes, 2_000);
  if (!allowed || !forbidden || (rawScope.notes != null && !notes)) return { ok: false, error: "invalid_approval_scope" };

  return { ok: true, value: {
    idempotencyKey, title, input, ownerAgent, acceptanceCriteria, stages, repository,
    approvalScope: { allowed_actions: allowed, forbidden_actions: forbidden, notes },
  } };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}

function canonicalDependencies(taskKey: string, dependencies: Dependency[]) {
  return dependencies
    .map((dependency) => ({ taskKey, dependsOnKey: dependency.key, type: dependency.type }))
    .sort((left, right) => left.taskKey.localeCompare(right.taskKey)
      || left.dependsOnKey.localeCompare(right.dependsOnKey)
      || left.type.localeCompare(right.type))
    .map((dependency) => ({ key: dependency.dependsOnKey, type: dependency.type }));
}

function buildPlanSnapshot(project: V2CreateInput, repository: { id: string; key: string }) {
  return canonical({
    schema_version: 1,
    objective: { title: project.title, input: project.input },
    owner_agent: project.ownerAgent,
    repository,
    acceptance_criteria: project.acceptanceCriteria,
    approval_policy: project.approvalScope,
    stages: project.stages.map((stage, stagePosition) => ({
      key: stage.key,
      title: stage.title,
      description: stage.description,
      position: stagePosition,
      tasks: stage.tasks.map((task, taskPosition) => ({
        key: task.key,
        title: task.title,
        description: task.description,
        assignee_agent: task.assigneeAgent,
        position: taskPosition,
        dependencies: canonicalDependencies(task.key, task.dependencies),
      })),
    })),
  });
}

function contentHash(snapshot: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project-loop";
}

export async function POST(request: NextRequest) {
  if (!isLocalAuthDisabled()) return NextResponse.json({ error: "cloud_project_loop_create_not_supported" }, { status: 503 });
  const actor = getLocalMissionControlUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = parseV2Create(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const project = parsed.value;
  const requestSnapshot = canonical(project);
  const now = new Date().toISOString();

  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`project-loop-create:${project.idempotencyKey}`]);
    const repository = (await client.query<{ id: string; key: string }>(
      `select id,key from review_repositories where enabled=true and (id::text=$1 or key=$1) for share`,
      [project.repository],
    )).rows[0];
    if (!repository) return { kind: "repository_missing" as const };
    const planSnapshot = buildPlanSnapshot(project, repository);
    const planHash = contentHash(planSnapshot);
    const existing = await client.query<{
      id: string; key: string; status: string; metadata: Record<string, unknown>;
      current_plan_revision_id: string; content_hash: string | null;
    }>(
      `SELECT l.id,l.key,l.status,l.metadata,l.current_plan_revision_id,r.content_hash
         FROM public.loops l JOIN public.loop_plan_revisions r ON r.id=l.current_plan_revision_id
        WHERE l.workflow_version=2 AND l.metadata->>'project_create_idempotency_key'=$1
        ORDER BY l.created_at LIMIT 1 FOR UPDATE OF l,r`,
      [project.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (JSON.stringify(canonical(existing.rows[0].metadata.project_create_request)) !== JSON.stringify(requestSnapshot)
        || existing.rows[0].content_hash !== planHash) {
        return { kind: "conflict" as const };
      }
      return { kind: "ok" as const, replay: true, loop: {
        id: existing.rows[0].id, key: existing.rows[0].key, status: existing.rows[0].status,
        plan_revision_id: existing.rows[0].current_plan_revision_id, plan_hash: existing.rows[0].content_hash,
      } };
    }

    const loopId = randomUUID();
    const revisionId = randomUUID();
    const key = `${slug(project.title)}-${loopId.slice(0, 8)}`;
    const metadata = {
      created_from: "project_loop_v2_api",
      original_input: project.input,
      project_create_idempotency_key: project.idempotencyKey,
      project_create_request: requestSnapshot,
    };
    await client.query(
      `INSERT INTO public.loops
        (id,key,name,description,summary,type,status,priority,owner_agent,target_outcome,
         acceptance_criteria,plan,clarification_questions,approval_scope,metadata,created_by,
         workflow_version,mode,current_plan_revision_id,row_version,updated_at)
       VALUES ($1,$2,$3,$4,$4,'project','needs_approval','medium',$5,$4,$6::text[],'[]'::jsonb,'[]'::jsonb,
         $7::jsonb,$8::jsonb,$9,2,'dag',$10,1,$11)`,
      [loopId, key, project.title, project.input, project.ownerAgent, project.acceptanceCriteria,
        JSON.stringify({ approved: false, approved_by: null, approved_at: null, can_execute_unattended: false, ...project.approvalScope }),
        JSON.stringify(metadata), actor.email, revisionId, now],
    );
    await client.query(
      `INSERT INTO public.loop_plan_revisions
        (id,loop_id,revision_number,status,summary,content_hash,plan_snapshot,created_by,updated_at)
       VALUES ($1,$2,1,'pending_approval',$3,$4,$5::jsonb,$6,$7)`,
      [revisionId, loopId, project.title, planHash, JSON.stringify(planSnapshot), actor.email, now],
    );

    const taskIds = new Map<string, string>();
    for (const [stagePosition, stage] of project.stages.entries()) {
      const stageId = randomUUID();
      await client.query(
        `INSERT INTO public.loop_stages (id,plan_revision_id,key,title,description,position,status,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
        [stageId, revisionId, stage.key, stage.title, stage.description, stagePosition, now],
      );
      for (const [taskPosition, task] of stage.tasks.entries()) {
        const taskId = randomUUID();
        taskIds.set(task.key, taskId);
        await client.query(
          `INSERT INTO public.loop_tasks (id,stage_id,key,title,description,position,status,assignee_agent,metadata,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,'{}'::jsonb,$8)`,
          [taskId, stageId, task.key, task.title, task.description, taskPosition, task.assigneeAgent, now],
        );
      }
    }
    for (const stage of project.stages) for (const task of stage.tasks) for (const dependency of task.dependencies) {
      await client.query(
        `INSERT INTO public.loop_task_dependencies (task_id,depends_on_task_id,dependency_type)
         VALUES ($1,$2,$3)`,
        [taskIds.get(task.key), taskIds.get(dependency.key), dependency.type],
      );
    }
    await client.query(
      `INSERT INTO public.loop_events (loop_id,event_type,from_status,to_status,actor,payload,created_at)
       VALUES
        ($1,'loop.created',NULL,'needs_approval',$2,$3::jsonb,$4),
        ($1,'loop.plan_submitted_for_approval','planning','needs_approval',$2,$5::jsonb,$4)`,
      [loopId, actor.email, JSON.stringify({ workflow_version: 2, mode: "dag", idempotency_key: project.idempotencyKey }),
        now, JSON.stringify({ plan_revision_id: revisionId, revision_number: 1, stages: project.stages.length, tasks: taskIds.size })],
    );
    return { kind: "ok" as const, replay: false, loop: {
      id: loopId, key, status: "needs_approval", plan_revision_id: revisionId, plan_hash: planHash,
    } };
  });

  if (result.kind === "conflict") return NextResponse.json({ error: "idempotency_key_payload_conflict" }, { status: 409 });
  if (result.kind === "repository_missing") return NextResponse.json({ error: "registered_repository_not_found_or_disabled" }, { status: 400 });
  return NextResponse.json({ ok: true, replay: result.replay, loop: result.loop }, { status: result.replay ? 200 : 201 });
}
