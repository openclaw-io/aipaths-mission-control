import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";
import {
  getAgentDeliverableLabel,
  YOUTUBE_GATE_META,
  YOUTUBE_GATE_ORDER,
  YOUTUBE_GATE_STATUSES,
  type JsonRecord,
  type YouTubeGateEntry,
  type YouTubeGateKey,
  type YouTubeGateStatus,
  buildGateHistoryEntry,
  derivePipelineItemStatus,
  getGateEntry,
  getNextDecision,
  getScores,
  getYouTubeMetadata,
  priorityLevelFromScore,
} from "@/lib/youtube-pipeline";

export const dynamic = "force-dynamic";

function isGateKey(value: unknown): value is YouTubeGateKey {
  return typeof value === "string" && (YOUTUBE_GATE_ORDER as readonly string[]).includes(value);
}

function isGateStatus(value: unknown): value is YouTubeGateStatus {
  return typeof value === "string" && (YOUTUBE_GATE_STATUSES as readonly string[]).includes(value);
}

function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function createWorkItemInstruction(input: {
  title: string;
  gateKey: YouTubeGateKey;
  gateStatus: YouTubeGateStatus;
  actionType: "legacy" | "approve" | "request_rework" | "kill" | "send_to_agent";
  reason: string | null;
  evidenceSummary: string | null;
  nextAction: string | null;
}) {
  const gateLabel = YOUTUBE_GATE_META[input.gateKey].label;
  const deliverable = getAgentDeliverableLabel(input.gateKey);
  const taskLine = input.actionType === "request_rework"
    ? `- Rework the ${gateLabel} gate and return with a stronger recommendation.`
    : `- Move the ${gateLabel} gate forward and prepare the required artefact.`;

  return [
    `YouTube pipeline item: ${input.title}`,
    `Gate: ${gateLabel}`,
    `Current status: ${input.gateStatus.replaceAll("_", " ")}`,
    "",
    "Task:",
    taskLine,
    `- Produce: ${deliverable}.`,
    "- Update the supporting evidence, packaging, retention, or production notes directly on the pipeline item if your tooling supports it.",
    "- Finish with a clear recommendation for the next gate decision.",
    "",
    `Human note: ${input.reason || "(none)"}`,
    `Evidence summary: ${input.evidenceSummary || "(none yet)"}`,
    `Suggested next action: ${input.nextAction || "(none)"}`,
  ].join("\n");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const db = createServiceClient();

  const body = await request.json();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: item, error: fetchError } = await db
    .from("pipeline_items")
    .select("*")
    .eq("id", id)
    .eq("pipeline_type", "video")
    .single();

  if (fetchError || !item) {
    return NextResponse.json({ error: fetchError?.message || "Video item not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const metadata = getYouTubeMetadata(item.metadata);
  const currentDecision = getNextDecision(metadata);
  const gateKey = isGateKey(body.gateKey) ? body.gateKey : currentDecision.gateKey;

  if (!isGateKey(gateKey)) {
    return NextResponse.json({ error: "Invalid gateKey" }, { status: 400 });
  }

  const gates = toRecord(metadata.gates);
  const previousGate = getGateEntry(metadata, gateKey);
  const scores = getScores(metadata);
  const requestedAction = typeof body.action === "string" ? body.action : null;
  const requestedWorkItemRelationType = typeof body.workItemRelationType === "string" ? body.workItemRelationType : gateKey;
  const safeReason = trimToNull(body.reason ?? body.note);
  const safeEvidenceSummary = trimToNull(body.evidenceSummary);
  const safeNextAction = trimToNull(body.nextAction);

  let nextGateStatus: YouTubeGateStatus;
  let actionType: "legacy" | "approve" | "request_rework" | "kill" | "send_to_agent" = "legacy";
  let shouldCreateWorkItem = body.createWorkItem === true;

  if (requestedAction === "approve") {
    nextGateStatus = "pass";
    actionType = "approve";
  } else if (requestedAction === "request_rework") {
    nextGateStatus = "rework";
    actionType = "request_rework";
    shouldCreateWorkItem = body.createWorkItem !== false;
  } else if (requestedAction === "kill") {
    nextGateStatus = "kill";
    actionType = "kill";
  } else if (requestedAction === "send_to_agent") {
    nextGateStatus = previousGate.status && previousGate.status !== "not_started" ? previousGate.status : "in_progress";
    actionType = "send_to_agent";
    shouldCreateWorkItem = true;
  } else {
    const requestedStatus = body.gateStatus;
    if (!isGateStatus(requestedStatus)) {
      return NextResponse.json({ error: "Invalid gateStatus" }, { status: 400 });
    }
    nextGateStatus = requestedStatus;
  }

  const updatedGate: YouTubeGateEntry = {
    ...previousGate,
    status: nextGateStatus,
    reason: safeReason || previousGate.reason || undefined,
    evidence_summary: safeEvidenceSummary || previousGate.evidence_summary || undefined,
    next_action: safeNextAction || previousGate.next_action || undefined,
    decided_at: now,
    decided_by: user.email || user.id,
    updated_at: now,
    history: [
      ...((Array.isArray(previousGate.history) ? previousGate.history : []) || []),
      buildGateHistoryEntry({
        at: now,
        by: user.email || user.id,
        status: nextGateStatus,
        reason: safeReason,
        evidenceSummary: actionType === "send_to_agent" ? null : safeEvidenceSummary,
        nextAction: safeNextAction,
        scores,
      }),
    ],
  };

  const nextMetadata = {
    ...metadata,
    gates: {
      ...gates,
      [gateKey]: updatedGate,
    },
    next_action: safeNextAction || metadata.next_action,
    scores,
  };

  const derivedStatus = derivePipelineItemStatus(nextMetadata, {
    currentStatus: item.status,
    publishedAt: item.published_at,
  });

  let workItem: { id?: string } | null = null;
  if (shouldCreateWorkItem) {
    const relationType = requestedWorkItemRelationType === "investigate" ? "investigate" : gateKey;
    const title = relationType === "investigate"
      ? `Investigate ${YOUTUBE_GATE_META[gateKey].label}: ${item.title}`
      : `YouTube ${YOUTUBE_GATE_META[gateKey].label}: ${item.title}`;

    const result = await createPipelineWorkItem(db, {
      pipelineItemId: item.id,
      pipelineType: "video",
      title,
      instruction: createWorkItemInstruction({
        title: item.title,
        gateKey,
        gateStatus: nextGateStatus,
        actionType,
        reason: safeReason,
        evidenceSummary: actionType === "send_to_agent" ? previousGate.evidence_summary || null : safeEvidenceSummary,
        nextAction: safeNextAction,
      }),
      priority: priorityLevelFromScore(scores.priority),
      ownerAgent: "youtube",
      requestedBy: user.email || user.id,
      relationType,
      mapRelationType: "investigate",
      payloadRelationType: relationType,
      action: `youtube_gate_${gateKey}`,
      trigger: "youtube_decision_board",
    });
    workItem = result.workItem || null;
    if (workItem?.id) {
      nextMetadata.gates[gateKey] = {
        ...updatedGate,
        work_item_id: workItem.id,
      };
    }
  }

  const { data: updated, error: updateError } = await db
    .from("pipeline_items")
    .update({
      status: derivedStatus,
      priority: priorityLevelFromScore(scores.priority),
      owner_agent: "youtube",
      metadata: nextMetadata,
      updated_at: now,
    })
    .eq("id", id)
    .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ item: updated, workItem });
}
