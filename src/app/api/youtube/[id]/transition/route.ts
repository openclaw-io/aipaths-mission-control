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

const YOUTUBE_V0_STAGE_STATUSES = [
  "idea",
  "draft",
  "title_thumbnail",
  "research",
  "researching",
  "bullets",
  "ready_to_record",
  "recorded",
  "editing",
  "published",
  "learning",
  "parked",
  "rejected",
  "archived",
] as const;

function isYouTubeV0StageStatus(value: unknown): value is (typeof YOUTUBE_V0_STAGE_STATUSES)[number] {
  return typeof value === "string" && (YOUTUBE_V0_STAGE_STATUSES as readonly string[]).includes(value);
}

function getValueAt(record: JsonRecord, path: string[]) {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonRecord)[key];
  }
  return current;
}

function getStringAt(record: JsonRecord, path: string[]) {
  const value = getValueAt(record, path);
  return trimToNull(value);
}

function firstStringFromPaths(records: JsonRecord[], paths: string[][]) {
  for (const record of records) {
    for (const path of paths) {
      const value = getStringAt(record, path);
      if (value) return value;
    }
  }
  return null;
}

function extractYouTubeVideoId(url: string | null) {
  if (!url) return null;
  const watchMatch = url.match(/[?&]v=([^&]+)/);
  if (watchMatch?.[1]) return watchMatch[1];
  const shortMatch = url.match(/youtu\.be\/([^?&/]+)/);
  if (shortMatch?.[1]) return shortMatch[1];
  return null;
}

function getBodyString(body: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = trimToNull(body[key]);
    if (value) return value;
  }
  return null;
}

function addMilliseconds(isoDate: string, milliseconds: number) {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}

function createSnapshotInstruction(input: {
  title: string;
  relationType: string;
  youtubeUrl: string | null;
  videoId: string | null;
}) {
  return [
    `YouTube pipeline item: ${input.title}`,
    `Snapshot: ${input.relationType.replace("youtube_snapshot_", "+")}`,
    "",
    "Task:",
    "- Collect a lightweight public YouTube performance snapshot for this video.",
    "- Capture views, likes, comments count, title/thumbnail state, and notable public comment signals if available.",
    "- Save the snapshot back to the work item output and include the video URL or ID used.",
    "",
    `YouTube URL: ${input.youtubeUrl || "(not provided)"}`,
    `Video ID: ${input.videoId || "(not provided)"}`,
  ].join("\n");
}

