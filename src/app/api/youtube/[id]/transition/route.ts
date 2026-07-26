import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import {
  createPipelineWorkItemLocal,
  getOrCreateVideoAnnouncementEmailItemLocal,
  getPipelineItemLocal,
  insertPipelineTransitionEventLocal,
  updatePipelineItemLocal,
  withLockedPipelineItemLocal,
} from "@/lib/db/pipeline-local";
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
  db?: ReturnType<typeof createServiceClient>;
  localMode?: boolean;
  pipelineItemId: string;
  title: string;
  priority: string | null;
  requestedBy: string;
  publishedAt: string;
  youtubeUrl: string | null;
  videoId: string | null;
  localClient?: Parameters<typeof updatePipelineItemLocal>[2];
}) {
  const snapshots = [
    { relationType: "youtube_snapshot_24h", label: "+24h", delayMs: 24 * 60 * 60 * 1000 },
    { relationType: "youtube_snapshot_7d", label: "+7d", delayMs: 7 * 24 * 60 * 60 * 1000 },
    { relationType: "youtube_snapshot_28d", label: "+28d", delayMs: 28 * 24 * 60 * 60 * 1000 },
  ];

  const results = [];
  for (const snapshot of snapshots) {
    const scheduledFor = addMilliseconds(input.publishedAt, snapshot.delayMs);
    const workInput = {
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
    };
    const result = input.localMode
      ? await createPipelineWorkItemLocal(workInput, input.localClient)
      : await createPipelineWorkItem(input.db!, workInput);
    results.push({ relationType: snapshot.relationType, ...result });
  }

  return results;
}

function createVideoAnnouncementEmailInstruction(input: {
  title: string;
  youtubeUrl: string | null;
  videoId: string | null;
  summary: string | null;
}) {
  return [
    `Video published: ${input.title}`,
    "",
    "Task:",
    "- Draft a Spanish email announcement for this newly published AIPaths YouTube video.",
    "- Focus on the problem/idea from the video, why subscribers should care, and a clear CTA to watch it.",
    "- Do not send or schedule the email.",
    "- Complete this work item with output.email_draft containing: subject, preview_text, body_markdown.",
    "- Mission Control will move the email card to ready_for_review after completion.",
    "",
    `YouTube URL: ${input.youtubeUrl || "(not provided)"}`,
    `Video ID: ${input.videoId || "(not provided)"}`,
    `Context: ${input.summary || "(none yet)"}`,
  ].join("\n");
}

async function createVideoAnnouncementEmailWorkItem(input: {
  db?: ReturnType<typeof createServiceClient>;
  localMode?: boolean;
  videoPipelineItemId: string;
  title: string;
  priority: string | null;
  requestedBy: string;
  youtubeUrl: string | null;
  videoId: string | null;
  summary: string | null;
  localClient?: Parameters<typeof updatePipelineItemLocal>[2];
}) {
  const emailItem = input.localMode
    ? await getOrCreateVideoAnnouncementEmailItemLocal({
        videoPipelineItemId: input.videoPipelineItemId,
        title: input.title,
        priority: input.priority,
        requestedBy: input.requestedBy,
        youtubeUrl: input.youtubeUrl,
        videoId: input.videoId,
        summary: input.summary,
      }, input.localClient)
    : await (async () => {
        const now = new Date().toISOString();
        const { data: existing, error: existingError } = await input.db!
          .from("pipeline_items")
          .select("id,title,status")
          .eq("pipeline_type", "email_campaign")
          .contains("metadata", {
            kind: "video_announcement",
            source_video_pipeline_item_id: input.videoPipelineItemId,
          })
          .order("created_at", { ascending: false })
          .limit(1);

        if (existingError) throw existingError;
        let created = existing?.[0] || null;
        if (!created) {
          const { data: inserted, error: insertError } = await input.db!
            .from("pipeline_items")
            .insert({
              title: `Anuncio video: ${input.title}`,
              pipeline_type: "email_campaign",
              status: "drafting",
              priority: input.priority || "medium",
              owner_agent: "marketing",
              requested_by: input.requestedBy,
              source_type: "pipeline_item",
              source_id: input.videoPipelineItemId,
              metadata: {
                kind: "video_announcement",
                source_video_pipeline_item_id: input.videoPipelineItemId,
                youtube_url: input.youtubeUrl,
                video_id: input.videoId,
                summary: input.summary,
                requested_at: now,
                requested_by: input.requestedBy,
              },
              asset_role: "standalone",
              updated_at: now,
            })
            .select("id,title,status")
            .single();

          if (insertError || !inserted) throw insertError || new Error("Failed to create video announcement email item");
          created = inserted;
        }
        return created;
      })();

  const workInput = {
    pipelineItemId: emailItem.id,
    pipelineType: "email_campaign",
    title: `Draft video announcement email: ${input.title}`,
    instruction: createVideoAnnouncementEmailInstruction({
      title: input.title,
      youtubeUrl: input.youtubeUrl,
      videoId: input.videoId,
      summary: input.summary,
    }),
    priority: input.priority || "medium",
    ownerAgent: "marketing",
    requestedBy: input.requestedBy,
    relationType: "draft_video_announcement",
    action: "draft_video_announcement",
    trigger: "video_published_manual",
    payloadExtra: {
      source_video_pipeline_item_id: input.videoPipelineItemId,
      youtube_url: input.youtubeUrl,
      video_id: input.videoId,
      newsletter_kind: "video_announcement",
    },
  };
  const result = input.localMode
    ? await createPipelineWorkItemLocal(workInput, input.localClient)
    : await createPipelineWorkItem(input.db!, workInput);

  return { emailItem, ...result };
}

