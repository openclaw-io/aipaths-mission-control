import { createServiceClient, supabaseAdmin } from "@/lib/supabase/admin";
import {
  DESTINATION_ALIASES,
  INTEL_DESTINATION_CONFIG,
  type IntelDestinationConfig,
  type IntelDestinationKey,
} from "@/lib/intel-destinations";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";

export type IntelInboxStatus = "new" | "saved" | "dismissed" | "promoted";
export type { IntelDestinationKey } from "@/lib/intel-destinations";

type StoredPromotionMeta = {
  version: 1;
  destinations: Array<{
    key: IntelDestinationKey;
    label: string;
    director: IntelDestinationConfig["director"];
    pipelineItemId: string;
    pipelineType: IntelDestinationConfig["pipelineType"];
  }>;
};

type ParsedReviewNotes = {
  userNotes: string | null;
  promotionMeta: StoredPromotionMeta | null;
};

const INTEL_PROMOTION_META_PREFIX = "[INTEL_PROMOTION_META]";
const LATEST_BATCH_GAP_MS = 20 * 60 * 1000;
const LATEST_BATCH_MAX_SPAN_MS = 90 * 60 * 1000;

export type IntelInboxListItem = {
  id: string;
  enrichedItemId: number;
  title: string;
  summary: string;
  miniDescription: string;
  sourceKind: "youtube" | "reddit" | "web" | "producthunt" | "github" | "hackernews" | "other";
  sourceLabel: string;
  discussionContext: string | null;
  lane: string | null;
  primaryTopic: string | null;
  suggestedOwner: string | null;
  suggestedDestination: string | null;
  suggestedDestinations: IntelDestinationKey[];
  promoteType: string | null;
  promoteOwner: string | null;
  promoteStatusDefault: string | null;
  overallScore: number;
  reviewStatus: IntelInboxStatus;
  reviewId: string | null;
  createdPipelineItemId: string | null;
  updatedAt: string;
  createdAt: string;
  isLatestRun: boolean;
};

export type IntelInboxHealth = {
  status: "ok" | "warn";
  latestCompetitorRunAt: string | null;
  latestCompetitorRunStatus: string | null;
  enabledCompetitors: number;
  unresolvedCompetitors: number;
  failingSources: number;
  lastError: string | null;
  pipeline: {
    rawRecent: number;
    enrichedRecent: number;
    visibleInbox: number;
    redditWithDiscussion: number;
    youtubeTranscriptSummaries: number;
    transcriptsFetched: number;
    transcriptsSummarized: number;
    transcriptsUnavailable: number;
    transcriptsFailed: number;
    duplicateSnapshotGroups: number;
    duplicateSnapshotRows: number;
  };
};

export type IntelInboxDetail = {
  item: IntelInboxListItem & {
    whyItMatters: string | null;
    rawItemId: number | null;
    metadata: Record<string, unknown>;
    formatScores: Record<string, number>;
    promoteCollaborators: string[];
  };
  rawSource: {
    id: number;
    title: string | null;
    url: string | null;
    canonicalUrl: string | null;
    sourceContext: string | null;
    author: string | null;
    lane: string | null;
    contentText: string | null;
    publishedAt: string | null;
    firstSeenAt: string | null;
    engagementScore: number;
    engagementCount: number | null;
    rawJson: Record<string, unknown>;
    metadataJson: Record<string, unknown>;
  } | null;
  review: {
    id: string | null;
    reviewer: string | null;
    status: IntelInboxStatus;
    selectedPipelineType: string | null;
    selectedOwnerAgent: string | null;
    selectedCollaborators: string[];
    selectedDestinations: IntelDestinationKey[];
    decisionReasoning: string | null;
    notes: string | null;
    createdPipelineItemId: string | null;
    reviewedAt: string | null;
    updatedAt: string | null;
  } | null;
  pipelineItem: {
    id: string;
    title: string;
    pipelineType: string;
    status: string;
    ownerAgent: string | null;
    updatedAt: string;
  } | null;
};

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizeStatus(value: unknown): IntelInboxStatus {
  if (value === "saved" || value === "dismissed" || value === "promoted") return value;
  return "new";
}

function trimToNull(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stripTrailingPeriod(text: string) {
  return text.trim().replace(/[.。!]+$/g, "");
}

function sentence(text: string) {
  const clean = stripTrailingPeriod(text);
  if (!clean) return "";
  return `${clean}.`;
}

function buildReadableSummary(params: {
  title: string;
  summaryShort: string | null;
  whyItMatters: string | null;
  rawTitle: string | null;
  rawContentText: string | null;
  transcriptSummary?: string | null;
}) {
  const title = params.title.trim();
  const summary = (params.summaryShort || "").trim();
  const why = (params.whyItMatters || "").trim();
  const transcriptSummary = (params.transcriptSummary || "").trim();
  const rawTitle = (params.rawTitle || "").trim();
  const rawContent = (params.rawContentText || "").trim();

  const lowerCombined = `${title} ${rawTitle} ${summary}`.toLowerCase();
  const versionMatch = lowerCombined.match(/(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){1,3})/i);
  const version = versionMatch?.[1] || null;

  if (lowerCombined.includes("openclaw") && version) {
    const first = `Se actualizó OpenClaw a la versión ${version}.`;
    const secondSource = summary || rawContent || why;
    if (secondSource) {
      const clean = stripTrailingPeriod(secondSource);
      return `${first}\n\n${sentence(`Los cambios más importantes incluyen ${clean.charAt(0).toLowerCase()}${clean.slice(1)}`)}`;
    }
    return first;
  }

  if (transcriptSummary) return transcriptSummary;

  const leadSource = summary || rawTitle || title;
  const detailSource = why;

  if (detailSource && stripTrailingPeriod(detailSource) !== stripTrailingPeriod(leadSource)) {
    return `${sentence(leadSource)}\n\n${sentence(detailSource)}`;
  }

  if (!summary && rawContent) {
    const firstSentence = rawContent
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .find((part) => part.length > 40 && part.length < 220);
    if (firstSentence && stripTrailingPeriod(firstSentence) !== stripTrailingPeriod(leadSource)) {
      return `${sentence(leadSource)}\n\n${sentence(firstSentence)}`;
    }
  }

  return sentence(leadSource) || "Sin resumen";
}

function buildMiniDescription(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Sin resumen breve";
  if (clean.length <= 150) return clean;
  return `${clean.slice(0, 147).trimEnd()}...`;
}

