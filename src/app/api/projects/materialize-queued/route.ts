import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getExecutionWindowConfig, isExecutionWindowOpenNow } from "@/lib/execution-window";
import {
  getPrimaryExecutionWorkItem,
  isPrimaryExecutionOpen,
  reconcileProjectStatusWithPrimaryExecution,
  supersedePrimaryExecutionLinks,
} from "@/lib/projects/lifecycle";

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

  const supabase = createServiceClient();
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

  const { data: projects, error } = await supabase
    .from("projects")
    .select("id,name,description,summary,status,priority,owner_agent,target_outcome,plan,clarification_questions,metadata,approval_scope,last_approved_at,updated_at")
    .eq("status", "queued")
    .order("updated_at", { ascending: true })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!projects?.length) return NextResponse.json({ materialized: 0, skipped: 0, details: [] });

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

    let primaryExecution = null;

    try {
      primaryExecution = await getPrimaryExecutionWorkItem(supabase, project.id);
    } catch (existingError) {
      skipped++;
      details.push({
        projectId: project.id,
        action: "skipped",
        reason: existingError instanceof Error ? existingError.message : "primary_execution_lookup_failed",
      });
      continue;
    }

    if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
      await reconcileProjectStatusWithPrimaryExecution(supabase, {
        projectId: project.id,
        projectStatus: project.status,
        primaryExecution,
        actor: "project-execution-materializer",
        reason: "materialize_queued_existing_primary_execution",
        projectUpdates: { last_started_at: now },
        now,
      });

      skipped++;
      details.push({ projectId: project.id, action: "reconciled_existing", workItemId: primaryExecution.workItemId });
      continue;
    }

    const { data: workItem, error: workItemError } = await supabase
      .from("work_items")
      .insert({
        project_id: project.id,
        parent_id: null,
        kind: "task",
        source_type: "project",
        source_id: project.id,
        title: `Execute project: ${project.name || "Untitled Project"}`,
        instruction: buildInstruction(project),
        status: "ready",
        priority: project.priority || "medium",
        owner_agent: project.owner_agent,
        requested_by: "system",
        payload: {
          materialized_from_project: true,
          source_project_id: project.id,
          source_project_title: project.name || "Untitled Project",
          materializer: "project-execution-materializer",
          project_status_at_materialization: project.status,
        },
      })
      .select("id")
      .single();

    if (workItemError || !workItem) {
      skipped++;
      details.push({ projectId: project.id, action: "skipped", reason: workItemError?.message || "work_item_insert_failed" });
      continue;
    }

    await supersedePrimaryExecutionLinks(supabase, project.id, workItem.id, "project-execution-materializer");

    const { error: linkError } = await supabase.from("project_work_items").insert({
      project_id: project.id,
      work_item_id: workItem.id,
      relation_type: "primary_execution",
    });

    if (linkError) {
      await supabase.from("work_items").delete().eq("id", workItem.id);
      skipped++;
      details.push({ projectId: project.id, action: "skipped", reason: linkError.message, workItemId: workItem.id });
      continue;
    }

    const { error: projectUpdateError } = await supabase.from("projects").update({
      status: "in_progress",
      last_started_at: now,
      updated_at: now,
    }).eq("id", project.id).eq("status", "queued");

    if (projectUpdateError) {
      await supabase.from("project_work_items").delete().eq("project_id", project.id).eq("work_item_id", workItem.id).eq("relation_type", "primary_execution");
      await supabase.from("work_items").delete().eq("id", workItem.id);
      skipped++;
      details.push({ projectId: project.id, action: "skipped", reason: projectUpdateError.message, workItemId: workItem.id });
      continue;
    }

    await supabase.from("project_events").insert([
      {
        project_id: project.id,
        event_type: "project.execution_materialized",
        from_status: "queued",
        to_status: "in_progress",
        actor: "project-execution-materializer",
        payload: {
          work_item_id: workItem.id,
          relation_type: "primary_execution",
        },
      },
      {
        project_id: project.id,
        event_type: "project.started",
        from_status: "queued",
        to_status: "in_progress",
        actor: "project-execution-materializer",
        payload: {
          work_item_id: workItem.id,
          owner_agent: project.owner_agent,
        },
      },
    ]);

    materialized++;
    details.push({ projectId: project.id, action: "materialized", workItemId: workItem.id });
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
