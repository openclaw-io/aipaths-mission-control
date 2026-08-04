export const YOUTUBE_LAUNCH_STATES = [
  "prepared",
  "awaiting_approval",
  "scheduled",
  "live_verified",
  "publishing",
  "completed",
  "blocked",
  "failed",
] as const;

export type YouTubeLaunchState = (typeof YOUTUBE_LAUNCH_STATES)[number];

export type JsonRecord = Record<string, unknown>;

export type LaunchStatusWorkItem = {
  id: string;
  title?: string | null;
  status: string;
  owner_agent?: string | null;
  target_agent_id?: string | null;
  scheduled_for?: string | Date | null;
  started_at?: string | Date | null;
  completed_at?: string | Date | null;
  updated_at?: string | Date | null;
  source_id?: string | null;
  payload?: JsonRecord | null;
};

export type LaunchStatusPipelineItem = {
  id: string;
  title?: string | null;
  status: string;
  scheduled_for?: string | Date | null;
  published_at?: string | Date | null;
  current_url?: string | null;
  metadata?: JsonRecord | null;
};

export type LaunchArtifactStatus = {
  relationType: string;
  label: string;
  ownerAgent: string | null;
  targetTime: string | null;
  status: string;
  approval: "approved" | "pending" | "not_required" | "manual" | "blocked";
  attempts: number;
  evidence: string | null;
  remediation: string | null;
  workItemId: string | null;
};

export type LaunchStatusViewModel = {
  state: YouTubeLaunchState;
  label: string;
  blockers: string[];
  evidence: string | null;
  remediation: string | null;
  artifacts: LaunchArtifactStatus[];
};

export type AuthoritativeLaunchApproval = {
  status: string | null;
  approvedBy?: string | null;
  launchGeneration?: string | null;
  manualPublication?: boolean;
};

export type AuthoritativeLaunchApprovals = {
  community?: AuthoritativeLaunchApproval | null;
  marketing?: AuthoritativeLaunchApproval | null;
  pinnedComment?: AuthoritativeLaunchApproval | null;
};

export type PreflightValidationResult = {
  ok: boolean;
  status: "pass" | "blocked";
  checkedAt: string | null;
  blockers: string[];
  gates: JsonRecord;
  evidence: JsonRecord;
  remediation: string | null;
};

const TERMINAL_WORK_STATUSES = new Set(["done", "failed", "canceled", "cancelled"]);
const PUBLISHING_RELATIONS = new Set([
  "video_launch_activate",
  "website_publish_video",
  "publish_community_post",
  "send_email_campaign",
]);
const APPROVAL_REQUIRED_RELATIONS = new Set([
  "launch_community_draft",
  "marketing_email_campaign",
  "youtube_pinned_comment_draft",
  "publish_community_post",
  "send_email_campaign",
]);

const RELATION_LABELS: Record<string, string> = {
  youtube_launch_preflight: "T-30 preflight",
  video_launch_activate: "Live verification",
  launch_community_draft: "Community draft",
  community_approval_reminder: "Community approval reminder",
  youtube_pinned_comment_draft: "Pinned comment draft",
  pinned_comment_approval_reminder: "Pinned comment approval reminder",
  website_publish_video: "Website publish",
  marketing_email_campaign: "Email draft",
  marketing_approval_reminder: "Email approval reminder",
  send_email_campaign: "Email send",
  publish_community_post: "Community publish",
  youtube_snapshot_24h: "24h snapshot",
  youtube_snapshot_7d: "7d snapshot",
  youtube_snapshot_28d: "28d snapshot",
};

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBool(value: unknown) {
  return value === true || value === "true";
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numberFrom(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function valueAt(record: JsonRecord, path: string[]) {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonRecord)[key];
  }
  return current;
}

function firstString(records: JsonRecord[], paths: string[][]) {
  for (const record of records) {
    for (const path of paths) {
      const value = readString(valueAt(record, path));
      if (value) return value;
    }
  }
  return null;
}

export function extractYouTubeLaunchVideoId(value: string | null | undefined) {
  const raw = readString(value);
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || (host !== "youtube.com" && host !== "youtu.be" && !host.endsWith(".youtube.com"))) return null;
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || null;
  } catch {
    return null;
  }
  return null;
}

