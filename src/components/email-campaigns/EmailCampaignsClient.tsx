"use client";

import { useState } from "react";

type JsonObject = Record<string, unknown>;

export interface AudienceSnapshot {
  configured: boolean;
  activeNewsletterContacts?: number | null;
  waitlistedContacts?: number | null;
  legacyActiveSubscribers?: number | null;
  topTags: Array<{ tag: string; count: number }>;
}

export interface CampaignMetric {
  id: string;
  title_en?: string | null;
  title_es?: string | null;
  subject_en?: string | null;
  subject_es?: string | null;
  status?: string | null;
  created_at?: string | null;
  scheduled_for?: string | null;
  sent_at?: string | null;
  total_recipients?: number | null;
  total_sent?: number | null;
  total_delivered?: number | null;
  total_opens?: number | null;
  total_clicks?: number | null;
  total_bounces?: number | null;
  total_complaints?: number | null;
  recipient_row_count?: number | null;
  is_real_campaign?: boolean;
  is_test_row?: boolean;
  is_legacy_incomplete?: boolean;
  activity_at?: string | null;
  month_key?: string | null;
}

export interface CampaignMetricsRollup {
  campaignCount: number;
  totalRecipients: number;
  totalSent: number;
  totalDelivered: number;
  totalOpens: number;
  totalClicks: number;
  totalBounces: number;
}

export interface CampaignMetricsSummary {
  monthLabel: string;
  realCampaigns: number;
  testRows: number;
  legacyIncompleteRows: number;
  allTime: CampaignMetricsRollup;
  currentMonth: CampaignMetricsRollup;
}

export interface EmailCampaignPipelineItem {
  id: string;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  pipeline_type?: string | null;
  scheduled_for?: string | null;
  metadata?: JsonObject | null;
  payload?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface EmailCampaignWorkItem {
  id: string;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  action?: string | null;
  scheduled_for?: string | null;
  source_id?: string | null;
  payload?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface EmailCampaignPageData {
  pipelineItems: EmailCampaignPipelineItem[];
  workItems: EmailCampaignWorkItem[];
  audienceSnapshot: AudienceSnapshot;
  campaignMetrics: CampaignMetric[];
  campaignMetricsSummary: CampaignMetricsSummary;
  errors: string[];
}

type SectionKey =
  | "inbox"
  | "drafting"
  | "review"
  | "approved"
  | "scheduled"
  | "sent"
  | "expired";

interface CampaignCardData {
  item: EmailCampaignPipelineItem;
  linkedWorkItems: EmailCampaignWorkItem[];
  section: SectionKey;
  statusLabel: string;
  priorityLabel: string;
  formatLabel: string | null;
  weekKey: string | null;
  expiresAt: string | null;
  audienceKey: string | null;
  audienceLabel: string | null;
  audienceSummary: string | null;
  sectionSlots: string[];
  canonicalScheduledFor: string | null;
  campaignMetric: CampaignMetric | null;
  isExpiredCandidate: boolean;
  isCandidate: boolean;
  sortTimestamp: number;
}

const SECTION_META: Array<{ key: SectionKey; title: string; description: string }> = [
  {
    key: "inbox",
    title: "Inbox / Candidates",
    description: "Fresh candidate inputs and unsorted email ideas.",
  },
  {
    key: "drafting",
    title: "Drafting",
    description: "Campaigns being assembled or waiting on a development pass.",
  },
  {
    key: "review",
    title: "Ready for Review",
    description: "Drafts that look ready for Gonza review.",
  },
  {
    key: "approved",
    title: "Approved / Scheduling",
    description: "Approved campaigns that still need the actual send scheduled.",
  },
  {
    key: "scheduled",
    title: "Scheduled",
    description: "Canonical send time is derived from linked work items.",
  },
  {
    key: "sent",
    title: "Sent / Logs",
    description: "Pipeline-side send logs and historical work items. Newsletter delivery metrics live in the section above.",
  },
  {
    key: "expired",
    title: "Expired / Archived",
    description: "Old candidates and archived items are de-emphasized by default.",
  },
];

const STATUS_STYLES: Record<string, string> = {
  draft: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  drafting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  review: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  scheduled: "border-blue-500/30 bg-blue-500/10 text-blue-300",
  sent: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
  expired: "border-gray-700 bg-white/5 text-gray-400",
  default: "border-white/10 bg-white/5 text-gray-300",
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDate(value: unknown): string | null {
  const text = readString(value);

  if (!text) {
    return null;
  }

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : text;
}

function formatDateTime(value: string | null, includeTime = false): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString("en-GB", {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" } : {}),
  });
}

function formatRelativeBucket(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const now = Date.now();
  const diffDays = Math.round((parsed.getTime() - now) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "today";
  }

  if (diffDays === 1) {
    return "tomorrow";
  }

  if (diffDays === -1) {
    return "yesterday";
  }

  if (diffDays > 1) {
    return `in ${diffDays} days`;
  }

  return `${Math.abs(diffDays)} days ago`;
}

function normalizeLabel(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }

  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeFilters(value: unknown): string | null {
  const filters = asObject(value);
  if (!filters) {
    return null;
  }

  const parts = Object.entries(filters).flatMap(([key, raw]) => {
    if (raw == null || raw === "") {
      return [];
    }

    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        return [];
      }

      return [`${key}: ${raw.join(", ")}`];
    }

    if (typeof raw === "object") {
      const nested = Object.entries(raw as JsonObject)
        .filter(([, nestedValue]) => nestedValue != null && nestedValue !== "")
        .map(([nestedKey, nestedValue]) => `${nestedKey}=${String(nestedValue)}`);

      return nested.length > 0 ? [`${key}: ${nested.join(", ")}`] : [];
    }

    return [`${key}: ${String(raw)}`];
  });