function normalizedComparableText(value: unknown) {
  return String(value || "")
    .replace(/&[#a-z0-9]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isEditorialSummaryReady(params: {
  title: unknown;
  summaryDisplay: unknown;
  summaryShort: unknown;
  whyItMatters: unknown;
  headlineShort: unknown;
  transcriptSummary?: unknown;
}) {
  const title = normalizedComparableText(params.title);
  const summaryDisplay = normalizedComparableText(params.summaryDisplay);
  const summaryShort = normalizedComparableText(params.summaryShort);
  const why = normalizedComparableText(params.whyItMatters);
  const headline = normalizedComparableText(params.headlineShort);
  const transcript = normalizedComparableText(params.transcriptSummary);
  const summary = transcript || summaryDisplay || summaryShort;

  if (!summary || summary.length < 80) return false;
  if (!why || why.length < 50) return false;
  if (!headline || headline.length < 12 || headline.length > 140) return false;
  if (title && summary === title) return false;
  if (title && summary.length > 80 && title.includes(summary.slice(0, 80))) return false;
  if (/señal técnica relevante\.?$/i.test(summary)) return false;
  if (/sin resumen|no summary|summary pending/i.test(summary)) return false;
  return true;
}

function hostnameFromUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function classifySourceKind(params: { lane?: unknown; url?: unknown; canonicalUrl?: unknown; sourceContext?: unknown; rawJson?: unknown }) {
  const host = hostnameFromUrl(params.canonicalUrl) || hostnameFromUrl(params.url) || "";
  const lane = typeof params.lane === "string" ? params.lane.toLowerCase() : "";
  const sourceContext = typeof params.sourceContext === "string" ? params.sourceContext.toLowerCase() : "";
  const raw = toObject(params.rawJson);
  const rawSource = typeof raw.source === "string" ? raw.source.toLowerCase() : "";

  if (lane === "competitor" || host.includes("youtube.com") || host.includes("youtu.be")) return "youtube" as const;
  if (host.includes("reddit.com") || sourceContext.includes("reddit") || rawSource === "reddit") return "reddit" as const;
  if (host.includes("producthunt.com") || sourceContext.includes("product hunt") || rawSource === "producthunt") return "producthunt" as const;
  if (host.includes("github.com") || sourceContext.includes("github")) return "github" as const;
  if (host.includes("ycombinator.com") || sourceContext.includes("hacker news") || rawSource === "hackernews") return "hackernews" as const;
  if (lane === "industry" || host) return "web" as const;
  return "other" as const;
}

function sourceLabelFromKind(kind: ReturnType<typeof classifySourceKind>, fallback?: string | null) {
  if (fallback) return fallback;
  switch (kind) {
    case "youtube": return "YouTube";
    case "reddit": return "Reddit";
    case "producthunt": return "Product Hunt";
    case "github": return "GitHub";
    case "hackernews": return "Hacker News";
    case "web": return "Web";
    default: return "Fuente";
  }
}

function countStoredComments(rawJson: unknown) {
  const raw = toObject(rawJson);
  const metadata = toObject(raw.metadata);
  const candidates = [raw.comments, raw.top_comments, metadata.top_comments, metadata.comments];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function getDiscussionContext(params: {
  sourceKind: ReturnType<typeof classifySourceKind>;
  metadata?: Record<string, unknown>;
  rawJson?: unknown;
}) {
  if (params.sourceKind === "youtube") {
    return params.metadata?.transcript_summary_used ? "YouTube transcript" : "YouTube title only";
  }
  if (params.sourceKind !== "reddit") return null;
  const used = toNumber(params.metadata?.comments_used);
  const stored = countStoredComments(params.rawJson);
  const count = Math.max(used, stored);
  if (count <= 0) return "Reddit · sin comentarios cargados";
  return `Reddit discussion · ${count} comentario${count === 1 ? "" : "s"}`;
}

function normalizeDestinationKey(value: unknown): IntelDestinationKey | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return DESTINATION_ALIASES[normalized] || null;
}

function uniqueDestinationKeys(values: unknown[]): IntelDestinationKey[] {
  const seen = new Set<IntelDestinationKey>();
  for (const value of values) {
    const normalized = normalizeDestinationKey(value);
    if (normalized) seen.add(normalized);
  }
  return Array.from(seen);
}

function getDestinationSuggestions(params: {
  suggestedDestination?: unknown;
  promoteType?: unknown;
  metadata?: Record<string, unknown>;
}): IntelDestinationKey[] {
  const metadata = params.metadata || {};
  const explicitCandidates = [
    params.suggestedDestination,
    metadata.suggested_destination,
    ...(Array.isArray(metadata.suggested_destinations) ? metadata.suggested_destinations : []),
  ];
  const explicit = uniqueDestinationKeys(explicitCandidates);
  if (explicit.length > 0) return explicit;
  return uniqueDestinationKeys([params.promoteType]);
}

function getLegacyFallbackDestinations(params: {
  suggestedDestination?: unknown;
  promoteType?: unknown;
  metadata?: Record<string, unknown>;
  ownerAgent?: string | null;
}): IntelDestinationKey[] {
  const suggested = getDestinationSuggestions(params);
  if (suggested.length > 0) return suggested;

  const owner = trimToNull(params.ownerAgent || undefined)?.toLowerCase();
  if (owner === "marketing") return ["email"];
  if (owner === "youtube") return ["video"];
  if (owner === "community") return ["news"];
  return [];
}

function getLatestRunToken(metadata: Record<string, unknown>) {
  const candidates = [
    metadata.ingestion_run_id,
    metadata.ingestionRunId,
    metadata.pipeline_run_id,
    metadata.run_id,
    metadata.runId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  return null;
}

function inferLatestRunIds(
  rows: Array<{
    id: number;
    createdAt: string;
    metadata: Record<string, unknown>;
  }>
) {
  if (rows.length === 0) return new Set<number>();

  const datedRows = rows
    .map((row) => ({ ...row, time: new Date(row.createdAt).getTime(), runToken: getLatestRunToken(row.metadata) }))
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => b.time - a.time);

  if (datedRows.length === 0) return new Set<number>();

  const latest = datedRows[0];

  // Preferred path for future hardening: once `intel_items_enriched.ingestion_run_id`
  // exists in the app schema, replace this helper to group strictly by that column.
  // Today we first honor a run token if one is already present in metadata and
  // otherwise infer the newest batch from the latest created_at cluster.
  if (latest.runToken) {
    return new Set(datedRows.filter((row) => row.runToken === latest.runToken).map((row) => row.id));
  }

  const latestIds = new Set<number>([latest.id]);
  let previousTime = latest.time;

  for (let index = 1; index < datedRows.length; index += 1) {
    const row = datedRows[index];
    const spanFromLatest = latest.time - row.time;
    const gapFromPrevious = previousTime - row.time;

    if (spanFromLatest > LATEST_BATCH_MAX_SPAN_MS) break;
    if (gapFromPrevious > LATEST_BATCH_GAP_MS) break;

    latestIds.add(row.id);
    previousTime = row.time;
  }

  return latestIds;
}

function parseStoredReviewNotes(value: unknown): ParsedReviewNotes {
  if (typeof value !== "string" || !value.trim()) {
    return { userNotes: null, promotionMeta: null };
  }

  const markerIndex = value.lastIndexOf(INTEL_PROMOTION_META_PREFIX);
  if (markerIndex === -1) {
    return { userNotes: trimToNull(value), promotionMeta: null };
  }

  const userNotes = trimToNull(value.slice(0, markerIndex));
  const rawMeta = value.slice(markerIndex + INTEL_PROMOTION_META_PREFIX.length).trim();

  try {
    const parsed = JSON.parse(rawMeta) as StoredPromotionMeta;
    const destinations = Array.isArray(parsed?.destinations)
      ? parsed.destinations.filter((entry) => normalizeDestinationKey(entry?.key)).map((entry) => ({
          key: normalizeDestinationKey(entry.key)!,
          label: typeof entry.label === "string" ? entry.label : INTEL_DESTINATION_CONFIG[normalizeDestinationKey(entry.key)!].label,
          director: INTEL_DESTINATION_CONFIG[normalizeDestinationKey(entry.key)!].director,
          pipelineItemId: typeof entry.pipelineItemId === "string" ? entry.pipelineItemId : "",
          pipelineType: INTEL_DESTINATION_CONFIG[normalizeDestinationKey(entry.key)!].pipelineType,
        }))
      : [];

    return {
      userNotes,
      promotionMeta: destinations.length > 0 ? { version: 1, destinations } : null,
    };
  } catch {
    return { userNotes: trimToNull(value), promotionMeta: null };
  }
}

function serializeReviewNotes(notes: string | null | undefined, promotionMeta: StoredPromotionMeta | null) {
  const cleanNotes = trimToNull(notes || undefined);
  if (!promotionMeta) return cleanNotes;

  const metadataBlock = `${INTEL_PROMOTION_META_PREFIX}${JSON.stringify(promotionMeta)}`;
  return cleanNotes ? `${cleanNotes}\n\n${metadataBlock}` : metadataBlock;
}

function buildDestinationInstruction(params: {
  destination: IntelDestinationConfig;
  title: string;
  summary: string;
  reviewer: string;
  notes?: string | null;
}) {
  const reviewNotes = trimToNull(params.notes || undefined);
  const lines = [
    `Intel inbox item: ${params.title}`,
    "",
    "Resumen:",
    params.summary || "Sin resumen",
    "",
  ];

  switch (params.destination.key) {
    case "blog":
      lines.push(
        "Task:",
        "- Turn this signal into a blog draft direction for AIPaths.",
        "- Choose the strongest editorial angle, outline the argument, and flag any missing evidence.",
      );
      break;
    case "guide":
      lines.push(
        "Task:",
        "- Turn this signal into a practical guide concept for AIPaths.",
        "- Focus on steps, utility, and what a reader should do next.",
      );
      break;
    case "email":
      lines.push(
        "Task:",
        "- Turn this signal into an email campaign concept.",
        "- Recommend the hook, segment, and CTA that best fits the insight.",
      );
      break;
    case "video":
      lines.push(
        "Task:",
        "- Turn this signal into a YouTube video concept.",
        "- Recommend the core angle, audience promise, and production notes.",
      );
      break;
    case "short":
      lines.push(
        "Task:",
        "- Turn this signal into a YouTube Short concept.",
        "- Focus on the shortest high-clarity hook and one punchy takeaway.",
      );
      break;
    case "news":
      lines.push(
        "Task:",
        "- Draft a Spanish community/news post for the AIPaths Discord audience.",
        "- Keep it timely, clear, useful, and practical. Avoid hype and do not publish directly.",
        "- Save the final copy back to the Mission Control community pipeline item by completing this work item with output.copy.text or a result that contains the exact final copy.",
        "- Do not DM Gonza with the draft; the review surface is the Community pipeline card in Mission Control.",
      );
      break;
    case "tool":
      lines.push(
        "Task:",
        "- Draft a Spanish Tool of the Day-style post for the AIPaths Discord #ai-tools audience.",
        "- Explain what the tool does, who should try it, one practical use case, and one caveat or validation note.",
        "- Keep it useful and conversational, not sponsored-sounding. Do not publish directly.",
        "- Save the final copy back to the Mission Control community pipeline item by completing this work item with output.copy.text or a result that contains the exact final copy.",
        "- Do not DM Gonza with the draft; the review surface is the Community pipeline card in Mission Control.",
      );
      break;
    case "startup":
      lines.push(
        "Task:",
        "- Draft a Spanish Startup/Project of the Day-style post for the AIPaths Discord #presenta-tu-proyecto audience.",
        "- Explain what the startup/project is building, why it matters, who can learn from it, and one question to invite discussion.",
        "- Keep it founder/operator-oriented and practical. Avoid hype and do not publish directly.",
        "- Save the final copy back to the Mission Control community pipeline item by completing this work item with output.copy.text or a result that contains the exact final copy.",
        "- Do not DM Gonza with the draft; the review surface is the Community pipeline card in Mission Control.",
      );
      break;
  }

  lines.push(
    "- If the signal is weak, finish with a recommendation instead of forcing output.",
    "",
    `Requested by: ${params.reviewer}`
  );

  if (reviewNotes) {
    lines.push("", "Review notes:", reviewNotes);
  }

  return lines.join("\n");
}

async function findExistingDestinationPipelineItem(
  db: ReturnType<typeof createServiceClient>,
  enrichedId: number,
  destinationKey: IntelDestinationKey
) {
  const { data, error } = await db
    .from("pipeline_items")
    .select("id,title,pipeline_type,status,owner_agent,updated_at")
    .contains("metadata", {
      intel_source_type: "intel_inbox",
      intel_enriched_item_id: enrichedId,
      intel_destination_key: destinationKey,
    })
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return ((data || [])[0] || null) as
    | {
        id: string;
        title: string;
        pipeline_type: string;
        status: string;
        owner_agent: string | null;
        updated_at: string;
      }
    | null;
}

async function ensurePrimaryDestinationWorkItem(params: {
  db: ReturnType<typeof createServiceClient>;
  pipelineItemId: string;
  title: string;
  destination: IntelDestinationConfig;
  reviewer: string;
  summary: string;
  notes?: string | null;
}) {
  const isCommunityDestination = params.destination.director === "community";
  const relationType = isCommunityDestination ? "distribute_community" : "investigate";

  const { data: existingMap, error: existingMapError } = await params.db
    .from("pipeline_work_map")
    .select("work_item_id")
    .eq("pipeline_item_id", params.pipelineItemId)
    .eq("relation_type", relationType)
    .limit(1);

  if (existingMapError) throw existingMapError;
  if ((existingMap || []).length > 0) return;

  const result = await createPipelineWorkItem(params.db, {
    pipelineItemId: params.pipelineItemId,
    pipelineType: params.destination.pipelineType,
    title: `Develop ${params.destination.label.toLowerCase()}: ${params.title}`,
    instruction: buildDestinationInstruction({
      destination: params.destination,
      title: params.title,
      summary: params.summary,
      reviewer: params.reviewer,
      notes: params.notes,
    }),
    priority: "medium",
    ownerAgent: params.destination.director,
    requestedBy: params.reviewer,
    relationType,
    action: isCommunityDestination ? `draft_community_${params.destination.key}` : `develop_${params.destination.pipelineType}`,
    trigger: "intel_inbox_promote",
    reviewNotes: params.notes || undefined,
  });

  if (result.created) return;

  const { error: mapError } = await params.db.from("pipeline_work_map").insert({
    pipeline_item_id: params.pipelineItemId,
    work_item_id: result.workItem.id,
    relation_type: relationType,
  });
  if (mapError) throw mapError;

  const { error: eventError } = await params.db.from("pipeline_events").insert({
    pipeline_item_id: params.pipelineItemId,
    event_type: "pipeline_item.work_item_created",
    actor: "intel-inbox",
    payload: {
      work_item_id: result.workItem.id,
      relation_type: relationType,
      source_type: "pipeline_item",
      target_agent_id: params.destination.director,
      trigger: "intel_inbox_promote",
      action: isCommunityDestination ? `draft_community_${params.destination.key}` : `develop_${params.destination.pipelineType}`,
      repaired_missing_map: true,
    },
  });
  if (eventError) throw eventError;
}


function getCommunityDestinationTarget(destinationKey: IntelDestinationKey) {
  if (destinationKey === "tool") {
    return {
      kind: "tool_of_day",
      target: { channel_id: "1284277202073948181", channel_name: "🦿_ai_tools" },
    };
  }
  if (destinationKey === "startup") {
    return {
      kind: "startup_of_day",
      target: { channel_id: "1445800588561486007", channel_name: "📢_presenta_tu_proyecto" },
    };
  }
  if (destinationKey === "news") {
    return {
      kind: "news",
      target: { channel_id: "1498256983122378883", channel_name: "🛰️_radar_ia" },
    };
  }
  return null;
}

function isDuplicatePipelineItemError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  return code === "23505";
}