export function launchStateLabel(state: YouTubeLaunchState) {
  return state.replaceAll("_", " ");
}

export function getLaunchPackageFromItem(item: LaunchStatusPipelineItem | JsonRecord | null | undefined) {
  const metadata = toRecord((item as LaunchStatusPipelineItem | null | undefined)?.metadata ?? item);
  return toRecord(metadata.launch_package);
}

export function normalizeLaunchState(value: unknown): YouTubeLaunchState | null {
  return YOUTUBE_LAUNCH_STATES.includes(value as YouTubeLaunchState) ? (value as YouTubeLaunchState) : null;
}

function relationOf(workItem: LaunchStatusWorkItem) {
  const payload = toRecord(workItem.payload);
  return readString(payload.relation_type) || readString(payload.map_relation_type) || "work_item";
}

function evidenceSummaryFromPayload(payload: JsonRecord) {
  const output = toRecord(payload.output);
  const preflight = toRecord(output.preflight ?? payload.preflight);
  const liveCheck = toRecord(output.live_check ?? payload.live_check);
  const summary = readString(payload.evidence_summary)
    || readString(valueAt(preflight, ["evidence", "summary"]))
    || readString(valueAt(liveCheck, ["evidence", "summary"]))
    || readString(valueAt(output, ["summary"]))
    || readString(payload.result);
  return summary ? summary.slice(0, 260) : null;
}

function approvalStatus(workItem: LaunchStatusWorkItem) {
  const payload = toRecord(workItem.payload);
  const relationType = relationOf(workItem);
  if (!readBool(payload.requires_gonza_approval) && !APPROVAL_REQUIRED_RELATIONS.has(relationType)) return "not_required" as const;
  if (workItem.status === "blocked" || readString(payload.dispatch_state)?.includes("blocked")) return "blocked" as const;
  const authoritativeApproval = toRecord(payload.authoritative_approval);
  const authoritativeStatus = readString(authoritativeApproval.status);
  if (authoritativeStatus === "approved" || authoritativeStatus === "gonza_approved") return "approved" as const;
  if (["blocked", "rejected", "changes_requested"].includes(authoritativeStatus || "")) return "blocked" as const;
  const output = toRecord(payload.output);
  const review = toRecord(output.review);
  const approval = readString(payload.approval_status)
    || readString(valueAt(output, ["approval", "status"]))
    || readString(review.status);
  if (approval === "approved" || approval === "gonza_approved") return "approved" as const;
  if (TERMINAL_WORK_STATUSES.has(workItem.status) && !readBool(payload.requires_gonza_approval)) return "not_required" as const;
  return "pending" as const;
}