  return parts.length > 0 ? parts.join(" • ") : null;
}

function getMetadata(item: EmailCampaignPipelineItem): JsonObject {
  return asObject(item.metadata) ?? {};
}

function getAudience(metadata: JsonObject): JsonObject | null {
  return asObject(metadata.audience) ?? asObject(metadata.suggested_audience);
}

function normalizeKey(value: string | null): string | null {
  return value
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? null;
}

function getSupabaseCampaignId(metadata: JsonObject): string | null {
  return (
    readString(metadata.newsletter_campaign_id) ??
    readString(metadata.campaign_id) ??
    readString(metadata.supabase_campaign_id)
  );
}

function metricForItem(item: EmailCampaignPipelineItem, metrics: CampaignMetric[]): CampaignMetric | null {
  const metadata = getMetadata(item);
  const campaignId = getSupabaseCampaignId(metadata);

  if (campaignId) {
    const exactMatch = metrics.find((metric) => metric.id === campaignId);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const titleKey = normalizeKey(readString(item.title));
  if (!titleKey) {
    return null;
  }

  return metrics.find((metric) => {
    const titleEs = normalizeKey(readString(metric.title_es));
    const titleEn = normalizeKey(readString(metric.title_en));
    return titleEs === titleKey || titleEn === titleKey;
  }) ?? null;
}

function getSectionSlots(metadata: JsonObject): string[] {
  return asArray(metadata.sections).flatMap((section) => {
    const sectionObject = asObject(section);
    if (!sectionObject) {
      return [];
    }

    const title = readString(sectionObject.title);
    const slot = readString(sectionObject.slot);
    return [title ?? slot].filter((value): value is string => Boolean(value)).map((value) => normalizeLabel(value, value));
  });
}

function looksLikeCandidate(metadata: JsonObject): boolean {
  if (readString(metadata.candidate_type)) {
    return true;
  }

  return getSectionSlots(metadata).length === 0;
}

function getLinkedPipelineId(workItem: EmailCampaignWorkItem): string | null {
  const directSource = readString(workItem.source_id);
  if (directSource) {
    return directSource;
  }

  const payload = asObject(workItem.payload);
  if (!payload) {
    return null;
  }

  return (
    readString(payload.source_id) ??
    readString(payload.pipeline_item_id) ??
    readString(payload.pipelineItemId) ??
    readString(payload.item_id)
  );
}

function getCanonicalScheduledFor(workItems: EmailCampaignWorkItem[]): string | null {
  const scheduled = workItems
    .map((workItem) => ({
      workItem,
      scheduledFor: readDate(workItem.scheduled_for),
      action: readString(workItem.action) ?? readString(asObject(workItem.payload)?.action),
    }))
    .filter(
      (entry): entry is { workItem: EmailCampaignWorkItem; scheduledFor: string; action: string | null } =>
        Boolean(entry.scheduledFor)
    )
    .sort((left, right) => {
      const leftAction = left.action ?? "";
      const rightAction = right.action ?? "";
      const leftPriority = /send|schedule/.test(leftAction) ? 0 : 1;
      const rightPriority = /send|schedule/.test(rightAction) ? 0 : 1;

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor);
    });

  return scheduled[0]?.scheduledFor ?? null;
}

