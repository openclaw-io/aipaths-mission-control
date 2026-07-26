import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";
import {
  EmailCampaignsClient,
  type AudienceSnapshot,
  type CampaignMetric,
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

async function fetchWebsiteData(errors: string[]): Promise<{
  audienceSnapshot: AudienceSnapshot;
  campaignMetrics: CampaignMetric[];
}> {
  const websiteSupabase = createWebsiteSupabaseClient();

  if (!websiteSupabase) {
    return {
      audienceSnapshot: {
        configured: false,
        topTags: [],
      },
      campaignMetrics: [],
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
        "id,title_en,title_es,subject_en,subject_es,status,scheduled_for,sent_at,total_recipients,total_sent,total_delivered,total_opens,total_clicks,total_bounces,total_complaints"
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
    campaignMetrics: ((campaignsRes.data ?? []) as CampaignMetric[]).filter(Boolean),
  };
}

export default async function EmailCampaignsPage() {
  const errors: string[] = [];
  const useLocalMode = isLocalAuthDisabled();

  const pipelineResult = useLocalMode
    ? await query<Record<string, unknown>>(`select * from pipeline_items where pipeline_type = 'email_campaign' order by created_at desc`)
    : await supabaseAdmin
      .from("pipeline_items")
      .select("*")
      .eq("pipeline_type", "email_campaign");

  const pipelineItems = normalizeRows((((pipelineResult as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }).rows) ?? ((pipelineResult as { data?: Record<string, unknown>[] }).data) ?? [])).filter(Boolean) as EmailCampaignPipelineItem[];
  const pipelineIds = pipelineItems
    .map((item) => item.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const [workByPayloadRes, workBySourceRes] = useLocalMode
    ? await Promise.all([
        query<Record<string, unknown>>(`select * from work_items where payload ->> 'pipeline_type' = 'email_campaign' order by created_at desc`),
        pipelineIds.length > 0
          ? query<Record<string, unknown>>(`select * from work_items where source_id = any($1::text[]) order by created_at desc`, [pipelineIds])
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      ])
    : await Promise.all([
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

  const workItems = uniqueById(
    [
      ...(normalizeRows((((workByPayloadRes as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }).rows) ?? ((workByPayloadRes as { data?: Record<string, unknown>[] }).data) ?? [])) as EmailCampaignWorkItem[]),
      ...(normalizeRows((((workBySourceRes as { rows?: Record<string, unknown>[]; data?: Record<string, unknown>[] }).rows) ?? ((workBySourceRes as { data?: Record<string, unknown>[] }).data) ?? [])) as EmailCampaignWorkItem[]),
    ].filter(Boolean)
  );

  const { audienceSnapshot, campaignMetrics } = await fetchWebsiteData(errors);

  const data: EmailCampaignPageData = {
    pipelineItems,
    workItems,
    audienceSnapshot,
    campaignMetrics,
    errors,
  };

  return <EmailCampaignsClient data={data} />;
}