async function fetchTranscriptSummariesByRawItemId(
  db: ReturnType<typeof createServiceClient> | typeof supabaseAdmin,
  rawItemIds: number[]
) {
  const uniqueRawIds = Array.from(new Set(rawItemIds.filter(Number.isFinite)));
  if (!uniqueRawIds.length) return new Map<number, string>();

  const { data: rawRows, error: rawError } = await db
    .from("intel_items_raw")
    .select("id,external_id,raw_json")
    .in("id", uniqueRawIds);
  if (rawError) throw rawError;

  const videoByRawId = new Map<number, string>();
  for (const row of (rawRows || []) as Array<Record<string, unknown>>) {
    const rawId = Number(row.id);
    const rawJson = toObject(row.raw_json);
    const videoId = String(rawJson.videoId || row.external_id || "").trim();
    if (Number.isFinite(rawId) && videoId) videoByRawId.set(rawId, videoId);
  }

  const videoIds = Array.from(new Set(videoByRawId.values()));
  if (!videoIds.length) return new Map<number, string>();

  const { data: transcriptRows, error: transcriptError } = await db
    .from("competitor_transcripts")
    .select("video_id,summary_short,summary_status,summarized_at,updated_at")
    .in("video_id", videoIds)
    .eq("summary_status", "summarized");
  if (transcriptError) throw transcriptError;

  const summaryByVideo = new Map<string, Record<string, unknown>>();
  for (const row of (transcriptRows || []) as Array<Record<string, unknown>>) {
    const videoId = String(row.video_id || "");
    const summary = typeof row.summary_short === "string" ? row.summary_short.trim() : "";
    if (!videoId || !summary) continue;
    const current = summaryByVideo.get(videoId);
    const currentUpdated = String(current?.summarized_at || current?.updated_at || "");
    const nextUpdated = String(row.summarized_at || row.updated_at || "");
    if (!current || nextUpdated > currentUpdated) summaryByVideo.set(videoId, row);
  }

  const summaryByRawId = new Map<number, string>();
  for (const [rawId, videoId] of videoByRawId.entries()) {
    const summary = summaryByVideo.get(videoId)?.summary_short;
    if (typeof summary === "string" && summary.trim()) summaryByRawId.set(rawId, summary.trim());
  }
  return summaryByRawId;
}