function isPast(dateValue: string | null): boolean {
  if (!dateValue) {
    return false;
  }

  const timestamp = Date.parse(dateValue);
  return !Number.isNaN(timestamp) && timestamp < Date.now();
}

function pickSection(
  item: EmailCampaignPipelineItem,
  linkedWorkItems: EmailCampaignWorkItem[],
  canonicalScheduledFor: string | null,
  expiredCandidate: boolean,
  isCandidate: boolean
): SectionKey {
  const status = (readString(item.status) ?? "").toLowerCase();

  if (expiredCandidate || /expired|archived|archive|unused|cancelled|canceled/.test(status)) {
    return "expired";
  }

  if (/sent|sending|failed|complete|completed|done|log/.test(status)) {
    return "sent";
  }

  if (canonicalScheduledFor && !isPast(canonicalScheduledFor)) {
    return "scheduled";
  }

  const workSummary = linkedWorkItems
    .map((workItem) =>
      `${readString(workItem.action) ?? ""} ${readString(workItem.status) ?? ""}`.toLowerCase()
    )
    .join(" ");

  if (/ready.*review|pending.*review|for_review|review_ready/.test(status) || /review/.test(workSummary)) {
    return "review";
  }

  if (/approved|scheduling|needs.*schedule|ready.*schedule/.test(status) || /schedule/.test(workSummary)) {
    return "approved";
  }

  if (/draft|writing|develop|compose|in_progress|active/.test(status) || /develop/.test(workSummary)) {
    return "drafting";
  }

  if (/candidate|inbox|idea|new|backlog/.test(status) || isCandidate) {
    return "inbox";
  }

  return "drafting";
}

function getSortTimestamp(
  canonicalScheduledFor: string | null,
  expiresAt: string | null,
  item: EmailCampaignPipelineItem
): number {
  return (
    Date.parse(canonicalScheduledFor ?? "") ||
    Date.parse(expiresAt ?? "") ||
    Date.parse(readDate(item.updated_at) ?? "") ||
    Date.parse(readDate(item.created_at) ?? "") ||
    0
  );
}

