import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";
import {
  EmailCampaignsClient,
  type AudienceSnapshot,
  type CampaignMetric,
  type CampaignMetricsRollup,
  type CampaignMetricsSummary,
  type EmailCampaignPageData,
  type EmailCampaignPipelineItem,
  type EmailCampaignWorkItem,
} from "@/components/email-campaigns/EmailCampaignsClient";

export const dynamic = "force-dynamic";

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();

  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }

    seen.add(row.id);
    return true;
  });
}

function createWebsiteSupabaseClient() {
  const url = process.env.WEBSITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Mission Control uses NEXT_PUBLIC_SUPABASE_URL. Only query website-only
  // tables when a distinct website Supabase URL is configured.
  if (!url || !key || url === process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return null;
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return Number.isNaN(Date.parse(value)) ? null : value;
}

function pickActivityAt(metric: Pick<CampaignMetric, "sent_at" | "created_at" | "scheduled_for">): string | null {
  return readDate(metric.sent_at) ?? readDate(metric.created_at) ?? readDate(metric.scheduled_for);
}

function toMonthKey(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

function isBeforeTimestamp(value: string | null, threshold: number): boolean {
  if (!value) {
    return false;
  }

  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed < threshold;
}

function createEmptyRollup(): CampaignMetricsRollup {
  return {
    campaignCount: 0,
    totalRecipients: 0,
    totalSent: 0,
    totalDelivered: 0,
    totalOpens: 0,
    totalClicks: 0,
    totalBounces: 0,
  };
}

function appendRollup(target: CampaignMetricsRollup, metric: CampaignMetric) {
  target.campaignCount += 1;
  target.totalRecipients += readNumber(metric.total_recipients) ?? readNumber(metric.recipient_row_count) ?? 0;
  target.totalSent += readNumber(metric.total_sent) ?? 0;
  target.totalDelivered += readNumber(metric.total_delivered) ?? 0;
  target.totalOpens += readNumber(metric.total_opens) ?? 0;
  target.totalClicks += readNumber(metric.total_clicks) ?? 0;
  target.totalBounces += readNumber(metric.total_bounces) ?? 0;
}

function summarizeCampaignMetrics(metrics: CampaignMetric[]): CampaignMetricsSummary {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const summary: CampaignMetricsSummary = {
    monthLabel: new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(
      new Date(currentMonthStart)
    ),
    realCampaigns: 0,
    testRows: 0,
    legacyIncompleteRows: 0,
    allTime: createEmptyRollup(),
    currentMonth: createEmptyRollup(),
  };

  for (const metric of metrics) {
    if (metric.is_legacy_incomplete) {
      summary.legacyIncompleteRows += 1;
    }

    if (!metric.is_real_campaign) {
      summary.testRows += 1;
      continue;
    }

    summary.realCampaigns += 1;
    appendRollup(summary.allTime, metric);

    if (metric.month_key === currentMonthKey) {
      appendRollup(summary.currentMonth, metric);
    }
  }

  return summary;
}

async function fetchWebsiteData(errors: string[]): Promise<{
  audienceSnapshot: AudienceSnapshot;
  campaignMetrics: CampaignMetric[];
  campaignMetricsSummary: CampaignMetricsSummary;
}> {
  const websiteSupabase = createWebsiteSupabaseClient();

  if (!websiteSupabase) {
    return {
      audienceSnapshot: {
        configured: false,
        topTags: [],
      },
      campaignMetrics: [],
      campaignMetricsSummary: {
        monthLabel: new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date()),
        realCampaigns: 0,
        testRows: 0,
        legacyIncompleteRows: 0,
        allTime: createEmptyRollup(),
        currentMonth: createEmptyRollup(),
      },
    };
  }

  const [
    activeContactsRes,
    waitlistedContactsRes,
    legacySubscribersRes,
    tagsRes,
    campaignsRes,
  ] = await Promise.all([
    websiteSupabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("subscribed_newsletter", true),
    websiteSupabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("waitlisted", true),
    websiteSupabase
      .from("newsletter_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("subscribed", true),
    websiteSupabase
      .from("contact_tags")
      .select("tag")
      .limit(5000),
    websiteSupabase
      .from("newsletter_campaigns")
      .select(
        "id,title_en,title_es,subject_en,subject_es,status,created_at,scheduled_for,sent_at,total_recipients,total_sent,total_delivered,total_opens,total_clicks,total_bounces,total_complaints"
      )
      .order("sent_at", { ascending: false, nullsFirst: false })
      .order("scheduled_for", { ascending: false, nullsFirst: false })
      .limit(75),
  ]);

  for (const [label, result] of [
    ["active newsletter contacts", activeContactsRes],
    ["waitlisted contacts", waitlistedContactsRes],
    ["legacy subscribers", legacySubscribersRes],
    ["contact tags", tagsRes],
    ["campaign metrics", campaignsRes],
  ] as const) {
    if (result.error) {
      console.error(`[EmailCampaignsPage] Failed to fetch ${label}:`, result.error);
      errors.push(`Website Supabase ${label} query failed: ${result.error.message}`);
    }
  }

  const tagCounts = new Map<string, number>();
  for (const row of tagsRes.data ?? []) {
    const tag = typeof row.tag === "string" ? row.tag : null;
    if (!tag) {
      continue;
    }
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const rawCampaigns = ((campaignsRes.data ?? []) as CampaignMetric[]).filter(Boolean);
  const campaignIds = rawCampaigns
    .map((metric) => metric.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const recipientCounts = new Map<
    string,
    { rowCount: number; deliveredCount: number; openedCount: number; clickedCount: number; bouncedCount: number }
  >();

  if (campaignIds.length > 0) {
    const recipientsRes = await websiteSupabase
      .from("newsletter_campaign_recipients")
      .select("campaign_id,status,opened,clicked")
      .in("campaign_id", campaignIds);

    if (recipientsRes.error) {
      console.error("[EmailCampaignsPage] Failed to fetch campaign recipients:", recipientsRes.error);
      errors.push(`Website Supabase campaign recipients query failed: ${recipientsRes.error.message}`);
    } else {
      for (const row of recipientsRes.data ?? []) {
        const campaignId = typeof row.campaign_id === "string" ? row.campaign_id : null;
        if (!campaignId) {
          continue;
        }

        const existing = recipientCounts.get(campaignId) ?? {
          rowCount: 0,
          deliveredCount: 0,
          openedCount: 0,
          clickedCount: 0,
          bouncedCount: 0,
        };

        const normalizedStatus = typeof row.status === "string" ? row.status.toLowerCase() : "";

        existing.rowCount += 1;
        if (["delivered", "opened", "clicked", "sent"].includes(normalizedStatus)) {
          existing.deliveredCount += 1;
        }
        if (normalizedStatus === "bounced") {
          existing.bouncedCount += 1;
        }
        if (row.opened === true) {
          existing.openedCount += 1;
        }
        if (row.clicked === true) {
          existing.clickedCount += 1;
        }

        recipientCounts.set(campaignId, existing);
      }
    }
  }

  const currentMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const campaignMetrics = rawCampaigns.map((metric) => {
    const recipientStats = recipientCounts.get(metric.id);
    const totalRecipients = readNumber(metric.total_recipients);
    const recipientRowCount = recipientStats?.rowCount ?? null;
    const activityAt = pickActivityAt(metric);
    const normalizedStatus = typeof metric.status === "string" ? metric.status.toLowerCase() : "";
    const isRealCampaign = (totalRecipients ?? 0) >= 10 || (recipientRowCount ?? 0) >= 10;

    return {
      ...metric,
      total_delivered: readNumber(metric.total_delivered) ?? recipientStats?.deliveredCount ?? null,
      total_opens: readNumber(metric.total_opens) ?? recipientStats?.openedCount ?? null,
      total_clicks: readNumber(metric.total_clicks) ?? recipientStats?.clickedCount ?? null,
      total_bounces: readNumber(metric.total_bounces) ?? recipientStats?.bouncedCount ?? null,
      recipient_row_count: recipientRowCount,
      is_real_campaign: isRealCampaign,
      is_test_row: !isRealCampaign,
      is_legacy_incomplete:
        normalizedStatus === "sending" &&
        (isBeforeTimestamp(readDate(metric.created_at), currentMonthStart) ||
          isBeforeTimestamp(readDate(metric.sent_at), currentMonthStart)),
      activity_at: activityAt,
      month_key: toMonthKey(activityAt),
    } satisfies CampaignMetric;
  });

  return {
    audienceSnapshot: {
      configured: true,
      activeNewsletterContacts: activeContactsRes.count ?? null,
      waitlistedContacts: waitlistedContactsRes.count ?? null,
      legacyActiveSubscribers: legacySubscribersRes.count ?? null,
      topTags: Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
        .slice(0, 10),
    },
    campaignMetrics,
    campaignMetricsSummary: summarizeCampaignMetrics(campaignMetrics),
  };
}

export default async function EmailCampaignsPage() {
  const errors: string[] = [];

  const { data: pipelineRows, error: pipelineError } = await supabaseAdmin
    .from("pipeline_items")
    .select("*")
    .eq("pipeline_type", "email_campaign");

  if (pipelineError) {
    console.error("[EmailCampaignsPage] Failed to fetch pipeline items:", pipelineError);
    errors.push(`Pipeline items query failed: ${pipelineError.message}`);
  }

  const pipelineItems = ((pipelineRows ?? []) as EmailCampaignPipelineItem[]).filter(Boolean);
  const pipelineIds = pipelineItems
    .map((item) => item.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const [workByPayloadRes, workBySourceRes] = await Promise.all([
    supabaseAdmin
      .from("work_items")
      .select("*")
      .eq("payload->>pipeline_type", "email_campaign"),
    pipelineIds.length > 0
      ? supabaseAdmin
        .from("work_items")
        .select("*")
        .in("source_id", pipelineIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (workByPayloadRes.error) {
    console.error("[EmailCampaignsPage] Failed to fetch work items by payload:", workByPayloadRes.error);
    errors.push(`Work items payload query failed: ${workByPayloadRes.error.message}`);
  }

  if (workBySourceRes.error) {
    console.error("[EmailCampaignsPage] Failed to fetch work items by source:", workBySourceRes.error);
    errors.push(`Work items source query failed: ${workBySourceRes.error.message}`);
  }

  const workItems = uniqueById(
    [
      ...((workByPayloadRes.data ?? []) as EmailCampaignWorkItem[]),
      ...((workBySourceRes.data ?? []) as EmailCampaignWorkItem[]),
    ].filter(Boolean)
  );

  const { audienceSnapshot, campaignMetrics, campaignMetricsSummary } = await fetchWebsiteData(errors);

  const data: EmailCampaignPageData = {
    pipelineItems,
    workItems,
    audienceSnapshot,
    campaignMetrics,
    campaignMetricsSummary,
    errors,
  };

  return <EmailCampaignsClient data={data} />;
}