function createStageAutomationInstruction(input: {
  title: string;
  stage: string;
  note: string | null;
  existingSummary: string | null;
}) {
  if (input.stage === "title_thumbnail") {
    return [
      `YouTube pipeline item: ${input.title}`,
      "Automation: YouTube Opportunity Brief + light packaging research",
      "",
      "Goal:",
      "- Help Gonza filter too many video ideas quickly.",
      "- This is not deep research and not a long report.",
      "- Contrast the idea against AIPaths channel patterns that have worked: concrete problem/object, clear promise, clear viewer, simple tension, fit with the channel pillars, and fit with the AIPaths persona.",
      "",
      "Use available AIPaths YouTube data/knowledge when possible:",
      "- Own channel winners: WhatsApp chatbot, Mac Mini, OpenClaw from zero, cost/agents, API/automation topics.",
      "- Pillars/categories: Tutorial con Contexto, Historia/Autoridad, Build in Public, Concepto/Autoridad when useful.",
      "- Persona source of truth: director-youtube/context/persona.md. Evaluate fit with El Operador Apalancado: Spanish-speaking entrepreneur/operator/freelancer/creator/small business owner who wants practical AI leverage in their own business, not hype or deep tech.",
      "- Do quick demand checks only if useful: search language, autocomplete/trends/competitors. Keep it brief.",
      "",
      "Output:",
      "- Save a short markdown brief into metadata.youtube_v0.opportunity_brief_md if your tooling supports it.",
      "- Also save structured fields into metadata.youtube_v0.opportunity_brief if possible.",
      "- Save title candidates and thumbnail directions into metadata.youtube_v0.title_lab.",
      "",
      "Markdown format:",
      "## Video Opportunity Brief",
      "",
      "### Idea",
      input.title,
      "",
      "### Categoría",
      "One of: Tutorial con Contexto / Historia-Autoridad / Build in Public / Concepto-Autoridad / Hybrid. Explain in one sentence.",
      "",
      "### Persona",
      "Who this is for, in plain language.",
      "",
      "### Persona fit",
      "High / Medium / Low fit with El Operador Apalancado from director-youtube/context/persona.md. Explain whether the idea helps them gain practical AI leverage in their own business, reduce operational load, choose tools, avoid hype/cost mistakes, or build useful agents/automation. If fit is weak, say why.",
      "",
      "### Promesa",
      "What the viewer will understand, be able to do, or decide after watching.",
      "",
      "### Por qué podría funcionar",
      "3-5 bullets tied to AIPaths data/patterns, demand signal, concrete object/problem, titleability, or timing.",
      "",
      "### Riesgo",
      "1-3 bullets: why it may underperform or become too generic/technical/unclear.",
      "",
      "### Score inicial",
      "0-10, with one-line justification. Score prioritizes: AIPaths fit, proven channel pattern, clear person, strong promise, tension/clickability, production ease, evergreen/browse potential.",
      "",
      "### Recomendación",
      "Promote / Park / Needs angle. Include the next best action.",
      "",
      "Title/thumbnail add-on:",
      "- Propose 5-8 title candidates.",
      "- Propose 1-3 thumbnail directions.",
      "- Keep all output concise and decision-oriented.",
      "",
      `Existing context: ${input.existingSummary || "(none)"}`,
      `Human note: ${input.note || "(none)"}`,
    ].join("\n");
  }

  if (input.stage === "research" || input.stage === "researching") {
    return [
      `YouTube pipeline item: ${input.title}`,
      "Automation: deep research report",
      "",
      "Task:",
      "- Do the deeper research pass after the idea/package has been selected.",
      "- Check competitor videos, transcript summaries when available, audience demand, supply gap, and AIPaths differentiation.",
      "- Produce a structured research report with: market evidence, competing angles, content gaps, best AIPaths promise, risks, and recommendation.",
      "- Save the result into metadata.youtube_v0.deep_research if your tooling supports it.",
      "- Finish with a clear recommendation for whether to move to bullets.",
      "",
      `Existing context: ${input.existingSummary || "(none)"}`,
      `Human note: ${input.note || "(none)"}`,
    ].join("\n");
  }

  if (input.stage === "bullets") {
    return [
      `YouTube pipeline item: ${input.title}`,
      "Automation: chapter bullets for recording",
      "",
      "Task:",
      "- Convert the selected idea, title/package, and research into chronological chapter bullets.",
      "- Do not write a full script.",
      "- Separate the video into practical chapters with concise bullets per chapter.",
      "- Include opening promise, key proof/demo beats, transitions, and CTA.",
      "- Save the result into metadata.youtube_v0.bullet_points if your tooling supports it.",
      "- Finish with a recording-readiness note.",
      "",
      `Existing context: ${input.existingSummary || "(none)"}`,
      `Human note: ${input.note || "(none)"}`,
    ].join("\n");
  }

  return null;
}

