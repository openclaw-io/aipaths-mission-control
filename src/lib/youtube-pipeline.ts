export const YOUTUBE_GATE_ORDER = [
  "strategic_fit",
  "demand_validation",
  "supply_gap",
  "promise",
  "packaging",
  "retention_design",
  "conversion_fit",
  "film_ready",
  "postmortem",
] as const;

export const YOUTUBE_GATE_STATUSES = [
  "not_started",
  "in_progress",
  "pass",
  "rework",
  "kill",
  "experiment",
  "blocked",
] as const;

export type YouTubeGateKey = (typeof YOUTUBE_GATE_ORDER)[number];
export type YouTubeGateStatus = (typeof YOUTUBE_GATE_STATUSES)[number];
export type JsonRecord = Record<string, unknown>;

export type YouTubeScoreKey = "reach" | "retention" | "conversion" | "confidence" | "priority";

export type YouTubeScores = {
  reach: number;
  retention: number;
  conversion: number;
  confidence: number;
  priority: number;
};

export type YouTubeGateEntryHistory = {
  at: string;
  by: string;
  status: YouTubeGateStatus;
  reason: string | null;
  evidence_summary: string | null;
  next_action: string | null;
  score_snapshot: YouTubeScores;
};

export type YouTubeGateEntry = {
  status?: YouTubeGateStatus;
  reason?: string;
  evidence_summary?: string;
  next_action?: string;
  review_required?: unknown;
  human_review_requested?: unknown;
  decided_at?: string;
  decided_by?: string;
  updated_at?: string;
  work_item_id?: string;
  history?: YouTubeGateEntryHistory[];
};

export type YouTubePipelineMetadata = {
  concept?: string;
  pillar?: string;
  target_viewer?: string;
  decision_summary?: string;
  next_action?: string;
  review_required?: unknown;
  human_review_requested?: unknown;
  overview?: JsonRecord;
  scores?: Partial<Record<YouTubeScoreKey, number>>;
  gates?: Partial<Record<YouTubeGateKey, YouTubeGateEntry>>;
  evidence?: JsonRecord;
  packaging?: JsonRecord;
  retention?: JsonRecord;
  funnel?: JsonRecord;
  production?: JsonRecord;
  postmortem?: JsonRecord;
  promise?: JsonRecord;
  [key: string]: unknown;
};

export const YOUTUBE_GATE_META: Record<YouTubeGateKey, { label: string; shortLabel: string }> = {
  strategic_fit: { label: "Strategic Fit", shortLabel: "Strategic Fit" },
  demand_validation: { label: "Demand Validation", shortLabel: "Demand" },
  supply_gap: { label: "Supply Gap", shortLabel: "Supply Gap" },
  promise: { label: "Promise", shortLabel: "Promise" },
  packaging: { label: "Packaging", shortLabel: "Packaging" },
  retention_design: { label: "Retention Design", shortLabel: "Retention" },
  conversion_fit: { label: "Conversion Fit", shortLabel: "Conversion" },
  film_ready: { label: "Film Ready", shortLabel: "Film Ready" },
  postmortem: { label: "Post-mortem", shortLabel: "Post-mortem" },
};

const GATE_PROGRESS_STATUSES = new Set<YouTubeGateStatus>(["pass", "experiment"]);
const OPEN_YOUTUBE_WORK_STATUSES = new Set(["draft", "ready", "blocked", "in_progress"]);
const HUMAN_REVIEW_GATES = new Set<YouTubeGateKey>(["strategic_fit", "promise", "packaging", "film_ready", "postmortem"]);

export type YouTubeBoardBucketKey =
  | "needs_gonza"
  | "agent_working"
  | "agent_next"
  | "ready_to_record"
  | "learning_published"
  | "killed_archived";

export type YouTubeLinkedWorkItem = {
  id: string;
  source_id: string;
  status: string;
  title?: string | null;
  owner_agent?: string | null;
  target_agent_id?: string | null;
  created_at: string;
  payload?: JsonRecord | null;
};

