import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import {
  getPrimaryExecutionWorkItem,
  isPrimaryExecutionOpen,
  reconcileProjectStatusWithPrimaryExecution,
} from "@/lib/projects/lifecycle";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body?.action;
  const feedback = typeof body?.feedback === "string" ? body.feedback.trim() : "";

  const transitions: Record<string, { nextStatus: string; eventType: string }> = {
    request_review: { nextStatus: "in_review", eventType: "project.review_requested" },
    approve_deliverable: { nextStatus: "completed", eventType: "project.review_approved" },
    request_changes: { nextStatus: "in_progress", eventType: "project.review_changes_requested" },
  };

  const transition = transitions[action || ""];
  if (!transition) {
    return NextResponse.json({ error: "Invalid review action" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: project, error: loadError } = await supabase
    .from("projects")
    .select("id, status, name, summary, description, plan, metadata, owner_agent")
    .eq("id", id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const now = new Date().toISOString();

  if (transition.nextStatus === "completed") {
    const primaryExecution = await getPrimaryExecutionWorkItem(supabase, id);

    if (primaryExecution && isPrimaryExecutionOpen(primaryExecution.status)) {
      await reconcileProjectStatusWithPrimaryExecution(supabase, {
        projectId: id,
        projectStatus: project.status,
        primaryExecution,
        actor: user.email || user.id,
        reason: "review_completion_blocked_by_open_primary_execution",
        now,
      });

      return NextResponse.json(
        {
          error: "primary_execution_still_open",
          workItemId: primaryExecution.workItemId,
          workItemStatus: primaryExecution.status,
        },
        { status: 409 }
      );
    }
  }

  const metadata = {
    ...((project.metadata || {}) as Record<string, unknown>),
    review_history: [
      ...((((project.metadata || {}) as Record<string, unknown>).review_history as unknown[]) || []),
      {
        action,
        feedback: feedback || null,
        acted_at: now,
        acted_by: user.email || user.id,
      },
    ],
  };

  const updates: Record<string, unknown> = {
    status: transition.nextStatus,
    metadata,
    updated_at: now,
  };

  if (transition.nextStatus === "completed") {
    updates.last_completed_at = now;
  }

  const { error: updateError } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("project_events").insert({
    project_id: id,
    event_type: transition.eventType,
    from_status: project.status,
    to_status: transition.nextStatus,
    actor: user.email || user.id,
    payload: {
      action,
      feedback: feedback || null,
    },
  });

  if (eventError) {
    return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  if (action === "request_changes") {
    const { data: links } = await supabase
      .from("project_work_items")
      .select("work_item_id")
      .eq("project_id", id)
      .eq("relation_type", "primary_execution")
      .limit(1);

    const workItemId = links?.[0]?.work_item_id;
    if (workItemId) {
      const existingPayload = (((project.metadata || {}) as Record<string, unknown>).latest_deliverable_feedback_history as unknown[]) || [];
      const reviewInstruction = [
        `Project: ${project.name || id}`,
        project.summary ? `Summary: ${project.summary}` : null,
        project.description ? `Description: ${project.description}` : null,
        Array.isArray(project.plan) && project.plan.length
          ? `Current plan:\n${project.plan.map((step: any, index: number) => `- ${index + 1}. ${step.title || "Untitled step"}`).join("\n")}`
          : null,
        "",
        "Review requested changes:",
        feedback || "No explicit feedback provided. Rework the deliverable based on review comments and produce an updated final output.",
        "",
        "Important: produce a fresh updated deliverable, and persist the final answer in payload.result/output/summary when completing the work item.",
      ].filter(Boolean).join("\n");

      await supabase
        .from("work_items")
        .update({
          status: "ready",
          updated_at: now,
          completed_at: null,
          instruction: reviewInstruction,
          payload: {
            review_feedback: feedback || null,
            rework_requested_at: now,
            rework_requested_by: user.email || user.id,
            prior_review_feedback: existingPayload,
          },
        })
        .eq("id", workItemId);

      try {
        await fetch("http://127.0.0.1:3001/api/work-items/notify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
          },
          body: JSON.stringify({
            workItemId,
            agent: project.owner_agent,
            action: "unblocked",
          }),
        });
      } catch (error) {
        console.error("[project-review] notify on request_changes failed:", error);
      }
    }
  }

  return NextResponse.json({ ok: true, id, status: transition.nextStatus });
}