function prepareCards(data: EmailCampaignPageData): CampaignCardData[] {
  const workItemsByPipelineId = new Map<string, EmailCampaignWorkItem[]>();

  for (const workItem of data.workItems) {
    const pipelineId = getLinkedPipelineId(workItem);
    if (!pipelineId) {
      continue;
    }

    const existing = workItemsByPipelineId.get(pipelineId) ?? [];
    existing.push(workItem);
    workItemsByPipelineId.set(pipelineId, existing);
  }

  return data.pipelineItems
    .map((item) => {
      const metadata = getMetadata(item);
      const audience = getAudience(metadata);
      const linkedWorkItems = workItemsByPipelineId.get(item.id) ?? [];
      const expiresAt = readDate(metadata.expires_at);
      const carryForward = readBoolean(metadata.carry_forward);
      const isCandidate = looksLikeCandidate(metadata);
      const isExpiredCandidate = isCandidate && isPast(expiresAt) && carryForward !== true;
      const canonicalScheduledFor = getCanonicalScheduledFor(linkedWorkItems);
      const section = pickSection(
        item,
        linkedWorkItems,
        canonicalScheduledFor,
        isExpiredCandidate,
        isCandidate
      );

      return {
        item,
        linkedWorkItems,
        section,
        statusLabel: normalizeLabel(readString(item.status), "Unknown"),
        priorityLabel: normalizeLabel(readString(item.priority), "Normal"),
        formatLabel: readString(metadata.format) ?? readString(metadata.candidate_type),
        weekKey: readString(metadata.week_key),
        expiresAt,
        audienceKey: readString(audience?.key),
        audienceLabel: readString(audience?.label),
        audienceSummary: summarizeFilters(audience?.filters),
        sectionSlots: getSectionSlots(metadata),
        canonicalScheduledFor,
        campaignMetric: metricForItem(item, data.campaignMetrics),
        isExpiredCandidate,
        isCandidate,
        sortTimestamp: getSortTimestamp(canonicalScheduledFor, expiresAt, item),
      };
    })
    .sort((left, right) => right.sortTimestamp - left.sortTimestamp || left.item.title?.localeCompare(right.item.title ?? "") || 0);
}

function statusStyleForCard(card: CampaignCardData): string {
  if (card.isExpiredCandidate || card.section === "expired") {
    return STATUS_STYLES.expired;
  }

  switch (card.section) {
    case "drafting":
      return STATUS_STYLES.drafting;
    case "review":
      return STATUS_STYLES.review;
    case "approved":
      return STATUS_STYLES.approved;
    case "scheduled":
      return STATUS_STYLES.scheduled;
    case "sent":
      return STATUS_STYLES.sent;
    default:
      return STATUS_STYLES.default;
  }
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-GB") : "—";
}

function formatRate(numerator: number | null | undefined, denominator: number | null | undefined): string {
  if (numerator == null || denominator == null || denominator <= 0) {
    return "—";
  }

  return `${Math.round((numerator / denominator) * 100)}%`;
}

function metricTitle(metric: CampaignMetric): string {
  return (
    readString(metric.title_es) ??
    readString(metric.title_en) ??
    readString(metric.subject_es) ??
    readString(metric.subject_en) ??
    "Untitled campaign"
  );
}

function metricSubject(metric: CampaignMetric): string | null {
  return readString(metric.subject_es) ?? readString(metric.subject_en);
}

function metricPrimaryAudience(metric: CampaignMetric): number | null {
  return readNumber(metric.total_recipients) ?? readNumber(metric.recipient_row_count);
}

function metricSendBase(metric: CampaignMetric): number | null {
  return readNumber(metric.total_sent) ?? metricPrimaryAudience(metric);
}

function metricDeliveredBase(metric: CampaignMetric): number | null {
  return readNumber(metric.total_delivered) ?? metricSendBase(metric);
}

function MetricStat({
  label,
  value,
  rate,
}: {
  label: string;
  value: number | null | undefined;
  rate: string;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{formatNumber(value)}</p>
      <p className="mt-1 text-xs text-gray-500">{rate === "—" ? "Rate unavailable" : rate}</p>
    </div>
  );
}