export type YouTubeResponsibility = {
  bucket: YouTubeBoardBucketKey;
  currentGateKey: YouTubeGateKey;
  currentGateStatus: YouTubeGateStatus;
  reviewRequired: boolean;
  humanReviewRequested: boolean;
  openWorkItem: YouTubeLinkedWorkItem | null;
};

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(10, Math.max(0, numeric));
}

function roundScore(value: number) {
  return Math.round(value * 10) / 10;
}

export function getYouTubeMetadata(value: unknown): YouTubePipelineMetadata {
  return toRecord(value) as YouTubePipelineMetadata;
}

export function getGateEntry(metadata: YouTubePipelineMetadata, gateKey: YouTubeGateKey): YouTubeGateEntry {
  const gates = toRecord(metadata.gates);
  return toRecord(gates[gateKey]) as YouTubeGateEntry;
}

export function getGateStatus(metadata: YouTubePipelineMetadata, gateKey: YouTubeGateKey): YouTubeGateStatus {
  const status = getGateEntry(metadata, gateKey).status;
  return YOUTUBE_GATE_STATUSES.includes(status as YouTubeGateStatus) ? (status as YouTubeGateStatus) : "not_started";
}

export function isOpenYouTubeWorkItemStatus(status: string | null | undefined) {
  return typeof status === "string" && OPEN_YOUTUBE_WORK_STATUSES.has(status);
}

export function getScores(metadata: YouTubePipelineMetadata): YouTubeScores {
  const scores = toRecord(metadata.scores);
  const reach = toNumber(scores.reach);
  const retention = toNumber(scores.retention);
  const conversion = toNumber(scores.conversion);
  const confidence = toNumber(scores.confidence);
  const priority = roundScore(reach * 0.35 + retention * 0.25 + conversion * 0.25 + confidence * 0.15);
  return { reach, retention, conversion, confidence, priority };
}

export function priorityLevelFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 7.5) return "high";
  if (score >= 5) return "medium";
  return "low";
}

export function findTerminalKillGate(metadata: YouTubePipelineMetadata): YouTubeGateKey | null {
  for (const gateKey of YOUTUBE_GATE_ORDER) {
    if (getGateStatus(metadata, gateKey) === "kill") return gateKey;
  }
  return null;
}

export function havePriorGatesPassed(metadata: YouTubePipelineMetadata, gateKey: YouTubeGateKey) {
  const targetIndex = YOUTUBE_GATE_ORDER.indexOf(gateKey);
  if (targetIndex <= 0) return true;

  for (const priorGate of YOUTUBE_GATE_ORDER.slice(0, targetIndex)) {
    if (!GATE_PROGRESS_STATUSES.has(getGateStatus(metadata, priorGate))) {
      return false;
    }
  }

  return true;
}

export function getNextDecision(metadata: YouTubePipelineMetadata) {
  const killedAt = findTerminalKillGate(metadata);
  if (killedAt) {
    return {
      type: "killed" as const,
      gateKey: killedAt,
      label: `${YOUTUBE_GATE_META[killedAt].label} killed`,
      status: "kill" as YouTubeGateStatus,
    };
  }

  for (const gateKey of YOUTUBE_GATE_ORDER) {
    const status = getGateStatus(metadata, gateKey);
    if (!GATE_PROGRESS_STATUSES.has(status)) {
      return {
        type: "gate" as const,
        gateKey,
        label: YOUTUBE_GATE_META[gateKey].label,
        status,
      };
    }
  }

  return {
    type: "completed" as const,
    gateKey: YOUTUBE_GATE_ORDER[YOUTUBE_GATE_ORDER.length - 1],
    label: "Completed learning loop",
    status: "pass" as YouTubeGateStatus,
  };
}

