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