function RollupPanel({ title, rollup }: { title: string; rollup: CampaignMetricsRollup }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-[#0d0d13] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <p className="mt-1 text-sm text-gray-500">
            {rollup.campaignCount} real campaign{rollup.campaignCount === 1 ? "" : "s"}
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
          Recipients {formatNumber(rollup.totalRecipients)}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricStat
          label="Sent"
          value={rollup.totalSent}
          rate={formatRate(rollup.totalSent, rollup.totalRecipients)}
        />
        <MetricStat
          label="Delivered"
          value={rollup.totalDelivered}
          rate={formatRate(rollup.totalDelivered, rollup.totalSent || rollup.totalRecipients)}
        />
        <MetricStat
          label="Opens"
          value={rollup.totalOpens}
          rate={formatRate(rollup.totalOpens, rollup.totalDelivered || rollup.totalSent)}
        />
        <MetricStat
          label="Clicks"
          value={rollup.totalClicks}
          rate={formatRate(rollup.totalClicks, rollup.totalDelivered || rollup.totalSent)}
        />
        <MetricStat
          label="Bounces"
          value={rollup.totalBounces}
          rate={formatRate(rollup.totalBounces, rollup.totalSent || rollup.totalRecipients)}
        />
      </div>
    </div>
  );
}