export function derivePipelineItemStatus(metadata: YouTubePipelineMetadata, options?: { currentStatus?: string | null; publishedAt?: string | null }) {
  if (options?.currentStatus === "parked") return "parked";

  const nextDecision = getNextDecision(metadata);
  if (nextDecision.type === "killed") return "rejected";
  if (nextDecision.type === "completed") return options?.publishedAt ? "archived" : "ready_to_record";

  if (nextDecision.gateKey === "film_ready") {
    const filmStatus = getGateStatus(metadata, "film_ready");
    if (filmStatus === "pass" || filmStatus === "experiment") {
      return options?.publishedAt ? "published" : "ready_to_record";
    }
    return "preparing_production";
  }

  if (nextDecision.gateKey === "postmortem") {
    return options?.publishedAt ? "published" : "ready_to_record";
  }

  if (nextDecision.status === "rework") return "changes_requested";
  if (nextDecision.status === "not_started") return "draft";
  return "researching";
}

export function getTopLevelNextAction(metadata: YouTubePipelineMetadata) {
  const nextDecision = getNextDecision(metadata);
  if (nextDecision.type === "killed") {
    return getGateEntry(metadata, nextDecision.gateKey).reason || "Archive or replace this idea.";
  }
  if (nextDecision.type === "completed") {
    return metadata.next_action || "Review post-mortem and carry the learning forward.";
  }

  const gateEntry = getGateEntry(metadata, nextDecision.gateKey);
  return gateEntry.next_action || metadata.next_action || `Decide ${YOUTUBE_GATE_META[nextDecision.gateKey].label.toLowerCase()}.`;
}

function reviewFlagApplies(value: unknown, gateKey: YouTubeGateKey): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value === gateKey || value === "all";
  if (Array.isArray(value)) return value.some((entry) => reviewFlagApplies(entry, gateKey));
  if (value && typeof value === "object") {
    const record = toRecord(value);
    return Boolean(record.all || record[gateKey]);
  }
  return false;
}

export function hasExplicitHumanReviewRequest(metadata: YouTubePipelineMetadata, gateKey: YouTubeGateKey) {
  const gate = getGateEntry(metadata, gateKey);
  return reviewFlagApplies(metadata.review_required, gateKey)
    || reviewFlagApplies(metadata.human_review_requested, gateKey)
    || reviewFlagApplies(gate.review_required, gateKey)
    || reviewFlagApplies(gate.human_review_requested, gateKey);
}

export function gateNeedsHumanReview(metadata: YouTubePipelineMetadata, gateKey: YouTubeGateKey) {
  return HUMAN_REVIEW_GATES.has(gateKey) || hasExplicitHumanReviewRequest(metadata, gateKey);
}

export function getPrimaryGateWorkItem(
  itemId: string,
  gateKey: YouTubeGateKey,
  workItems: YouTubeLinkedWorkItem[],
  options?: { openOnly?: boolean },
) {
  const candidates = workItems.filter((workItem) => {
    const payload = toRecord(workItem.payload);
    const linked = workItem.source_id === itemId || payload.pipeline_item_id === itemId;
    const relationType = payload.relation_type;
    if (!linked) return false;
    if (options?.openOnly && !isOpenYouTubeWorkItemStatus(workItem.status)) return false;
    return relationType === gateKey || relationType === "investigate";
  });

  return [...candidates].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] || null;
}

export function getHumanDecisionLabel(gateKey: YouTubeGateKey) {
  switch (gateKey) {
    case "strategic_fit":
      return "Approve or reject the strategic bet.";
    case "promise":
      return "Approve the promised viewer outcome.";
    case "packaging":
      return "Approve the title, thumbnail, and hook direction.";
    case "film_ready":
      return "Approve the plan for recording.";
    case "postmortem":
      return "Review the postmortem and decide what to keep learning from.";
    default:
      return `Review ${YOUTUBE_GATE_META[gateKey].label.toLowerCase()}.`;
  }
}