async function fetchLatestRunIds(db: ReturnType<typeof createServiceClient> | typeof supabaseAdmin) {
  const { data, error } = await db
    .from("intel_items_enriched")
    .select("id,created_at,metadata_json")
    .order("created_at", { ascending: false })
    .limit(250);

  if (error) throw error;

  return inferLatestRunIds(
    ((data || []) as Array<Record<string, unknown>>)
      .map((row) => ({
        id: Number(row.id),
        createdAt: String(row.created_at || ""),
        metadata: toObject(row.metadata_json),
      }))
      .filter((row) => Number.isFinite(row.id))
  );
}

export async function getIntelInboxHealth(): Promise<IntelInboxHealth> {
  const db = supabaseAdmin;
  const recentCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: runs, error: runsError },
    { data: competitors, error: competitorsError },
    { data: sources, error: sourcesError },
    { count: rawRecent, error: rawRecentError },
    { count: enrichedRecent, error: enrichedRecentError },
    { data: enrichedMetaRows, error: enrichedMetaError },
    { data: transcriptRows, error: transcriptRowsError },
    { data: snapshotRows, error: snapshotRowsError },
  ] = await Promise.all([
    db
      .from("intel_runs")
      .select("id,status,started_at,finished_at,error_summary,metadata_json")
      .order("id", { ascending: false })
      .limit(20),
    db
      .from("competitor_channels")
      .select("id,name,enabled,channel_id"),
    db
      .from("intel_sources")
      .select("id,name,enabled,config_json")
      .eq("lane", "competitor"),
    db
      .from("intel_items_raw")
      .select("id", { count: "exact", head: true })
      .gte("first_seen_at", recentCutoff),
    db
      .from("intel_items_enriched")
      .select("id", { count: "exact", head: true })
      .gte("created_at", recentCutoff),
    db
      .from("intel_items_enriched")
      .select("id,lane,metadata_json,created_at")
      .gte("created_at", recentCutoff)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("competitor_transcripts")
      .select("id,fetch_status,summary_status"),
    db
      .from("competitor_video_snapshots")
      .select("id,competitor_channel_id,video_id,snapshot_at")
      .order("snapshot_at", { ascending: false })
      .limit(5000),
  ]);

  if (runsError) throw runsError;
  if (competitorsError) throw competitorsError;
  if (sourcesError) throw sourcesError;
  if (rawRecentError) throw rawRecentError;
  if (enrichedRecentError) throw enrichedRecentError;
  if (enrichedMetaError) throw enrichedMetaError;
  if (transcriptRowsError) throw transcriptRowsError;
  if (snapshotRowsError) throw snapshotRowsError;

  const latestCompetitorRun = ((runs || []) as Array<Record<string, unknown>>).find((run) => {
    const metadata = toObject(run.metadata_json);
    return metadata.lane === "competitor" || toObject(metadata.health_summary).competitor;
  });
  const enabledCompetitors = ((competitors || []) as Array<Record<string, unknown>>).filter((row) => row.enabled !== false);
  const unresolvedCompetitors = enabledCompetitors.filter((row) => !row.channel_id).length;
  const failingSources = ((sources || []) as Array<Record<string, unknown>>).filter((row) => {
    if (row.enabled === false) return false;
    const health = toObject(toObject(row.config_json).health);
    return health.quarantine === true || Number(health.consecutive_failures || 0) > 0;
  });
  const lastError = String(latestCompetitorRun?.error_summary || "").trim() || null;

  const enrichedMeta = ((enrichedMetaRows || []) as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    metadata: toObject(row.metadata_json),
  }));
  const redditWithDiscussion = enrichedMeta.filter((row) => toNumber(row.metadata.comments_used) > 0).length;
  const youtubeTranscriptSummaries = enrichedMeta.filter((row) => row.metadata.transcript_summary_used === true).length;

  const transcripts = (transcriptRows || []) as Array<Record<string, unknown>>;
  const transcriptsFetched = transcripts.filter((row) => row.fetch_status === "fetched").length;
  const transcriptsSummarized = transcripts.filter((row) => row.summary_status === "summarized").length;
  const transcriptsUnavailable = transcripts.filter((row) => row.fetch_status === "unavailable").length;
  const transcriptsFailed = transcripts.filter((row) => row.fetch_status === "failed" || row.summary_status === "failed").length;

  const snapshotGroups = new Map<string, number>();
  for (const row of (snapshotRows || []) as Array<Record<string, unknown>>) {
    const key = `${row.competitor_channel_id || "unknown"}:${row.video_id || ""}`;
    snapshotGroups.set(key, (snapshotGroups.get(key) || 0) + 1);
  }
  const duplicateCounts = Array.from(snapshotGroups.values()).filter((count) => count > 1);
  const duplicateSnapshotGroups = duplicateCounts.length;
  const duplicateSnapshotRows = duplicateCounts.reduce((acc, count) => acc + count - 1, 0);

  const visibleInbox = await listIntelInbox({ status: "all", includeOlderNew: true, limit: 1, offset: 0 }).then((result) => result.total).catch(() => 0);
  const status = unresolvedCompetitors > 0 || failingSources.length > 0 || lastError || transcriptsFailed > 0 || duplicateSnapshotRows > 0 ? "warn" : "ok";

  return {
    status,
    latestCompetitorRunAt: latestCompetitorRun ? String(latestCompetitorRun.finished_at || latestCompetitorRun.started_at || "") || null : null,
    latestCompetitorRunStatus: latestCompetitorRun ? String(latestCompetitorRun.status || "") || null : null,
    enabledCompetitors: enabledCompetitors.length,
    unresolvedCompetitors,
    failingSources: failingSources.length,
    lastError,
    pipeline: {
      rawRecent: rawRecent || 0,
      enrichedRecent: enrichedRecent || 0,
      visibleInbox,
      redditWithDiscussion,
      youtubeTranscriptSummaries,
      transcriptsFetched,
      transcriptsSummarized,
      transcriptsUnavailable,
      transcriptsFailed,
      duplicateSnapshotGroups,
      duplicateSnapshotRows,
    },
  };
}