async function createPublishedSnapshotWorkItems(input: {
  db: ReturnType<typeof createServiceClient>;
  pipelineItemId: string;
  title: string;
  priority: string | null;
  requestedBy: string;
  publishedAt: string;
  youtubeUrl: string | null;
  videoId: string | null;
}) {
  const snapshots = [
    { relationType: "youtube_snapshot_24h", label: "+24h", delayMs: 24 * 60 * 60 * 1000 },
    { relationType: "youtube_snapshot_7d", label: "+7d", delayMs: 7 * 24 * 60 * 60 * 1000 },
    { relationType: "youtube_snapshot_28d", label: "+28d", delayMs: 28 * 24 * 60 * 60 * 1000 },
  ];

  const results = [];
  for (const snapshot of snapshots) {
    const scheduledFor = addMilliseconds(input.publishedAt, snapshot.delayMs);
    const result = await createPipelineWorkItem(input.db, {
      pipelineItemId: input.pipelineItemId,
      pipelineType: "video",
      title: `Collect YouTube snapshot ${snapshot.label}: ${input.title}`,
      instruction: createSnapshotInstruction({
        title: input.title,
        relationType: snapshot.relationType,
        youtubeUrl: input.youtubeUrl,
        videoId: input.videoId,
      }),
      priority: input.priority || "medium",
      ownerAgent: "youtube",
      requestedBy: input.requestedBy,
      relationType: snapshot.relationType,
      mapRelationType: "followup",
      payloadRelationType: snapshot.relationType,
      scheduledFor,
      action: "collect_youtube_snapshot",
      trigger: "video_published_manual",
      payloadExtra: {
        youtube_url: input.youtubeUrl,
        video_id: input.videoId,
        snapshot_label: snapshot.label,
        snapshot_relation_type: snapshot.relationType,
        snapshot_due_at: scheduledFor,
      },
    });
    results.push({ relationType: snapshot.relationType, ...result });
  }

  return results;
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

  const body = (await request.json()) as JsonRecord;

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
  const requestedAction = typeof body.action === "string" ? body.action : null;

  if (requestedAction === "set_stage") {
    const requestedStage = body.stage ?? body.status;
    if (!isYouTubeV0StageStatus(requestedStage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }

    const youtubeV0 = toRecord(metadata.youtube_v0);
    const existingYoutubeUrl = firstStringFromPaths([youtubeV0, metadata], [
      ["youtube_url"],
      ["url"],
      ["publication", "youtube_url"],
      ["publication", "url"],
      ["published", "youtube_url"],
      ["video", "youtube_url"],
    ]) || item.current_url;
    const bodyYoutubeUrl = getBodyString(body, ["youtube_url", "youtubeUrl", "current_url", "url"]);
    const youtubeUrl = bodyYoutubeUrl || existingYoutubeUrl || null;
    const existingVideoId = firstStringFromPaths([youtubeV0, metadata], [
      ["video_id"],
      ["youtube_video_id"],
      ["publication", "video_id"],
      ["published", "video_id"],
      ["video", "id"],
    ]) || extractYouTubeVideoId(existingYoutubeUrl);
    const videoId = getBodyString(body, ["video_id", "videoId", "youtube_video_id"]) || extractYouTubeVideoId(youtubeUrl) || existingVideoId || null;
    const note = trimToNull(body.note ?? body.reason);
    const v0History = Array.isArray(youtubeV0.history) ? youtubeV0.history : [];
    const publishedAt = requestedStage === "published" ? item.published_at || now : item.published_at;
    const nextYoutubeV0 = {
      ...youtubeV0,
      stage: requestedStage,
      ...(note ? { last_note: note } : {}),
      ...(requestedStage === "published" && youtubeUrl ? { youtube_url: youtubeUrl } : {}),
      ...(requestedStage === "published" && videoId ? { video_id: videoId } : {}),
      ...(requestedStage === "published" ? { published_at: publishedAt } : {}),
      updated_at: now,
      history: [
        ...v0History,
        {
          at: now,
          by: user.email || user.id,
          action: "set_stage",
          from_status: item.status,
          to_status: requestedStage,
          note,
        },
      ],
    };
    const nextMetadata = {
      ...metadata,
      youtube_v0: nextYoutubeV0,
    };

    const updatePayload: Record<string, unknown> = {
      status: requestedStage,
      owner_agent: item.owner_agent || "youtube",
      metadata: nextMetadata,
      updated_at: now,
    };
    if (requestedStage === "published") {
      if (!item.published_at) updatePayload.published_at = now;
      if (youtubeUrl) updatePayload.current_url = youtubeUrl;
    }

    const { data: updated, error: updateError } = await db
      .from("pipeline_items")
      .update(updatePayload)
      .eq("id", id)
      .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const snapshotWorkItems = requestedStage === "published" && (youtubeUrl || videoId)
      ? await createPublishedSnapshotWorkItems({
        db,
        pipelineItemId: item.id,
        title: item.title,
        priority: item.priority,
        requestedBy: user.email || user.id,
        publishedAt: now,
        youtubeUrl,
        videoId,
      })
      : [];

    return NextResponse.json({ item: updated, snapshotWorkItems });
  }

  const currentDecision = getNextDecision(metadata);
  const gateKey = isGateKey(body.gateKey) ? body.gateKey : currentDecision.gateKey;

  if (!isGateKey(gateKey)) {
    return NextResponse.json({ error: "Invalid gateKey" }, { status: 400 });
  }

  const gates = toRecord(metadata.gates);
  const previousGate = getGateEntry(metadata, gateKey);
  const scores = getScores(metadata);
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