function getStageAutomationConfig(stage: string) {
  if (stage === "title_thumbnail") {
    return {
      relationType: "youtube_light_research",
      titlePrefix: "Light research + packaging",
      action: "youtube_light_research",
      trigger: "youtube_stage_title_thumbnail",
    };
  }
  if (stage === "research" || stage === "researching") {
    return {
      relationType: "youtube_deep_research",
      titlePrefix: "Deep research report",
      action: "youtube_deep_research",
      trigger: "youtube_stage_research",
    };
  }
  if (stage === "bullets") {
    return {
      relationType: "youtube_bullet_points",
      titlePrefix: "Create chapter bullets",
      action: "youtube_bullet_points",
      trigger: "youtube_stage_bullets",
    };
  }
  return null;
}

async function createStageAutomationWorkItem(input: {
  db?: ReturnType<typeof createServiceClient>;
  localMode?: boolean;
  pipelineItemId: string;
  title: string;
  stage: string;
  priority: string | null;
  requestedBy: string;
  note: string | null;
  existingSummary: string | null;
  localClient?: Parameters<typeof updatePipelineItemLocal>[2];
}) {
  const config = getStageAutomationConfig(input.stage);
  if (!config) return null;

  const instruction = createStageAutomationInstruction({
    title: input.title,
    stage: input.stage,
    note: input.note,
    existingSummary: input.existingSummary,
  });
  if (!instruction) return null;

  const workInput = {
    pipelineItemId: input.pipelineItemId,
    pipelineType: "video",
    title: `${config.titlePrefix}: ${input.title}`,
    instruction,
    priority: input.priority || "medium",
    ownerAgent: "youtube",
    requestedBy: input.requestedBy,
    relationType: config.relationType,
    mapRelationType: "followup",
    payloadRelationType: config.relationType,
    action: config.action,
    trigger: config.trigger,
    payloadExtra: {
      youtube_stage: input.stage,
      automation_kind: config.relationType,
    },
  };

  return input.localMode
    ? createPipelineWorkItemLocal(workInput, input.localClient)
    : createPipelineWorkItem(input.db!, workInput);
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
  const useLocalMode = isLocalAuthDisabled();
  const supabase = useLocalMode ? null : await createClient();
  const db = useLocalMode ? null : createServiceClient();

  const body = (await request.json()) as JsonRecord;

  const actor = useLocalMode ? getLocalMissionControlUser() : null;

  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await supabase!.auth.getUser();
    user = authResult.data.user;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const item = useLocalMode
    ? await getPipelineItemLocal(id, "video")
    : await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .select("*")
          .eq("id", id)
          .eq("pipeline_type", "video")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!item) {
    return NextResponse.json({ error: "Video item not found" }, { status: 404 });
  }

  const actorIdentity = String(user.email || user.id || "local@mission-control");
  const now = new Date().toISOString();
  const metadata = getYouTubeMetadata(item.metadata);
  const requestedAction = typeof body.action === "string" ? body.action : null;

  if (requestedAction === "save_learning_review") {
    const learning = toRecord(body.learning);
    if (useLocalMode) {
      const signature = `save_learning_review:${JSON.stringify(learning)}`;
      const result = await withLockedPipelineItemLocal(id, ["video"], async ({ client, item: lockedItem }) => {
        const lockedMetadata = getYouTubeMetadata(lockedItem.metadata);
        if (lockedMetadata.local_transition_signature === signature) return { item: lockedItem };
        const nextMetadata = {
          ...lockedMetadata,
          youtube_learning_v1: {
            ...toRecord(lockedMetadata.youtube_learning_v1),
            ...learning,
            updated_at: now,
            updated_by: actorIdentity,
          },
          local_transition_signature: signature,
        };
        const updated = await updatePipelineItemLocal(id, {
          owner_agent: String(lockedItem.owner_agent || "youtube"),
          metadata: nextMetadata,
          updated_at: now,
        }, client);
        if (!updated) throw new Error("Failed to update learning review");
        await insertPipelineTransitionEventLocal(client, {
          domain: "youtube",
          eventType: "youtube.save_learning_review",
          pipelineItemId: id,
          actor: actorIdentity,
          dedupeKey: signature,
          payload: { from_status: lockedItem.status, to_status: lockedItem.status },
        });
        return { item: updated };
      });
      if (!result) return NextResponse.json({ error: "Video item not found" }, { status: 404 });
      return NextResponse.json({ item: result.item });
    }

    const existingLearning = toRecord(metadata.youtube_learning_v1);
    const nextLearning = {
      ...existingLearning,
      ...learning,
      updated_at: now,
      updated_by: actorIdentity,
    };
    const nextMetadata = { ...metadata, youtube_learning_v1: nextLearning };
    const updated = await (async () => {
      const { data, error } = await db!
        .from("pipeline_items")
        .update({ owner_agent: item.owner_agent || "youtube", metadata: nextMetadata, updated_at: now })
        .eq("id", id)
        .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    })().catch(() => null);
    if (!updated) return NextResponse.json({ error: "Failed to update learning review" }, { status: 500 });
    return NextResponse.json({ item: updated });
  }

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
    const existingSummary = firstStringFromPaths([youtubeV0, metadata, toRecord(metadata.intel), toRecord(metadata.analysis)], [
      ["summary"],
      ["summary_short"],
      ["why_it_matters"],
      ["core_hypothesis"],
      ["notes"],
    ]);
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
          by: actorIdentity,
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

    if (useLocalMode) {
      const signature = `set_stage:${requestedStage}:${note || ""}:${youtubeUrl || ""}:${videoId || ""}`;
      const result = await withLockedPipelineItemLocal(id, ["video"], async ({ client, item: lockedItem }) => {
        const lockedMetadata = getYouTubeMetadata(lockedItem.metadata);
        if (lockedMetadata.local_transition_signature === signature) {
          return { kind: "replay" as const, item: lockedItem, stageAutomationWorkItem: null, snapshotWorkItems: [], emailAnnouncementWorkItem: null };
        }
        if (String(lockedItem.updated_at || "") !== String(item.updated_at || "") || lockedItem.status !== item.status) {
          return { kind: "stale" as const };
        }

        const stageAutomationWorkItem = await createStageAutomationWorkItem({
          localMode: true,
          localClient: client,
          pipelineItemId: String(lockedItem.id),
          title: String(lockedItem.title),
          stage: requestedStage,
          priority: trimToNull(lockedItem.priority),
          requestedBy: actorIdentity,
          note,
          existingSummary,
        });
        const snapshotWorkItems = requestedStage === "published" && (youtubeUrl || videoId)
          ? await createPublishedSnapshotWorkItems({
              localMode: true,
              localClient: client,
              pipelineItemId: String(lockedItem.id),
              title: String(lockedItem.title),
              priority: trimToNull(lockedItem.priority),
              requestedBy: actorIdentity,
              publishedAt: String(publishedAt || now),
              youtubeUrl,
              videoId,
            })
          : [];
        const emailAnnouncementWorkItem = requestedStage === "published"
          ? await createVideoAnnouncementEmailWorkItem({
              localMode: true,
              localClient: client,
              videoPipelineItemId: String(lockedItem.id),
              title: String(lockedItem.title),
              priority: trimToNull(lockedItem.priority),
              requestedBy: actorIdentity,
              youtubeUrl,
              videoId,
              summary: existingSummary,
            })
          : null;
        const updated = await updatePipelineItemLocal(id, {
          ...updatePayload,
          metadata: { ...nextMetadata, local_transition_signature: signature },
        }, client);
        if (!updated) throw new Error("Failed to update stage");
        await insertPipelineTransitionEventLocal(client, {
          domain: "youtube",
          eventType: "youtube.set_stage",
          pipelineItemId: id,
          actor: actorIdentity,
          dedupeKey: signature,
          payload: { from_status: lockedItem.status, to_status: requestedStage },
        });
        return { kind: "success" as const, item: updated, stageAutomationWorkItem, snapshotWorkItems, emailAnnouncementWorkItem };
      });
      if (!result) return NextResponse.json({ error: "Video item not found" }, { status: 404 });
      if (result.kind === "stale") return NextResponse.json({ error: "Video item changed; retry transition" }, { status: 409 });
      return NextResponse.json({
        item: result.item,
        stageAutomationWorkItem: result.stageAutomationWorkItem,
        snapshotWorkItems: result.snapshotWorkItems,
        emailAnnouncementWorkItem: result.emailAnnouncementWorkItem,
      });
    }

    const updated = await (async () => {
      const { data, error } = await db!
        .from("pipeline_items")
        .update(updatePayload)
        .eq("id", id)
        .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    })().catch(() => null);
    if (!updated) return NextResponse.json({ error: "Failed to update stage" }, { status: 500 });

    const stageAutomationWorkItem = await createStageAutomationWorkItem({
      db: db!, localMode: false, pipelineItemId: item.id, title: item.title, stage: requestedStage,
      priority: item.priority, requestedBy: actorIdentity, note, existingSummary,
    });
    const snapshotWorkItems = requestedStage === "published" && (youtubeUrl || videoId)
      ? await createPublishedSnapshotWorkItems({
          db: db!, localMode: false, pipelineItemId: item.id, title: item.title, priority: item.priority,
          requestedBy: actorIdentity, publishedAt: now, youtubeUrl, videoId,
        })
      : [];
    const emailAnnouncementWorkItem = requestedStage === "published"
      ? await createVideoAnnouncementEmailWorkItem({
          db: db!, localMode: false, videoPipelineItemId: item.id, title: item.title, priority: item.priority,
          requestedBy: actorIdentity, youtubeUrl, videoId, summary: existingSummary,
        })
      : null;
    return NextResponse.json({ item: updated, stageAutomationWorkItem, snapshotWorkItems, emailAnnouncementWorkItem });
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
    decided_by: actorIdentity,
    updated_at: now,
    history: [
      ...((Array.isArray(previousGate.history) ? previousGate.history : []) || []),
      buildGateHistoryEntry({
        at: now,
        by: actorIdentity,
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

  if (useLocalMode) {
    const signature = `gate:${gateKey}:${actionType}:${nextGateStatus}:${safeReason || ""}:${safeEvidenceSummary || ""}:${safeNextAction || ""}:${shouldCreateWorkItem}`;
    const result = await withLockedPipelineItemLocal(id, ["video"], async ({ client, item: lockedItem }) => {
      const lockedMetadata = getYouTubeMetadata(lockedItem.metadata);
      if (lockedMetadata.local_transition_signature === signature) return { kind: "replay" as const, item: lockedItem, workItem: null };
      if (String(lockedItem.updated_at || "") !== String(item.updated_at || "") || lockedItem.status !== item.status) return { kind: "stale" as const };

      let localWorkItem: { id?: string } | null = null;
      if (shouldCreateWorkItem) {
        const relationType = requestedWorkItemRelationType === "investigate" ? "investigate" : gateKey;
        const work = await createPipelineWorkItemLocal({
          pipelineItemId: String(lockedItem.id),
          pipelineType: "video",
          title: relationType === "investigate"
            ? `Investigate ${YOUTUBE_GATE_META[gateKey].label}: ${lockedItem.title}`
            : `YouTube ${YOUTUBE_GATE_META[gateKey].label}: ${lockedItem.title}`,
          instruction: createWorkItemInstruction({
            title: String(lockedItem.title), gateKey, gateStatus: nextGateStatus, actionType, reason: safeReason,
            evidenceSummary: actionType === "send_to_agent" ? previousGate.evidence_summary || null : safeEvidenceSummary,
            nextAction: safeNextAction,
          }),
          priority: priorityLevelFromScore(scores.priority), ownerAgent: "youtube", requestedBy: actorIdentity,
          relationType, mapRelationType: "investigate", payloadRelationType: relationType,
          action: `youtube_gate_${gateKey}`, trigger: "youtube_decision_board",
        }, client);
        localWorkItem = work.workItem || null;
        if (localWorkItem?.id) nextMetadata.gates[gateKey] = { ...updatedGate, work_item_id: localWorkItem.id };
      }
      const updated = await updatePipelineItemLocal(id, {
        status: derivedStatus,
        priority: priorityLevelFromScore(scores.priority),
        owner_agent: "youtube",
        metadata: { ...nextMetadata, local_transition_signature: signature },
        updated_at: now,
      }, client);
      if (!updated) throw new Error("Failed to update gate state");
      await insertPipelineTransitionEventLocal(client, {
        domain: "youtube", eventType: `youtube.${actionType}`, pipelineItemId: id, actor: actorIdentity,
        dedupeKey: signature,
        payload: { gate_key: gateKey, from_status: lockedItem.status, to_status: derivedStatus, work_item_id: localWorkItem?.id || null },
      });
      return { kind: "success" as const, item: updated, workItem: localWorkItem };
    });
    if (!result) return NextResponse.json({ error: "Video item not found" }, { status: 404 });
    if (result.kind === "stale") return NextResponse.json({ error: "Video item changed; retry transition" }, { status: 409 });
    return NextResponse.json({ item: result.item, workItem: result.workItem });
  }

  let workItem: { id?: string } | null = null;
  if (shouldCreateWorkItem) {
    const relationType = requestedWorkItemRelationType === "investigate" ? "investigate" : gateKey;
    const title = relationType === "investigate"
      ? `Investigate ${YOUTUBE_GATE_META[gateKey].label}: ${item.title}`
      : `YouTube ${YOUTUBE_GATE_META[gateKey].label}: ${item.title}`;
    const result = await createPipelineWorkItem(db!, {
      pipelineItemId: item.id,
      pipelineType: "video",
      title,
      instruction: createWorkItemInstruction({
        title: item.title, gateKey, gateStatus: nextGateStatus, actionType, reason: safeReason,
        evidenceSummary: actionType === "send_to_agent" ? previousGate.evidence_summary || null : safeEvidenceSummary,
        nextAction: safeNextAction,
      }),
      priority: priorityLevelFromScore(scores.priority), ownerAgent: "youtube", requestedBy: actorIdentity,
      relationType, mapRelationType: "investigate", payloadRelationType: relationType,
      action: `youtube_gate_${gateKey}`, trigger: "youtube_decision_board",
    });
    workItem = result.workItem || null;
    if (workItem?.id) nextMetadata.gates[gateKey] = { ...updatedGate, work_item_id: workItem.id };
  }

  const updated = await (async () => {
    const { data, error } = await db!
      .from("pipeline_items")
      .update({
        status: derivedStatus, priority: priorityLevelFromScore(scores.priority), owner_agent: "youtube",
        metadata: nextMetadata, updated_at: now,
      })
      .eq("id", id)
      .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return data;
  })().catch(() => null);
  if (!updated) return NextResponse.json({ error: "Failed to update gate state" }, { status: 500 });
  return NextResponse.json({ item: updated, workItem });
}