export function buildLaunchStatusViewModel(
  item: LaunchStatusPipelineItem,
  workItems: LaunchStatusWorkItem[],
): LaunchStatusViewModel {
  const metadata = toRecord(item.metadata);
  const launchPackage = toRecord(metadata.launch_package);
  const explicitState = normalizeLaunchState(launchPackage.launch_state);
  const launchPreflight = toRecord(launchPackage.preflight);
  const launchLiveCheck = toRecord(launchPackage.live_check);
  const relevantWorkItems = workItems
    .filter((workItem) => {
      const payload = toRecord(workItem.payload);
      return payload.trigger === "youtube_launch_package_v1"
        || payload.schedule_kind === "youtube_launch_package"
        || payload.source_video_pipeline_item_id === item.id
        || payload.pipeline_item_id === item.id
        || workItem.source_id === item.id;
    })
    .sort((a, b) => {
      const at = toIso(a.scheduled_for) || "";
      const bt = toIso(b.scheduled_for) || "";
      return at.localeCompare(bt) || relationOf(a).localeCompare(relationOf(b));
    });

  const artifacts = relevantWorkItems.map((workItem) => {
    const payload = toRecord(workItem.payload);
    const relationType = relationOf(workItem);
    return {
      relationType,
      label: RELATION_LABELS[relationType] || relationType.replaceAll("_", " "),
      ownerAgent: readString(workItem.owner_agent) || readString(workItem.target_agent_id),
      targetTime: toIso(workItem.scheduled_for),
      status: workItem.status,
      approval: approvalStatus(workItem),
      attempts: numberFrom(payload.wake_failure_count) + numberFrom(payload.manual_requeue_count) + numberFrom(payload.dispatch_attempts),
      evidence: evidenceSummaryFromPayload(payload),
      remediation: readString(payload.remediation) || readString(payload.dispatch_failure_reason) || readString(payload.dead_letter_reason),
      workItemId: workItem.id || null,
    };
  });

  const blockers = [
    ...artifacts
      .filter((artifact) => ["blocked", "failed"].includes(artifact.status))
      .map((artifact) => `${artifact.label}: ${artifact.remediation || artifact.status}`),
    ...(Array.isArray(launchPreflight.blockers) ? launchPreflight.blockers.map(String) : []),
  ];
  const allPublishingDone = artifacts
    .filter((artifact) => PUBLISHING_RELATIONS.has(artifact.relationType))
    .every((artifact) => artifact.status === "done");
  const anyPublishingActive = artifacts.some((artifact) => PUBLISHING_RELATIONS.has(artifact.relationType) && ["ready", "in_progress"].includes(artifact.status));
  const liveVerified = item.status === "published"
    || readBool(launchPackage.public_verified)
    || readString(launchPackage.status) === "activated"
    || Boolean(Object.keys(launchLiveCheck).length);

  let state: YouTubeLaunchState = explicitState || "prepared";
  if (blockers.length) state = artifacts.some((artifact) => artifact.status === "failed") ? "failed" : "blocked";
  else if (allPublishingDone && liveVerified) state = "completed";
  else if (anyPublishingActive && liveVerified) state = "publishing";
  else if (liveVerified) state = "live_verified";
  else if (artifacts.some((artifact) => artifact.relationType === "youtube_launch_preflight" && artifact.status === "done")
      || readString(launchPreflight.status) === "pass") state = "scheduled";
  else if (artifacts.some((artifact) => artifact.approval === "pending")) state = "awaiting_approval";

  return {
    state,
    label: launchStateLabel(state),
    blockers,
    evidence: readString(launchPreflight.evidence_summary)
      || readString(valueAt(launchPreflight, ["evidence", "summary"]))
      || readString(valueAt(launchLiveCheck, ["evidence", "summary"]))
      || null,
    remediation: readString(launchPackage.remediation) || readString(launchPreflight.remediation) || blockers[0] || null,
    artifacts,
  };
}

function authoritativeApprovalIsApproved(value: AuthoritativeLaunchApproval | null | undefined, launchGeneration: string | null) {
  const status = readString(value?.status);
  return Boolean(launchGeneration)
    && readString(value?.launchGeneration) === launchGeneration
    && (status === "approved" || status === "gonza_approved");
}