function MetricCard({ metric, subdued = false }: { metric: CampaignMetric; subdued?: boolean }) {
  const subject = metricSubject(metric);
  const activityLabel = formatDateTime(readDate(metric.activity_at) ?? readDate(metric.sent_at) ?? readDate(metric.created_at), true);
  const deliveredBase = metricDeliveredBase(metric);
  const sendBase = metricSendBase(metric);

  return (
    <article
      className={`rounded-2xl border border-gray-800 bg-[#111118] p-5 ${
        subdued ? "opacity-60" : ""
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-white">{metricTitle(metric)}</h3>
            <span
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                metric.is_real_campaign
                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                  : "border-white/10 bg-white/5 text-gray-400"
              }`}
            >
              {metric.is_real_campaign ? "Real" : "Test / retry"}
            </span>
            {metric.is_legacy_incomplete && (
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-amber-200">
                Legacy / incomplete
              </span>
            )}
          </div>
          {subject && subject !== metricTitle(metric) && (
            <p className="mt-2 text-sm text-gray-400">{subject}</p>
          )}
        </div>

        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-300">
          {normalizeLabel(readString(metric.status), "Unknown")}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-400">
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Campaign ID {metric.id}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          Recipients {formatNumber(metricPrimaryAudience(metric))}
        </span>
        {readNumber(metric.recipient_row_count) != null && (
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
            Recipient rows {formatNumber(metric.recipient_row_count)}
          </span>
        )}
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
          {activityLabel ? `Activity ${activityLabel}` : "No activity timestamp"}
        </span>
      </div>

      {metric.is_legacy_incomplete && (
        <div className="mt-4 rounded-xl border border-amber-500/15 bg-amber-500/10 p-3 text-sm text-amber-100/85">
          Old `sending` row from before the current month. Treat this as stale legacy/incomplete history, not an active send.
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricStat
          label="Delivered"
          value={metric.total_delivered}
          rate={formatRate(metric.total_delivered, sendBase)}
        />
        <MetricStat
          label="Opens"
          value={metric.total_opens}
          rate={formatRate(metric.total_opens, deliveredBase)}
        />
        <MetricStat
          label="Clicks"
          value={metric.total_clicks}
          rate={formatRate(metric.total_clicks, deliveredBase)}
        />
        <MetricStat
          label="Bounces"
          value={metric.total_bounces}
          rate={formatRate(metric.total_bounces, sendBase)}
        />
      </div>
    </article>
  );
}

function SentMetricsSection({ data }: { data: EmailCampaignPageData }) {
  const realMetrics = data.campaignMetrics.filter((metric) => metric.is_real_campaign);
  const testMetrics = data.campaignMetrics.filter((metric) => !metric.is_real_campaign);

  return (
    <section className="mt-6 rounded-2xl border border-gray-800 bg-[#111118] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Sent / Metrics</h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            Read-only delivery history from website Supabase `newsletter_campaigns`. Real campaigns are separated from low-volume tests and retries, and monthly totals only count real rows.
          </p>
        </div>
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-emerald-300">
          Website Supabase source
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Real campaigns</p>
          <p className="mt-2 text-2xl font-semibold text-white">{data.campaignMetricsSummary.realCampaigns}</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{data.campaignMetricsSummary.monthLabel}</p>
          <p className="mt-2 text-2xl font-semibold text-white">{data.campaignMetricsSummary.currentMonth.campaignCount}</p>
          <p className="mt-1 text-sm text-gray-500">Real campaigns this month.</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Tests / retries</p>
          <p className="mt-2 text-2xl font-semibold text-white">{data.campaignMetricsSummary.testRows}</p>
          <p className="mt-1 text-sm text-gray-500">Low-volume rows de-emphasized below.</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Legacy / incomplete</p>
          <p className="mt-2 text-2xl font-semibold text-white">{data.campaignMetricsSummary.legacyIncompleteRows}</p>
          <p className="mt-1 text-sm text-gray-500">Old `sending` rows from before this month.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <RollupPanel title="Real campaigns · All time" rollup={data.campaignMetricsSummary.allTime} />
        <RollupPanel
          title={`Real campaigns · ${data.campaignMetricsSummary.monthLabel}`}
          rollup={data.campaignMetricsSummary.currentMonth}
        />
      </div>

      <div className="mt-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-white">Real campaign history</h3>
            <p className="mt-1 text-sm text-gray-500">
              Newsletter rows classified as real from recipient volume, with delivery and engagement metrics.
            </p>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-gray-400">
            {realMetrics.length} row{realMetrics.length === 1 ? "" : "s"}
          </span>
        </div>

        {realMetrics.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {realMetrics.map((metric) => (
              <MetricCard key={metric.id} metric={metric} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-[#0d0d13] px-5 py-8 text-sm text-gray-500">
            No real campaign rows found in `newsletter_campaigns`.
          </div>
        )}
      </div>

      {testMetrics.length > 0 && (
        <div className="mt-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-white">Tests / retries / low-volume rows</h3>
              <p className="mt-1 text-sm text-gray-500">
                De-emphasized history. These rows do not contribute to the summary totals above.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-gray-400">
              {testMetrics.length} row{testMetrics.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {testMetrics.map((metric) => (
              <MetricCard key={metric.id} metric={metric} subdued />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function workItemLabel(workItem: EmailCampaignWorkItem): string {
  const action =
    readString(workItem.action) ??
    readString(asObject(workItem.payload)?.action) ??
    readString(workItem.title);

  return normalizeLabel(action, "Work Item");
}

function ItemCard({ card }: { card: CampaignCardData }) {
  const metadata = getMetadata(card.item);
  const style = statusStyleForCard(card);
  const expiresLabel = formatDateTime(card.expiresAt);
  const scheduledLabel = formatDateTime(card.canonicalScheduledFor, true);
  const scheduledRelative = formatRelativeBucket(card.canonicalScheduledFor);
  const metric = card.campaignMetric;
  const metricSubjectLine = metric ? metricSubject(metric) : null;

  return (
    <article
      className={`rounded-2xl border bg-[#111118] p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition ${
        card.isExpiredCandidate ? "border-gray-800/80 opacity-60" : "border-gray-800"
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-white">
              {card.item.title ?? "Untitled email campaign"}
            </h3>
            {card.isCandidate && (
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-400">
                Candidate
              </span>
            )}
            {card.isExpiredCandidate && (
              <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-red-300">
                Expired
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className={`rounded-full border px-2.5 py-1 font-medium ${style}`}>
              {card.statusLabel}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-medium text-gray-300">
              Priority: {card.priorityLabel}
            </span>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-sm text-gray-300 sm:grid-cols-2">
        <div>
          <dt className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Format</dt>
          <dd className="mt-1 text-sm text-gray-200">
            {card.formatLabel ? normalizeLabel(card.formatLabel, card.formatLabel) : "Not set"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Week Key</dt>
          <dd className="mt-1 text-sm text-gray-200">{card.weekKey ?? "Not set"}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Expires At</dt>
          <dd className="mt-1 text-sm text-gray-200">
            {expiresLabel ?? "No expiry"}
            {card.isExpiredCandidate && expiresLabel ? " · expired" : ""}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Canonical Send Time</dt>
          <dd className="mt-1 text-sm text-gray-200">
            {scheduledLabel ?? "No linked schedule"}
            {scheduledLabel && scheduledRelative ? ` · ${scheduledRelative}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-4 rounded-xl border border-white/8 bg-[#0d0d13] p-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Audience</p>
        <p className="mt-2 text-sm font-medium text-white">
          {[card.audienceLabel, card.audienceKey].filter(Boolean).join(" · ") || "Not specified"}
        </p>
        <p className="mt-1 text-sm text-gray-400">
          {card.audienceSummary ?? "No audience filter summary available."}
        </p>
      </div>

      {metric && (
        <div className="mt-4 rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Supabase Campaign Metrics</p>
              <p className="mt-2 text-sm font-medium text-white">{metricTitle(metric)}</p>
              <p className="mt-1 text-xs text-gray-500">
                {metricSubjectLine && metricSubjectLine !== metricTitle(metric) ? `${metricSubjectLine} · ` : ""}Campaign ID: {metric.id}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-300">
                {normalizeLabel(readString(metric.status), "Unknown")}
              </span>
              <span
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  metric.is_real_campaign
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 bg-white/5 text-gray-400"
                }`}
              >
                {metric.is_real_campaign ? "Real" : "Test / retry"}
              </span>
              {metric.is_legacy_incomplete && (
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
                  Legacy / incomplete
                </span>
              )}
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricStat
              label="Delivered"
              value={metric.total_delivered}
              rate={formatRate(metric.total_delivered, metricSendBase(metric))}
            />
            <MetricStat
              label="Opens"
              value={metric.total_opens}
              rate={formatRate(metric.total_opens, metricDeliveredBase(metric))}
            />
            <MetricStat
              label="Clicks"
              value={metric.total_clicks}
              rate={formatRate(metric.total_clicks, metricDeliveredBase(metric))}
            />
            <MetricStat
              label="Bounces"
              value={metric.total_bounces}
              rate={formatRate(metric.total_bounces, metricSendBase(metric))}
            />
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Sections / Slots</p>
          {card.sectionSlots.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {card.sectionSlots.map((slot) => (
                <span
                  key={slot}
                  className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-300"
                >
                  {slot}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              {readString(metadata.summary) ?? "No section metadata on this item."}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Linked Work Items</p>
          {card.linkedWorkItems.length > 0 ? (
            <div className="mt-3 space-y-2">
              {card.linkedWorkItems
                .slice()
                .sort((left, right) => {
                  const leftTime = Date.parse(readDate(left.scheduled_for) ?? "") || 0;
                  const rightTime = Date.parse(readDate(right.scheduled_for) ?? "") || 0;
                  return rightTime - leftTime;
                })
                .map((workItem) => {
                  const scheduled = formatDateTime(readDate(workItem.scheduled_for), true);
                  return (
                    <div
                      key={workItem.id}
                      className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-gray-200">{workItemLabel(workItem)}</p>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-gray-400">
                          {normalizeLabel(readString(workItem.status), "Unknown")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {scheduled ? `Scheduled for ${scheduled}` : "No scheduled_for set"}
                      </p>
                    </div>
                  );
                })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-gray-500">No linked work items found.</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function EmailCampaignsClient({ data }: { data: EmailCampaignPageData }) {
  const [showArchived, setShowArchived] = useState(false);
  const cards = prepareCards(data);
  const counts = SECTION_META.reduce<Record<SectionKey, number>>((acc, section) => {
    acc[section.key] = cards.filter((card) => card.section === section.key).length;
    return acc;
  }, {
    inbox: 0,
    drafting: 0,
    review: 0,
    approved: 0,
    scheduled: 0,
    sent: 0,
    expired: 0,
  });

  const visibleSections = SECTION_META.filter((section) => showArchived || section.key !== "expired");

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-white">📧 Email Campaigns</h1>
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-emerald-300">
              Read-Only
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-gray-400">
            V2 planning surface for candidates, drafting, review, scheduling, and historical metrics. Send actions stay out of this UI.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowArchived((value) => !value)}
          className="rounded-xl border border-white/10 bg-[#111118] px-4 py-2 text-sm text-gray-300 transition hover:border-white/20 hover:text-white"
        >
          {showArchived ? "Hide archived" : `Show archived (${counts.expired})`}
        </button>
      </div>

      {data.errors.length > 0 && (
        <div className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
          <h2 className="text-sm font-semibold text-amber-200">Partial data</h2>
          <div className="mt-2 space-y-1 text-sm text-amber-100/80">
            {data.errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-gray-800 bg-[#111118] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Audience Snapshot</h2>
            <p className="mt-1 text-sm text-gray-500">
              Website Supabase read-only snapshot for sizing and segmentation context.
            </p>
          </div>
          {!data.audienceSnapshot.configured && (
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
              Website Supabase not configured
            </span>
          )}
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Active newsletter contacts</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {formatNumber(data.audienceSnapshot.activeNewsletterContacts)}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Waitlisted contacts</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {formatNumber(data.audienceSnapshot.waitlistedContacts)}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-[#0d0d13] p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Legacy active subscribers</p>
            <p className="mt-2 text-2xl font-semibold text-white">
              {formatNumber(data.audienceSnapshot.legacyActiveSubscribers)}
            </p>
          </div>
        </div>

        {data.audienceSnapshot.topTags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {data.audienceSnapshot.topTags.map(({ tag, count }) => (
              <span
                key={tag}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-300"
              >
                {tag} · {count}
              </span>
            ))}
          </div>
        )}
      </div>

      <SentMetricsSection data={data} />

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Candidates</p>
          <p className="mt-2 text-3xl font-semibold text-white">{counts.inbox}</p>
          <p className="mt-1 text-sm text-gray-500">Inbox items and reusable source material.</p>
        </div>
        <div className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Drafts & Review</p>
          <p className="mt-2 text-3xl font-semibold text-white">{counts.drafting + counts.review}</p>
          <p className="mt-1 text-sm text-gray-500">Campaigns actively being assembled or reviewed.</p>
        </div>
        <div className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Scheduled</p>
          <p className="mt-2 text-3xl font-semibold text-white">{counts.scheduled}</p>
          <p className="mt-1 text-sm text-gray-500">Upcoming sends from linked work item schedules.</p>
        </div>
        <div className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
          <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">Sent / Archived</p>
          <p className="mt-2 text-3xl font-semibold text-white">{counts.sent + counts.expired}</p>
          <p className="mt-1 text-sm text-gray-500">Pipeline send logs plus expired or archived campaign inputs.</p>
        </div>
      </div>

      <div className="mt-8 space-y-8">
        {visibleSections.map((section) => {
          const sectionCards = cards.filter((card) => card.section === section.key);

          return (
            <section key={section.key}>
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-white">{section.title}</h2>
                  <p className="mt-1 text-sm text-gray-500">{section.description}</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-gray-400">
                  {sectionCards.length} item{sectionCards.length === 1 ? "" : "s"}
                </span>
              </div>

              {sectionCards.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {sectionCards.map((card) => (
                    <ItemCard key={card.item.id} card={card} />
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-[#111118] px-5 py-8 text-sm text-gray-500">
                  No items in this section.
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