export async function listIntelInbox(options?: {
  status?: IntelInboxStatus | "all";
  lane?: string | null;
  owner?: string | null;
  limit?: number;
  offset?: number;
  includeOlderNew?: boolean;
  freshDays?: number;
}) {
  const db = supabaseAdmin;
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  let query = db
    .from("intel_items_enriched")
    .select("id,raw_item_id,lane,summary_short,summary_display,why_it_matters,primary_topic,suggested_owner,suggested_destination,overall_score,promote_title,promote_type,promote_owner,promote_status_default,created_at,metadata_json")
    .order("created_at", { ascending: false })
    .order("overall_score", { ascending: false })
    .limit(250);

  if (options?.lane && options.lane !== "all") query = query.eq("lane", options.lane);
  if (options?.owner && options.owner !== "all") query = query.eq("promote_owner", options.owner);

  const { data: enrichedRows, error } = await query;
  if (error) throw error;

  const rows = (enrichedRows || []) as Array<Record<string, unknown>>;
  const latestRunIds = await fetchLatestRunIds(db);

  const enrichedIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);

  const { data: reviews, error: reviewsError } = enrichedIds.length
    ? await db
        .from("intel_inbox_reviews")
        .select("id,enriched_item_id,status,created_pipeline_item_id,updated_at")
        .in("enriched_item_id", enrichedIds)
    : { data: [], error: null };

  if (reviewsError) throw reviewsError;

  const rawIds = rows.map((row) => Number(row.raw_item_id)).filter(Number.isFinite);
  const { data: rawRows, error: rawRowsError } = rawIds.length
    ? await db
        .from("intel_items_raw")
        .select("id,lane,url,canonical_url,source_context,raw_json")
        .in("id", rawIds)
    : { data: [], error: null };

  if (rawRowsError) throw rawRowsError;

  const rawById = new Map<number, Record<string, unknown>>(
    ((rawRows || []) as Array<Record<string, unknown>>).map((row) => [Number(row.id), row])
  );

  const transcriptSummaryByRawId = await fetchTranscriptSummariesByRawItemId(
    db,
    rows
      .filter((row) => row.lane === "competitor")
      .map((row) => Number(row.raw_item_id))
  );

  const reviewByItem = new Map<number, Record<string, unknown>>();
  for (const review of (reviews || []) as Array<Record<string, unknown>>) {
    const enrichedItemId = Number(review.enriched_item_id);
    if (!Number.isFinite(enrichedItemId)) continue;
    const current = reviewByItem.get(enrichedItemId);
    if (!current) {
      reviewByItem.set(enrichedItemId, review);
      continue;
    }
    const currentUpdated = String(current.updated_at || current.created_at || "");
    const nextUpdated = String(review.updated_at || review.created_at || "");
    if (nextUpdated > currentUpdated) reviewByItem.set(enrichedItemId, review);
  }

  const freshCutoffMs = Date.now() - (options?.freshDays ?? 3) * 24 * 60 * 60 * 1000;

  const filteredItems: IntelInboxListItem[] = rows
    .map((row) => {
      const id = Number(row.id);
      const metadata = toObject(row.metadata_json);
      const review = reviewByItem.get(id);
      const title = String(row.promote_title || metadata.headline_short || row.summary_short || `Intel item ${id}`);
      const rawSource = rawById.get(Number(row.raw_item_id)) || null;
      const sourceKind = classifySourceKind({
        lane: rawSource?.lane || row.lane,
        url: rawSource?.url,
        canonicalUrl: rawSource?.canonical_url,
        sourceContext: rawSource?.source_context,
        rawJson: rawSource?.raw_json,
      });
      const sourceLabel = sourceLabelFromKind(sourceKind, hostnameFromUrl(rawSource?.canonical_url) || hostnameFromUrl(rawSource?.url));
      const transcriptSummary = transcriptSummaryByRawId.get(Number(row.raw_item_id)) || null;
      const headlineShort = typeof metadata.headline_short === "string" ? metadata.headline_short : null;
      const readyForInbox = isEditorialSummaryReady({
        title,
        summaryDisplay: row.summary_display,
        summaryShort: row.summary_short,
        whyItMatters: row.why_it_matters,
        headlineShort,
        transcriptSummary,
      });
      const summary =
        transcriptSummary ||
        (typeof row.summary_display === "string" && row.summary_display.trim()
          ? row.summary_display.trim()
          : buildReadableSummary({
              title,
              summaryShort: typeof row.summary_short === "string" ? row.summary_short : null,
              whyItMatters: typeof row.why_it_matters === "string" ? row.why_it_matters : null,
              rawTitle: null,
              rawContentText: null,
              transcriptSummary,
            }));

      return {
        id: String(id),
        enrichedItemId: id,
        title,
        summary,
        miniDescription: buildMiniDescription(summary),
        sourceKind,
        sourceLabel,
        discussionContext: getDiscussionContext({ sourceKind, metadata, rawJson: rawSource?.raw_json }),
        lane: typeof row.lane === "string" ? row.lane : null,
        primaryTopic: typeof row.primary_topic === "string" ? row.primary_topic : null,
        suggestedOwner: typeof row.suggested_owner === "string" ? row.suggested_owner : null,
        suggestedDestination: typeof row.suggested_destination === "string" ? row.suggested_destination : null,
        suggestedDestinations: getDestinationSuggestions({
          suggestedDestination: row.suggested_destination,
          promoteType: row.promote_type,
          metadata,
        }),
        promoteType: typeof row.promote_type === "string" ? row.promote_type : null,
        promoteOwner: typeof row.promote_owner === "string" ? row.promote_owner : null,
        promoteStatusDefault: typeof row.promote_status_default === "string" ? row.promote_status_default : null,
        overallScore: toNumber(row.overall_score),
        reviewStatus: normalizeStatus(review?.status),
        reviewId: review?.id ? String(review.id) : null,
        createdPipelineItemId: review?.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
        updatedAt: String(review?.updated_at || row.created_at || new Date().toISOString()),
        createdAt: String(row.created_at || new Date().toISOString()),
        isLatestRun: latestRunIds.has(id),
        readyForInbox,
      };
    })
    .filter((item) => item.readyForInbox)
    .filter((item) => (options?.status && options.status !== "all" ? item.reviewStatus === options.status : true))
    .filter((item) => {
      if (options?.includeOlderNew) return true;
      if ((options?.status || "new") !== "new") return true;
      if (item.reviewStatus !== "new") return true;
      const createdAtMs = new Date(item.createdAt).getTime();
      return Number.isFinite(createdAtMs) ? createdAtMs >= freshCutoffMs : true;
    })
    .sort((a, b) => {
      if (a.isLatestRun !== b.isLatestRun) return a.isLatestRun ? -1 : 1;
      if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return {
    items: filteredItems.slice(offset, offset + limit),
    total: filteredItems.length,
    limit,
    offset,
  };
}

export async function getIntelInboxDetail(id: string) {
  const enrichedId = Number(id);
  if (!Number.isFinite(enrichedId)) return null;

  const db = supabaseAdmin;
  const { data: enriched, error } = await db
    .from("intel_items_enriched")
    .select("*")
    .eq("id", enrichedId)
    .maybeSingle();

  if (error) throw error;
  if (!enriched) return null;

  const { data: reviewRows, error: reviewError } = await db
    .from("intel_inbox_reviews")
    .select("*")
    .eq("enriched_item_id", enrichedId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (reviewError) throw reviewError;

  const review = ((reviewRows || [])[0] || null) as Record<string, unknown> | null;

  const rawItemId = Number(enriched.raw_item_id);
  let rawSource: IntelInboxDetail["rawSource"] = null;
  if (Number.isFinite(rawItemId)) {
    const { data: raw, error: rawError } = await db
      .from("intel_items_raw")
      .select("id,title,url,canonical_url,source_context,author,lane,content_text,published_at,first_seen_at,engagement_score,engagement_count,raw_json,metadata_json")
      .eq("id", rawItemId)
      .maybeSingle();
    if (rawError) throw rawError;
    if (raw) {
      rawSource = {
        id: raw.id,
        title: raw.title || null,
        url: raw.url || null,
        canonicalUrl: raw.canonical_url || null,
        sourceContext: raw.source_context || null,
        author: raw.author || null,
        lane: raw.lane || null,
        contentText: raw.content_text || null,
        publishedAt: raw.published_at || null,
        firstSeenAt: raw.first_seen_at || null,
        engagementScore: toNumber(raw.engagement_score),
        engagementCount: typeof raw.engagement_count === "number" ? raw.engagement_count : null,
        rawJson: toObject(raw.raw_json),
        metadataJson: toObject(raw.metadata_json),
      };
    }
  }

  let pipelineItem: IntelInboxDetail["pipelineItem"] = null;
  if (review?.created_pipeline_item_id) {
    const { data: pipeline, error: pipelineError } = await db
      .from("pipeline_items")
      .select("id,title,pipeline_type,status,owner_agent,updated_at")
      .eq("id", String(review.created_pipeline_item_id))
      .maybeSingle();
    if (pipelineError) throw pipelineError;
    if (pipeline) {
      pipelineItem = {
        id: pipeline.id,
        title: pipeline.title,
        pipelineType: pipeline.pipeline_type,
        status: pipeline.status,
        ownerAgent: pipeline.owner_agent,
        updatedAt: pipeline.updated_at,
      };
    }
  }

  const metadata = toObject(enriched.metadata_json);
  const title = String(enriched.promote_title || metadata.headline_short || enriched.summary_short || `Intel item ${enriched.id}`);
  const transcriptSummary = Number.isFinite(rawItemId)
    ? (await fetchTranscriptSummariesByRawItemId(db, [rawItemId])).get(rawItemId) || null
    : null;
  const readableSummary =
    transcriptSummary ||
    (typeof enriched.summary_display === "string" && enriched.summary_display.trim()
      ? enriched.summary_display.trim()
      : buildReadableSummary({
          title,
          summaryShort: enriched.summary_short || null,
          whyItMatters: enriched.why_it_matters || null,
          rawTitle: rawSource?.title || null,
          rawContentText: rawSource?.contentText || null,
          transcriptSummary,
        }));

  const sourceKind = classifySourceKind({
    lane: rawSource?.lane || enriched.lane,
    url: rawSource?.url,
    canonicalUrl: rawSource?.canonicalUrl,
    sourceContext: rawSource?.sourceContext,
    rawJson: rawSource?.rawJson,
  });
  const sourceLabel = sourceLabelFromKind(sourceKind, hostnameFromUrl(rawSource?.canonicalUrl) || hostnameFromUrl(rawSource?.url));

  const parsedNotes = parseStoredReviewNotes(review?.notes);
  const reviewDestinations = parsedNotes.promotionMeta?.destinations.map((entry) => entry.key) || [];
  const fallbackReviewDestination = normalizeDestinationKey(review?.selected_pipeline_type);
  const selectedDestinations =
    reviewDestinations.length > 0
      ? reviewDestinations
      : fallbackReviewDestination
        ? [fallbackReviewDestination]
        : [];

  return {
    item: {
      id: String(enriched.id),
      enrichedItemId: enriched.id,
      title,
      summary: readableSummary,
      miniDescription: buildMiniDescription(readableSummary),
      sourceKind,
      sourceLabel,
      discussionContext: getDiscussionContext({ sourceKind, metadata, rawJson: rawSource?.rawJson }),
      lane: enriched.lane || null,
      primaryTopic: enriched.primary_topic || null,
      suggestedOwner: enriched.suggested_owner || null,
      suggestedDestination: enriched.suggested_destination || null,
      suggestedDestinations: getDestinationSuggestions({
        suggestedDestination: enriched.suggested_destination,
        promoteType: enriched.promote_type,
        metadata,
      }),
      promoteType: enriched.promote_type || null,
      promoteOwner: enriched.promote_owner || null,
      promoteStatusDefault: enriched.promote_status_default || null,
      overallScore: toNumber(enriched.overall_score),
      reviewStatus: normalizeStatus(review?.status),
      reviewId: review?.id ? String(review.id) : null,
      createdPipelineItemId: review?.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
      updatedAt: String(review?.updated_at || enriched.created_at || new Date().toISOString()),
      createdAt: String(enriched.created_at || new Date().toISOString()),
      isLatestRun: (await fetchLatestRunIds(db)).has(Number(enriched.id)),
      whyItMatters: enriched.why_it_matters || null,
      rawItemId: Number.isFinite(rawItemId) ? rawItemId : null,
      metadata,
      formatScores: {
        doc: toNumber(enriched.format_doc_score),
        video: toNumber(enriched.format_video_score),
        email_campaign: toNumber(enriched.format_email_campaign_score),
      },
      promoteCollaborators: Array.isArray(metadata.promote_collaborators)
        ? metadata.promote_collaborators.filter((value): value is string => typeof value === "string")
        : [],
    },
    rawSource,
    review: review
      ? {
          id: review.id ? String(review.id) : null,
          reviewer: typeof review.reviewer === "string" ? review.reviewer : null,
          status: normalizeStatus(review.status),
          selectedPipelineType: typeof review.selected_pipeline_type === "string" ? review.selected_pipeline_type : null,
          selectedOwnerAgent: typeof review.selected_owner_agent === "string" ? review.selected_owner_agent : null,
          selectedCollaborators: Array.isArray(review.selected_collaborators)
            ? review.selected_collaborators.filter((value): value is string => typeof value === "string")
            : [],
          selectedDestinations,
          decisionReasoning: typeof review.decision_reasoning === "string" ? review.decision_reasoning : null,
          notes: parsedNotes.userNotes,
          createdPipelineItemId: review.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
          reviewedAt: typeof review.reviewed_at === "string" ? review.reviewed_at : null,
          updatedAt: typeof review.updated_at === "string" ? review.updated_at : null,
        }
      : null,
    pipelineItem,
  } satisfies IntelInboxDetail;
}

export async function saveIntelInboxDecision(params: {
  enrichedItemId: string;
  reviewer: string;
  status: IntelInboxStatus;
  notes?: string | null;
}) {
  const db = createServiceClient();
  const enrichedId = Number(params.enrichedItemId);
  if (!Number.isFinite(enrichedId)) {
    const err = new Error("Invalid enriched item id");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const payload = {
    enriched_item_id: enrichedId,
    reviewer: params.reviewer,
    status: params.status,
    notes: trimToNull(params.notes || undefined),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("intel_inbox_reviews")
    .upsert(payload, { onConflict: "enriched_item_id,reviewer" })
    .select("id,status,created_pipeline_item_id")
    .single();

  if (error) throw error;
  return data;
}

export async function promoteIntelInboxItem(params: {
  enrichedItemId: string;
  reviewer: string;
  notes?: string | null;
  destinations?: string[];
  ownerAgent?: string | null;
  collaborators?: string[];
}) {
  const db = createServiceClient();
  const enrichedId = Number(params.enrichedItemId);
  if (!Number.isFinite(enrichedId)) {
    const err = new Error("Invalid enriched item id");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const { data: enriched, error: enrichedError } = await db
    .from("intel_items_enriched")
    .select("*")
    .eq("id", enrichedId)
    .maybeSingle();
  if (enrichedError) throw enrichedError;
  if (!enriched) {
    const err = new Error("Intel item not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  const metadata = toObject(enriched.metadata_json);
  const requestedDestinations = uniqueDestinationKeys(params.destinations || []);
  const destinationKeys: IntelDestinationKey[] =
    requestedDestinations.length > 0
      ? requestedDestinations
      : getLegacyFallbackDestinations({
          suggestedDestination: enriched.suggested_destination,
          promoteType: enriched.promote_type,
          metadata,
          ownerAgent: params.ownerAgent || null,
        });

  if (destinationKeys.length === 0) {
    const err = new Error("Select at least one valid destination");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const invalidDestinations = (params.destinations || []).filter((value) => !normalizeDestinationKey(value));
  if (invalidDestinations.length > 0) {
    const err = new Error(`Invalid destination: ${invalidDestinations[0]}`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const title = String(enriched.promote_title || metadata.headline_short || enriched.summary_short || `Intel item ${enriched.id}`);
  const summary =
    typeof enriched.summary_display === "string" && enriched.summary_display.trim()
      ? enriched.summary_display.trim()
      : buildReadableSummary({
          title,
          summaryShort: enriched.summary_short || null,
          whyItMatters: enriched.why_it_matters || null,
          rawTitle: null,
          rawContentText: null,
        });
  const sourceId = enriched.raw_item_id ? String(enriched.raw_item_id) : String(enriched.id);
  const metadataShell = toObject(metadata.promote_metadata_shell);
  const reviewNotes = trimToNull(params.notes || undefined);
  const collaborators = Array.from(new Set((params.collaborators || []).map((value) => value.trim()).filter(Boolean)));

  const promotedDestinations: Array<{
    key: IntelDestinationKey;
    label: string;
    director: IntelDestinationConfig["director"];
    pipelineItemId: string;
    pipelineType: IntelDestinationConfig["pipelineType"];
    created: boolean;
  }> = [];

  for (const destinationKey of destinationKeys) {
    const destination = INTEL_DESTINATION_CONFIG[destinationKey];
    let pipelineItem = await findExistingDestinationPipelineItem(db, enrichedId, destinationKey);
    let created = false;

    if (!pipelineItem) {
      const communityTarget = getCommunityDestinationTarget(destinationKey);
      const pipelineMetadata = {
        ...metadataShell,
        intel_source_type: "intel_inbox",
        intel_enriched_item_id: enriched.id,
        intel_raw_item_id: enriched.raw_item_id,
        intel_destination_key: destination.key,
        destination_label: destination.label,
        kind: communityTarget?.kind || destination.key,
        ...(communityTarget ? { target: communityTarget.target } : {}),
        collaborators,
        notify_agents: Array.from(new Set([destination.director, ...collaborators])),
        notes: reviewNotes,
      };

      const insertResult = await db
        .from("pipeline_items")
        .insert({
          title,
          pipeline_type: destination.pipelineType,
          status: enriched.promote_status_default || "draft",
          priority: "medium",
          owner_agent: destination.director,
          requested_by: params.reviewer,
          source_type: "manual",
          source_id: sourceId,
          metadata: pipelineMetadata,
          asset_role: "standalone",
          updated_at: new Date().toISOString(),
        })
        .select("id,title,pipeline_type,status,owner_agent,updated_at")
        .single();

      if (insertResult.error || !insertResult.data) {
        if (isDuplicatePipelineItemError(insertResult.error)) {
          pipelineItem = await findExistingDestinationPipelineItem(db, enrichedId, destinationKey);
        } else {
          throw insertResult.error || new Error(`Failed to create ${destination.label} pipeline item`);
        }
      } else {
        pipelineItem = insertResult.data;
        created = true;
      }
    }

    if (!pipelineItem) {
      throw new Error(`Failed to resolve ${destination.label} pipeline item`);
    }

    await ensurePrimaryDestinationWorkItem({
      db,
      pipelineItemId: pipelineItem.id,
      title,
      destination,
      reviewer: params.reviewer,
      summary,
      notes: reviewNotes,
    });

    promotedDestinations.push({
      key: destination.key,
      label: destination.label,
      director: destination.director,
      pipelineItemId: pipelineItem.id,
      pipelineType: destination.pipelineType,
      created,
    });
  }

  const primary = promotedDestinations[0] || null;
  const promotionMeta: StoredPromotionMeta = {
    version: 1,
    destinations: promotedDestinations.map((entry) => ({
      key: entry.key,
      label: entry.label,
      director: entry.director,
      pipelineItemId: entry.pipelineItemId,
      pipelineType: entry.pipelineType,
    })),
  };

  const { error: reviewError } = await db.from("intel_inbox_reviews").upsert(
    {
      enriched_item_id: enrichedId,
      reviewer: params.reviewer,
      status: "promoted",
      selected_pipeline_type: primary?.pipelineType || null,
      selected_owner_agent: primary?.director || null,
      selected_collaborators: collaborators,
      notes: serializeReviewNotes(reviewNotes, promotionMeta),
      created_pipeline_item_id: primary?.pipelineItemId || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "enriched_item_id,reviewer" }
  );
  if (reviewError) throw reviewError;

  return {
    id: String(enrichedId),
    status: "promoted" as const,
    primaryPipelineItemId: primary?.pipelineItemId || null,
    destinations: promotedDestinations.map((entry) => ({
      key: entry.key,
      label: entry.label,
      pipelineItemId: entry.pipelineItemId,
      created: entry.created,
    })),
  };
}