export function validateYouTubeLaunchPreflight(input: {
  item: LaunchStatusPipelineItem;
  preflight: unknown;
  authoritativeApprovals?: AuthoritativeLaunchApprovals | null;
  now?: string | Date | null;
}): PreflightValidationResult {
  const preflight = toRecord(input.preflight);
  const evidence = toRecord(preflight.evidence);
  const itemMetadata = toRecord(input.item.metadata);
  const launchPackage = toRecord(itemMetadata.launch_package);
  const youtubeV0 = toRecord(itemMetadata.youtube_v0);
  const expectedVideoId = readString(launchPackage.video_id) || readString(youtubeV0.video_id);
  const expectedUrl = readString(launchPackage.youtube_url) || readString(youtubeV0.youtube_url) || input.item.current_url || null;
  const expectedPlaylistId = readString(launchPackage.playlist_id) || readString(youtubeV0.playlist_id);
  const expectedPublishAt = readString(launchPackage.publish_at) || toIso(input.item.scheduled_for);
  const expectedLaunchGeneration = readString(launchPackage.launch_generation);
  const checkedAt = toIso(readString(preflight.checked_at) || readString(preflight.checkedAt));
  const validationNow = toIso(input.now instanceof Date ? input.now.toISOString() : input.now) || new Date().toISOString();
  const blockers: string[] = [];

  if (preflight.status !== "pass") blockers.push("preflight_status_not_pass");
  if (Array.isArray(preflight.blockers) && preflight.blockers.length) blockers.push(...preflight.blockers.map(String));
  if (!expectedVideoId || !/^[a-zA-Z0-9_-]{11}$/.test(expectedVideoId)) blockers.push("missing_expected_video_id");

  const evidenceVideoId = readString(evidence.video_id) || readString(evidence.videoId);
  const evidenceUrl = readString(evidence.youtube_url) || readString(evidence.canonical_url) || readString(evidence.url);
  if (expectedVideoId && evidenceVideoId !== expectedVideoId) blockers.push("canonical_video_identity_mismatch");
  if (expectedVideoId && evidenceUrl && extractYouTubeLaunchVideoId(evidenceUrl) !== expectedVideoId) blockers.push("canonical_video_url_mismatch");
  if (!evidenceUrl && expectedUrl && extractYouTubeLaunchVideoId(expectedUrl) !== expectedVideoId) blockers.push("canonical_video_url_missing");

  const scheduledVisibility = toRecord(evidence.scheduled_visibility);
  const privacyStatus = (readString(evidence.privacy_status) || readString(evidence.visibility) || "").toLowerCase();
  const scheduledPublishAt = toIso(
    readString(evidence.scheduled_publish_at)
      || readString(scheduledVisibility.publish_at)
      || readString(scheduledVisibility.scheduled_publish_at),
  );
  const visibilityOk = readBool(preflight.scheduled_visibility)
    || readBool(evidence.scheduled_visibility)
    || readBool(scheduledVisibility.confirmed)
    || ["scheduled", "private_scheduled"].includes(privacyStatus)
    || (privacyStatus === "private" && scheduledPublishAt === toIso(expectedPublishAt));
  if (!visibilityOk) blockers.push("scheduled_visibility_not_confirmed");

  const playlist = toRecord(evidence.playlist || evidence.playlist_membership);
  const playlistId = readString(playlist.playlist_id) || readString(playlist.playlistId);
  const playlistContains = readBool(playlist.contains_video)
    || readBool(playlist.membership_confirmed)
    || readBool(evidence.playlist_membership_confirmed);
  if (!expectedPlaylistId) blockers.push("missing_required_playlist_id");
  else if (playlistId !== expectedPlaylistId || !playlistContains) blockers.push("required_playlist_membership_missing");

  // Agent-reported approvals are evidence only. Gate decisions are derived from
  // the child pipeline cards read under the same DB transaction as completion.
  const authoritativeApprovals = input.authoritativeApprovals || {};
  const communityApproval = authoritativeApprovalIsApproved(authoritativeApprovals.community, expectedLaunchGeneration);
  const marketingApproval = authoritativeApprovalIsApproved(authoritativeApprovals.marketing, expectedLaunchGeneration);
  const pinnedApproval = authoritativeApprovalIsApproved(authoritativeApprovals.pinnedComment, expectedLaunchGeneration);
  if (!communityApproval) blockers.push("community_approval_missing");
  if (!marketingApproval) blockers.push("marketing_approval_missing");
  // Pinned-comment publication remains manual-only, but the draft still needs
  // an explicit authoritative Gonza approval; manual publication is not a waiver.
  if (!pinnedApproval) blockers.push("pinned_comment_approval_missing");

  const runtime = toRecord(preflight.runtime_health || evidence.runtime_health || evidence.runtime);
  const runtimeOk = readString(runtime.status) === "healthy"
    || (readBool(runtime.mission_control_ok) && readBool(runtime.scheduler_ok) && readBool(runtime.notify_ok));
  if (!runtimeOk) blockers.push("runtime_health_not_confirmed");

  if (!checkedAt) blockers.push("checked_at_missing_or_invalid");
  if (checkedAt && expectedPublishAt) {
    const checkedAtMs = new Date(checkedAt).getTime();
    const publishAtMs = new Date(expectedPublishAt).getTime();
    const nowMs = new Date(validationNow).getTime();
    const t30Ms = publishAtMs - 30 * 60 * 1000;
    if (nowMs < t30Ms - 60 * 1000) blockers.push("preflight_executed_before_t30_window");
    if (checkedAtMs > nowMs + 60 * 1000) blockers.push("preflight_checked_at_in_future");
    if (checkedAtMs < nowMs - 5 * 60 * 1000) blockers.push("preflight_checked_at_not_current");
    if (checkedAtMs < t30Ms - 60 * 1000 || checkedAtMs > publishAtMs + 10 * 60 * 1000) {
      blockers.push("preflight_outside_t30_window");
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const ok = uniqueBlockers.length === 0;
  const gates = {
    canonical_identity: { status: uniqueBlockers.some((b) => b.includes("canonical") || b === "missing_expected_video_id") ? "blocked" : "pass" },
    scheduled_visibility: { status: uniqueBlockers.includes("scheduled_visibility_not_confirmed") ? "blocked" : "pass" },
    playlist_membership: { status: uniqueBlockers.some((b) => b.includes("playlist")) ? "blocked" : "pass" },
    gonza_approvals: { status: uniqueBlockers.some((b) => b.includes("approval") || b.includes("manual_review")) ? "blocked" : "pass" },
    runtime_health: { status: uniqueBlockers.includes("runtime_health_not_confirmed") ? "blocked" : "pass" },
  };

  return {
    ok,
    status: ok ? "pass" : "blocked",
    checkedAt,
    blockers: uniqueBlockers,
    gates,
    evidence,
    remediation: ok ? null : "Resolve launch preflight blockers, then rerun the T-30 preflight and requeue blocked launch actions.",
  };
}

export function evaluateYouTubeLaunchActionReadiness(input: {
  item: LaunchStatusPipelineItem;
  workItem: LaunchStatusWorkItem;
  now?: string | Date | null;
}) {
  const payload = toRecord(input.workItem.payload);
  const itemMetadata = toRecord(input.item.metadata);
  const launchPackage = toRecord(itemMetadata.launch_package);
  const relationType = relationOf(input.workItem);
  const failures: string[] = [];
  const payloadGeneration = readString(payload.launch_generation);
  const parentGeneration = readString(launchPackage.launch_generation);
  const payloadPublishAt = readString(payload.publish_at);
  const parentPublishAt = readString(launchPackage.publish_at);
  const payloadSourceVideoPipelineItemId = readString(payload.source_video_pipeline_item_id);

  if (payload.launch_state_contract === "scheduled_launch_v2") {
    if (launchPackage.kind !== "scheduled_youtube_launch_package_v1") failures.push("scheduled_launch_parent_missing");
    if (!parentGeneration || payloadGeneration !== parentGeneration) failures.push("launch_generation_stale");
    if (!parentPublishAt || payloadPublishAt !== parentPublishAt) failures.push("launch_publish_time_stale");
    if (payloadSourceVideoPipelineItemId && payloadSourceVideoPipelineItemId !== input.item.id) {
      failures.push("launch_parent_identity_mismatch");
    }
  }

  if (readBool(payload.requires_preflight_passed)) {
    const preflight = toRecord(launchPackage.preflight);
    if (readString(preflight.status) !== "pass") failures.push("preflight_not_passed");
    if (!parentGeneration || readString(preflight.launch_generation) !== parentGeneration) {
      failures.push("preflight_generation_stale");
    }
    if (!parentPublishAt || readString(preflight.publish_at) !== parentPublishAt) {
      failures.push("preflight_publish_time_stale");
    }
  }
  if (readBool(payload.requires_live_check_passed) && relationType !== "video_launch_activate") {
    if (!readBool(launchPackage.public_verified) && readString(launchPackage.status) !== "activated") {
      failures.push("live_check_not_passed");
    }
  }
  if (readBool(payload.requires_gonza_approval) && !readBool(payload.approval_manual_out_of_scope)) {
    const status = readString(payload.approval_status)
      || firstString([toRecord(payload.output)], [["approval", "status"], ["review", "status"]]);
    if (status !== "approved" && status !== "gonza_approved") failures.push("gonza_approval_missing");
  }

  return {
    ok: failures.length === 0,
    failures,
    remediation: failures.length
      ? "Confirm the missing launch gates in Mission Control, rerun preflight if needed, then requeue the blocked work item."
      : null,
  };
}
