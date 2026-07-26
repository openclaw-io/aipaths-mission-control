import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";
import { getExecutionWindowConfig, isExecutionWindowOpenNow } from "@/lib/execution-window";
import {
  getPrimaryExecutionWorkItemLocal,
  isPrimaryExecutionOpen,
  reconcileProjectStatusWithPrimaryExecutionLocal,
  supersedePrimaryExecutionLinksLocal,
} from "@/lib/projects/lifecycle-local";

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

type ProjectRow = {
  id: string;
  name: string | null;
  description: string | null;
  summary: string | null;
  status: string;
  priority: "high" | "medium" | "low" | null;
  owner_agent: string | null;
  target_outcome: string | null;
  plan: Array<{ title?: string; status?: string; notes?: string | null }> | null;
  clarification_questions: ClarificationQuestion[] | null;
  metadata: {
    clarification_history?: ClarificationHistoryEntry[] | null;
  } | null;
  approval_scope: {
    approved?: boolean;
    can_execute_unattended?: boolean;
    notes?: string | null;
  } | null;
};

export const dynamic = "force-dynamic";

function checkInternalAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

function buildClarificationContext(project: ProjectRow) {
  const clarificationHistory = Array.isArray(project.metadata?.clarification_history)
    ? project.metadata?.clarification_history || []
    : [];

  const responses = clarificationHistory
    .map((entry) => (typeof entry?.response === "string" ? entry.response.trim() : ""))
    .filter(Boolean);

  if (!responses.length) return null;

  return `Latest clarification from requester:\n${responses.map((response) => `- ${response}`).join("\n")}`;
}

function buildInstruction(project: ProjectRow) {
  const clarificationContext = buildClarificationContext(project);
  const parts = [
    `Project: ${project.name || "Untitled Project"}`,
    project.summary || project.description ? `Summary: ${project.summary || project.description}` : null,
    project.target_outcome ? `Target outcome: ${project.target_outcome}` : null,
    project.plan?.length
      ? `Plan:\n${project.plan
          .map((step, index) => `- ${index + 1}. ${step.title || "Untitled step"}${step.notes ? ` (${step.notes})` : ""}`)
          .join("\n")}`
      : null,
    clarificationContext,
    project.approval_scope?.notes ? `Approval notes: ${project.approval_scope.notes}` : null,
  ].filter(Boolean);

  return parts.join("\n\n");
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

  const { rows: projects } = await query(`
    SELECT id,name,description,summary,status,priority,owner_agent,target_outcome,plan,clarification_questions,metadata,approval_scope,last_approved_at,updated_at
    FROM public.projects
    WHERE status = 'queued'
    ORDER BY updated_at ASC
    LIMIT 20
  `);

  if (!projects.length) return NextResponse.json({ materialized: 0, skipped: 0, details: [] });

  let materialized = 0;
  let skipped = 0;
  const details: Array<{ projectId: string; action: string; reason?: string; workItemId?: string }> = [];

  for (const project of projects as ProjectRow[]) {
    if (!project.approval_scope?.approved || !project.approval_scope?.can_execute_unattended) {
      skipped++;
      details.push({ projectId: project.id, action: "skipped", reason: "approval_scope_not_ready" });
      continue;
    }

    if (!project.owner_agent) {
      skipped++;
      details.push({ projectId: project.id, action: "skipped", reason: "missing_owner_agent" });
      continue;
    }

    try {
      const outcome = await withTransaction(async (client) => {
        const primaryExecution = await getPrimaryExecutionWorkItemLocal(project.id, client);

        if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
          await reconcileProjectStatusWithPrimaryExecutionLocal(client, {
            projectId: project.id,
            projectStatus: project.status,
            primaryExecution,
            actor: "project-execution-materializer",
            reason: "materialize_queued_existing_primary_execution",
            projectUpdates: { last_started_at: now },
            now,
          });

          return { action: "reconciled_existing" as const, workItemId: primaryExecution.workItemId };
        }

        const workItem = await client.query<{ id: string }>(`
          INSERT INTO public.work_items (
            project_id,
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
          ) VALUES ($1, NULL, 'task', 'project', $2, $3, $4, 'ready', $5, $6, 'system', $7::jsonb)
          RETURNING id
        `, [
          project.id,
          project.id,
          `Execute project: ${project.name || "Untitled Project"}`,
          buildInstruction(project),
          project.priority || "medium",
          project.owner_agent,
          JSON.stringify({
            materialized_from_project: true,
            source_project_id: project.id,
            source_project_title: project.name || "Untitled Project",
            materializer: "project-execution-materializer",
            project_status_at_materialization: project.status,
          }),
        ]);

        const workItemId = workItem.rows[0]?.id;
        if (!workItemId) throw new Error("work_item_insert_failed");

        await supersedePrimaryExecutionLinksLocal(client, project.id, workItemId, "project-execution-materializer");

        await client.query(`
          INSERT INTO public.project_work_items (project_id, work_item_id, relation_type)
          VALUES ($1, $2, 'primary_execution')
        `, [project.id, workItemId]);

        const projectUpdate = await client.query(`
          UPDATE public.projects
          SET status = 'in_progress',
              last_started_at = $1::timestamptz,
              updated_at = $1::timestamptz
          WHERE id = $2
            AND status = 'queued'
          RETURNING id
        `, [now, project.id]);

        if (!projectUpdate.rows[0]) throw new Error("project_status_changed");

        await client.query(`
          INSERT INTO public.project_events (project_id, event_type, from_status, to_status, actor, payload)
          VALUES
            ($1, 'project.execution_materialized', 'queued', 'in_progress', 'project-execution-materializer', $2::jsonb),
            ($1, 'project.started', 'queued', 'in_progress', 'project-execution-materializer', $3::jsonb)
        `, [
          project.id,
          JSON.stringify({
            work_item_id: workItemId,
            relation_type: "primary_execution",
          }),
          JSON.stringify({
            work_item_id: workItemId,
            owner_agent: project.owner_agent,
          }),
        ]);

        return { action: "materialized" as const, workItemId };
      });

      if (outcome.action === "reconciled_existing") {
        skipped++;
        details.push({ projectId: project.id, action: "reconciled_existing", workItemId: outcome.workItemId });
      } else {
        materialized++;
        details.push({ projectId: project.id, action: "materialized", workItemId: outcome.workItemId });
      }
    } catch (error) {
      skipped++;
      details.push({
        projectId: project.id,
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