export function getHumanReviewReason(gateKey: YouTubeGateKey, hasExplicitRequest = false) {
  if (hasExplicitRequest) return "Human review was explicitly requested on this gate.";

  switch (gateKey) {
    case "strategic_fit":
      return "This is a portfolio-level call on whether the idea deserves more investment.";
    case "promise":
      return "The core promise affects positioning and must be signed off by a human.";
    case "packaging":
      return "Packaging is a human quality bar for click-worthiness and brand fit.";
    case "film_ready":
      return "Recording should only start after a human confirms the plan is strong enough.";
    case "postmortem":
      return "Learning needs a human judgement about what changes the playbook.";
    default:
      return "This item needs a human call before the pipeline should advance.";
  }
}

export function getAgentDeliverableLabel(gateKey: YouTubeGateKey) {
  switch (gateKey) {
    case "strategic_fit":
      return "Strategic brief with recommendation";
    case "demand_validation":
      return "Demand evidence and search signals";
    case "supply_gap":
      return "Competitive gap analysis";
    case "promise":
      return "Promise options with proof";
    case "packaging":
      return "Title, thumbnail, and hook options";
    case "retention_design":
      return "Retention plan and structure";
    case "conversion_fit":
      return "Offer/funnel fit notes";
    case "film_ready":
      return "Production brief and filming checklist";
    case "postmortem":
      return "Performance readout and learning memo";
  }
}

export function deriveYouTubeResponsibility(input: {
  status: string | null | undefined;
  metadata: YouTubePipelineMetadata;
  publishedAt?: string | null;
  workItems: YouTubeLinkedWorkItem[];
  itemId: string;
}): YouTubeResponsibility {
  const nextDecision = getNextDecision(input.metadata);
  const currentGateKey = nextDecision.gateKey;
  const currentGateStatus = getGateStatus(input.metadata, currentGateKey);
  const openWorkItem = getPrimaryGateWorkItem(input.itemId, currentGateKey, input.workItems, { openOnly: true });
  const humanReviewRequested = hasExplicitHumanReviewRequest(input.metadata, currentGateKey);
  const reviewRequired = gateNeedsHumanReview(input.metadata, currentGateKey);

  if (input.status === "archived" || input.status === "rejected" || nextDecision.type === "killed") {
    return {
      bucket: "killed_archived",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  if (input.status === "published" || (nextDecision.gateKey === "postmortem" && havePriorGatesPassed(input.metadata, "postmortem"))) {
    return {
      bucket: "learning_published",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  if (nextDecision.type === "completed" || (nextDecision.gateKey === "film_ready" && havePriorGatesPassed(input.metadata, "film_ready"))) {
    return {
      bucket: "ready_to_record",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  if (openWorkItem) {
    return {
      bucket: "agent_working",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  if (currentGateStatus === "in_progress" || currentGateStatus === "blocked") {
    return {
      bucket: "agent_next",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  if (currentGateStatus === "rework") {
    return {
      bucket: reviewRequired && humanReviewRequested ? "needs_gonza" : "agent_next",
      currentGateKey,
      currentGateStatus,
      reviewRequired,
      humanReviewRequested,
      openWorkItem,
    };
  }

  return {
    bucket: reviewRequired ? "needs_gonza" : "agent_next",
    currentGateKey,
    currentGateStatus,
    reviewRequired,
    humanReviewRequested,
    openWorkItem,
  };
}

export function buildGateHistoryEntry(input: {
  at: string;
  by: string;
  status: YouTubeGateStatus;
  reason?: string | null;
  evidenceSummary?: string | null;
  nextAction?: string | null;
  scores: YouTubeScores;
}): YouTubeGateEntryHistory {
  return {
    at: input.at,
    by: input.by,
    status: input.status,
    reason: input.reason || null,
    evidence_summary: input.evidenceSummary || null,
    next_action: input.nextAction || null,
    score_snapshot: input.scores,
  };
}
