import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRow, normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { createPipelineWorkItemLocal } from "@/lib/db/pipeline-local";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createNewsletterInstruction(input: {
  title: string;
  topics: Array<{ title: string; summary: string | null; sourceUrl: string | null }>;
}) {
  return [
    `Email campaign pipeline item: ${input.title}`,
    "",
    "Task:",
    "- Create a Spanish Thursday newsletter draft for AIPaths using the selected topics below.",
    "- Keep it useful for Spanish-speaking founders/operators: practical angle, clear why-it-matters, no hype.",
    "- Pick the strongest 2–3 sections, connect them with a concise editorial thread, and include one CTA to AIPaths when natural.",
    "- Do not send or schedule the email.",
    "- Complete this work item with output.email_draft containing: subject, preview_text, body_markdown.",
    "- Mission Control will move the email card to ready_for_review after completion.",
    "",
    "Selected topics:",
    ...input.topics.map((topic, index) => [
      `${index + 1}. ${topic.title}`,
      topic.summary ? `   Summary: ${topic.summary}` : null,
      topic.sourceUrl ? `   Source: ${topic.sourceUrl}` : null,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

type NewsletterTopicRow = {
  id: string;
  title: string | null;
  status: string;
  priority: string | null;
  metadata: JsonRecord | null;
  source_id: string | null;
  current_url: string | null;
  created_at: string;
  updated_at: string;
};

async function assembleNewsletterLocal(topicIds: string[], requestedBy: string) {
  const { rows } = await query<NewsletterTopicRow>(
    `select id, title, status, priority, metadata, source_id, current_url, created_at, updated_at
       from public.pipeline_items
      where pipeline_type = 'email_campaign'
        and id = any($1::uuid[])`,
    [topicIds],
  );
  const topics = normalizeRows(rows);
  if (topics.length !== topicIds.length) {
    return NextResponse.json({ error: "No se encontraron todos los temas seleccionados" }, { status: 404 });
  }

  const invalid = topics.find((topic) => {
    const metadata = asObject(topic.metadata);
    return metadata.intel_source_type !== "intel_inbox" || metadata.intel_destination_key !== "email";
  });
  if (invalid) {
    return NextResponse.json({ error: `El item no es un tema de Email: ${invalid.title || invalid.id}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const weekKey = now.slice(0, 10);
  const topicPayload = topics.map((topic) => {
    const metadata = asObject(topic.metadata);
    const source = asObject(metadata.source);
    return {
      id: topic.id,
      title: topic.title || "Tema sin título",
      summary: readString(metadata.summary) || readString(metadata.why_it_matters) || readString(metadata.notes),
      source_url: readString(metadata.source_url) || readString(source.url) || readString(topic.current_url),
    };
  });

  const newsletterTitle = `Newsletter jueves — ${weekKey}`;
  const newsletterResult = await query(
    `insert into public.pipeline_items (
       title, pipeline_type, status, priority, owner_agent, requested_by,
       source_type, source_id, metadata, asset_role, updated_at
     ) values ($1, 'email_campaign', 'drafting', 'medium', 'marketing', $2,
       'manual', $3, $4::jsonb, 'standalone', $5::timestamptz)
     returning id, title, status`,
    [
      newsletterTitle,
      requestedBy,
      `email-newsletter-${weekKey}`,
      JSON.stringify({
        kind: "weekly_newsletter",
        week_key: weekKey,
        created_from: "email_campaigns_tab",
        topics: topicPayload,
        source_topic_ids: topicIds,
        requested_at: now,
        requested_by: requestedBy,
      }),
      now,
    ],
  );
  const newsletter = normalizeRow(newsletterResult.rows[0]);

  const { workItem } = await createPipelineWorkItemLocal({
    pipelineItemId: String(newsletter.id),
    pipelineType: "email_campaign",
    title: `Draft newsletter: ${newsletterTitle}`,
    instruction: createNewsletterInstruction({
      title: newsletterTitle,
      topics: topicPayload.map((topic) => ({
        title: topic.title,
        summary: topic.summary,
        sourceUrl: topic.source_url,
      })),
    }),
    priority: "medium",
    ownerAgent: "marketing",
    requestedBy,
    relationType: "draft_newsletter",
    action: "draft_weekly_newsletter",
    trigger: "email_campaigns_selected_topics",
    payloadExtra: {
      source_topic_ids: topicIds,
      newsletter_kind: "weekly_newsletter",
    },
  });

  for (const topic of topics) {
    const metadata = asObject(topic.metadata);
    await query(
      `update public.pipeline_items
          set status = 'used_in_newsletter',
              metadata = $1::jsonb,
              updated_at = $2::timestamptz
        where id = $3`,
      [
        JSON.stringify({
          ...metadata,
          newsletter_usage: {
            newsletter_pipeline_item_id: newsletter.id,
            newsletter_work_item_id: workItem.id,
            used_at: now,
          },
        }),
        now,
        topic.id,
      ],
    );
  }

  await query(
    `insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
     values ('email', 'email_campaign.newsletter_requested', 'pipeline_item', $1, $2, $3::jsonb)`,
    [
      newsletter.id,
      requestedBy,
      JSON.stringify({
        work_item_id: workItem.id,
        source_topic_ids: topicIds,
        trigger: "email_campaigns_selected_topics",
      }),
    ],
  );

  return NextResponse.json({ newsletter, workItem });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const topicIds: string[] = Array.isArray(body.topicIds)
    ? Array.from(new Set<string>(body.topicIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)))
    : [];

  if (topicIds.length === 0) {
    return NextResponse.json({ error: "Seleccioná al menos un tema" }, { status: 400 });
  }

  if (isLocalAuthDisabled()) {
    const localUser = getLocalMissionControlUser();
    if (!localUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return assembleNewsletterLocal(topicIds, localUser.email);
  }

  const supabase = await createClient();
  const db = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: topics, error: topicsError } = await db
    .from("pipeline_items")
    .select("id,title,status,priority,metadata,source_id,current_url,created_at,updated_at")
    .eq("pipeline_type", "email_campaign")
    .in("id", topicIds);

  if (topicsError) return NextResponse.json({ error: topicsError.message }, { status: 500 });
  if (!topics || topics.length !== topicIds.length) {
    return NextResponse.json({ error: "No se encontraron todos los temas seleccionados" }, { status: 404 });
  }

  const invalid = topics.find((topic) => {
    const metadata = asObject(topic.metadata);
    return metadata.intel_source_type !== "intel_inbox" || metadata.intel_destination_key !== "email";
  });
  if (invalid) {
    return NextResponse.json({ error: `El item no es un tema de Email: ${invalid.title || invalid.id}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const weekKey = now.slice(0, 10);
  const topicPayload = topics.map((topic) => {
    const metadata = asObject(topic.metadata);
    const source = asObject(metadata.source);
    return {
      id: topic.id,
      title: topic.title || "Tema sin título",
      summary: readString(metadata.summary) || readString(metadata.why_it_matters) || readString(metadata.notes),
      source_url: readString(metadata.source_url) || readString(source.url) || readString(topic.current_url),
    };
  });

  const newsletterTitle = `Newsletter jueves — ${weekKey}`;
  const { data: newsletter, error: insertError } = await db
    .from("pipeline_items")
    .insert({
      title: newsletterTitle,
      pipeline_type: "email_campaign",
      status: "drafting",
      priority: "medium",
      owner_agent: "marketing",
      requested_by: user.email || user.id,
      source_type: "manual",
      source_id: `email-newsletter-${weekKey}`,
      metadata: {
        kind: "weekly_newsletter",
        week_key: weekKey,
        created_from: "email_campaigns_tab",
        topics: topicPayload,
        source_topic_ids: topicIds,
        requested_at: now,
        requested_by: user.email || user.id,
      },
      asset_role: "standalone",
      updated_at: now,
    })
    .select("id,title,status")
    .single();

  if (insertError || !newsletter) {
    return NextResponse.json({ error: insertError?.message || "Failed to create newsletter pipeline item" }, { status: 500 });
  }

  const { workItem } = await createPipelineWorkItem(db, {
    pipelineItemId: newsletter.id,
    pipelineType: "email_campaign",
    title: `Draft newsletter: ${newsletterTitle}`,
    instruction: createNewsletterInstruction({
      title: newsletterTitle,
      topics: topicPayload.map((topic) => ({
        title: topic.title,
        summary: topic.summary,
        sourceUrl: topic.source_url,
      })),
    }),
    priority: "medium",
    ownerAgent: "marketing",
    requestedBy: user.email || user.id,
    relationType: "draft_newsletter",
    action: "draft_weekly_newsletter",
    trigger: "email_campaigns_selected_topics",
    payloadExtra: {
      source_topic_ids: topicIds,
      newsletter_kind: "weekly_newsletter",
    },
  });

  for (const topic of topics) {
    const metadata = asObject(topic.metadata);
    await db
      .from("pipeline_items")
      .update({
        status: "used_in_newsletter",
        metadata: {
          ...metadata,
          newsletter_usage: {
            newsletter_pipeline_item_id: newsletter.id,
            newsletter_work_item_id: workItem.id,
            used_at: now,
          },
        },
        updated_at: now,
      })
      .eq("id", topic.id);
  }

  await db.from("event_log").insert({
    domain: "email",
    event_type: "email_campaign.newsletter_requested",
    entity_type: "pipeline_item",
    entity_id: newsletter.id,
    actor: user.email || user.id,
    payload: {
      work_item_id: workItem.id,
      source_topic_ids: topicIds,
      trigger: "email_campaigns_selected_topics",
    },
  });

  return NextResponse.json({ newsletter, workItem });
}
