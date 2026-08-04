import { normalizeRow } from "@/lib/db/mission-control";
import { withTransaction } from "@/lib/db/postgres";
import { buildScheduledLaunchPublicActionPayload } from "@/lib/youtube-launch-package";

export type JsonRecord = Record<string, unknown>;

type QueryClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type PipelineItemRow = JsonRecord & {
  id: string;
  pipeline_type: string;
  title: string;
  status: string;
  priority?: string | null;
  metadata?: JsonRecord | null;
  source_id?: string | null;
  current_url?: string | null;
  scheduled_for?: string | Date | null;
};

type WorkItemRow = JsonRecord & {
  id: string;
  title: string;
  status: string;
  scheduled_for?: string | Date | null;
  payload?: JsonRecord | null;
};

const TERMINAL_WORK_STATUSES = new Set(["done", "failed", "canceled", "cancelled"]);
const TERMINAL_PIPELINE_STATUSES = ["sent", "published", "live", "archived", "rejected", "canceled", "cancelled"];
const WORK_RETURNING = "id, title, instruction, status, priority, owner_agent, target_agent_id, requested_by, source_type, source_id, scheduled_for, payload, created_at, updated_at, completed_at";
const CAMPAIGN_RETURNING = "id, pipeline_type, title, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, metadata, created_at, updated_at";

export class EmailCampaignLocalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "EmailCampaignLocalError";
    this.status = status;
  }
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeOptionalIso(value: unknown, label: string): string | null {
  if (!value) return null;
  const iso = toIso(value);
  if (!iso) throw new EmailCampaignLocalError(`${label} must be a valid date`, 400);
  return iso;
}

function getSourceVideoId(metadata: JsonRecord) {
  const source = asObject(metadata.source);
  return readString(source.video_id) || readString(metadata.video_id) || readString(metadata.source_video_id);
}

function requiresYouTubeLiveGate(kind: string | null, metadata: JsonRecord) {
  return kind === "video_announcement" || getSourceVideoId(metadata) !== null;
}

function getApprovalAutoScheduleTarget(metadata: JsonRecord, itemScheduledFor: unknown) {
  const launchPackage = asObject(metadata.launch_package);
  return normalizeOptionalIso(
    readString(launchPackage.target_send_at) || itemScheduledFor,
    "metadata.launch_package.target_send_at or scheduled_for",
  );
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

function buildRevisionInstruction(input: { title: string; feedback: string; kind: string | null; currentDraft: JsonRecord }) {
  return [
    `Email campaign pipeline item: ${input.title}`,
    `Campaign type: ${input.kind || "email_campaign"}`,
    "",
    "Task:",
    "- Rework the Spanish email draft using Gonza's feedback below.",
    "- Preserve what works, but produce a fresh improved version.",
    "- Do not send or schedule the email.",
    "- Complete this work item with output.email_draft containing: subject, preview_text, body_markdown.",
    "- Mission Control will move the email card to ready_for_review after completion.",
    "",
    "Feedback / corrections:",
    input.feedback,
    "",
    "Current draft JSON:",
    JSON.stringify(input.currentDraft, null, 2),
  ].join("\n");
}

function buildSendInstruction(input: { title: string; kind: string | null; scheduledFor: string; draft: JsonRecord; requiresYouTubeLiveGate?: boolean }) {
  return [
    `Email campaign pipeline item: ${input.title}`,
    `Campaign type: ${input.kind || "email_campaign"}`,
    `Scheduled for: ${input.scheduledFor}`,
    "",
    "Task:",
    "- Prepare/send this approved email campaign at the scheduled time using the current AIPaths email-send workflow.",
    "- Use only the approved draft below. Do not rewrite unless there is a blocking formatting issue.",
    "- If real sending infrastructure is not available yet, complete the work item as blocked/failed with the exact blocker; do not invent a send result.",
    ...(input.requiresYouTubeLiveGate ? [
      "- YouTube launch gate: before sending, verify privacyStatus=public/live and that Gonza approved this campaign; block if not confirmed.",
    ] : []),
    "- When sent, complete this work item with output.sent_at and any provider/campaign URL or ID available.",
    "",
    "Approved draft JSON:",
    JSON.stringify(input.draft, null, 2),
  ].join("\n");
}

async function advisoryLock(client: QueryClient, key: string) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function lockCampaign(client: QueryClient, campaignId: string) {
  await advisoryLock(client, `email-campaign:${campaignId}`);
  const result = await client.query<PipelineItemRow>(
    `select ${CAMPAIGN_RETURNING}
       from public.pipeline_items
      where id = $1 and pipeline_type = 'email_campaign'
      limit 1
      for update`,
    [campaignId],
  );
  if (!result.rows[0]) throw new EmailCampaignLocalError("Email campaign not found", 404);
  return result.rows[0];
}

async function ensureWorkArtifacts(client: QueryClient, input: {
  pipelineItemId: string;
  workItem: WorkItemRow;
  relationType: string;
  actor: string;
  trigger: string;
  action: string;
}) {
  await client.query(
    `insert into public.pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     values ($1, $2, $3)
     on conflict (pipeline_item_id, work_item_id, relation_type) do nothing`,
    [input.pipelineItemId, input.workItem.id, input.relationType],
  );
  const event = await client.query(
    `select id from public.pipeline_events
      where pipeline_item_id = $1
        and event_type = 'pipeline_item.work_item_created'
        and payload ->> 'work_item_id' = $2
      limit 1`,
    [input.pipelineItemId, input.workItem.id],
  );
  if (!event.rows[0]) {
    await client.query(
      `insert into public.pipeline_events (pipeline_item_id, event_type, actor, payload)
       values ($1, 'pipeline_item.work_item_created', $2, $3::jsonb)`,
      [input.pipelineItemId, input.actor, JSON.stringify({
        work_item_id: input.workItem.id,
        relation_type: input.relationType,
        action: input.action,
        trigger: input.trigger,
      })],
    );
  }
}

async function insertWorkItem(client: QueryClient, input: {
  pipelineItemId: string;
  title: string;
  instruction: string;
  priority: string;
  actor: string;
  scheduledFor?: string | null;
  payload: JsonRecord;
}) {
  const result = await client.query<WorkItemRow>(
    `insert into public.work_items (
       kind, source_type, source_id, title, instruction, status, priority,
       owner_agent, target_agent_id, requested_by, scheduled_for, payload
     ) values ('task', 'pipeline_item', $1, $2, $3, 'ready', $4, 'marketing', 'marketing', $5, $6, $7::jsonb)
     returning ${WORK_RETURNING}`,
    [
      input.pipelineItemId,
      input.title,
      input.instruction,
      input.priority,
      input.actor,
      input.scheduledFor || null,
      JSON.stringify(input.payload),
    ],
  );
  return result.rows[0];
}

async function upsertSendEmailWorkItem(client: QueryClient, input: {
  item: PipelineItemRow;
  metadata: JsonRecord;
  scheduledFor: string;
  actorIdentity: string;
  now: string;
}) {
  const draft = asObject(input.metadata.draft);
  const kind = readString(input.metadata.kind);
  const existingResult = await client.query<WorkItemRow>(
    `select ${WORK_RETURNING}
       from public.work_items
      where source_type = any($1::text[])
        and source_id = $2
        and payload ->> 'action' = 'send_email_campaign'
      order by created_at desc
      limit 1
      for update`,
    [["pipeline_item", "service"], input.item.id],
  );
  let workItem = existingResult.rows[0];
  const terminalWork = workItem ? TERMINAL_WORK_STATUSES.has(workItem.status) : false;
  const effectiveScheduledFor = terminalWork ? toIso(workItem?.scheduled_for) || input.scheduledFor : input.scheduledFor;
  const liveGateRequired = requiresYouTubeLiveGate(kind, input.metadata);
  const sourceVideoId = getSourceVideoId(input.metadata);
  const instruction = buildSendInstruction({
    title: input.item.title,
    kind,
    scheduledFor: input.scheduledFor,
    draft,
    requiresYouTubeLiveGate: liveGateRequired,
  });
  const payloadPatch = {
    trigger: "email_campaign_scheduled",
    pipeline_type: "email_campaign",
    pipeline_item_id: input.item.id,
    relation_type: "send_email_campaign",
    map_relation_type: "send_email_campaign",
    action: "send_email_campaign",
    email_campaign_kind: kind,
    schedule_kind: "email_send",
    ...(liveGateRequired ? {
      public_gate_applies_to: "publish_or_send_only",
      requires_live_check_passed: true,
      requires_gonza_approval: true,
      source_video_id: sourceVideoId,
      ...buildScheduledLaunchPublicActionPayload({
        metadata: input.metadata,
        ownerAgent: "marketing",
        action: "send_email_campaign",
        destination: "ai_paths_email",
      }),
    } : {}),
  };

  if (!workItem) {
    workItem = await insertWorkItem(client, {
      pipelineItemId: input.item.id,
      title: `Send email campaign: ${input.item.title}`,
      instruction,
      priority: input.item.priority || "medium",
      actor: input.actorIdentity,
      scheduledFor: input.scheduledFor,
      payload: payloadPatch,
    });
  } else if (!terminalWork) {
    const updated = await client.query<WorkItemRow>(
      `update public.work_items
          set title = $1,
              instruction = $2,
              scheduled_for = $3::timestamptz,
              status = case when status = 'in_progress' then status else 'ready' end,
              priority = $4,
              owner_agent = 'marketing',
              target_agent_id = 'marketing',
              requested_by = $5,
              payload = coalesce(payload, '{}'::jsonb) || $6::jsonb,
              updated_at = $7::timestamptz
        where id = $8
        returning ${WORK_RETURNING}`,
      [`Send email campaign: ${input.item.title}`, instruction, input.scheduledFor, input.item.priority || "medium", input.actorIdentity, JSON.stringify(payloadPatch), input.now, workItem.id],
    );
    workItem = updated.rows[0];
  }

  await ensureWorkArtifacts(client, {
    pipelineItemId: input.item.id,
    workItem,
    relationType: "send_email_campaign",
    actor: input.actorIdentity,
    trigger: "email_campaign_scheduled",
    action: "send_email_campaign",
  });

  return { workItem, effectiveScheduledFor };
}

export async function assembleNewsletterLocalAtomic(input: {
  topicIds: string[];
  requestedBy: string;
  now?: string;
}) {
  return withTransaction(async (client) => {
    const now = input.now || new Date().toISOString();
    const weekKey = now.slice(0, 10);
    const sourceId = `email-newsletter-${weekKey}`;
    await advisoryLock(client, `email-newsletter:${sourceId}`);

    const topicResult = await client.query<PipelineItemRow>(
      `select id, pipeline_type, title, status, priority, metadata, source_id, current_url, created_at, updated_at
         from public.pipeline_items
        where pipeline_type = 'email_campaign'
          and id = any($1::uuid[])
        order by id
        for update`,
      [input.topicIds],
    );
    const topics = topicResult.rows;
    if (topics.length !== input.topicIds.length) {
      throw new EmailCampaignLocalError("No se encontraron todos los temas seleccionados", 404);
    }
    const invalid = topics.find((topic) => {
      const metadata = asObject(topic.metadata);
      return metadata.intel_source_type !== "intel_inbox" || metadata.intel_destination_key !== "email";
    });
    if (invalid) throw new EmailCampaignLocalError(`El item no es un tema de Email: ${invalid.title || invalid.id}`, 400);

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
    const existingNewsletter = await client.query<PipelineItemRow>(
      `select ${CAMPAIGN_RETURNING}
         from public.pipeline_items
        where pipeline_type = 'email_campaign' and source_id = $1
        order by created_at
        limit 1
        for update`,
      [sourceId],
    );
    let newsletter = existingNewsletter.rows[0];
    if (!newsletter) {
      const inserted = await client.query<PipelineItemRow>(
        `insert into public.pipeline_items (
           title, pipeline_type, status, priority, owner_agent, requested_by,
           source_type, source_id, metadata, asset_role, updated_at
         ) values ($1, 'email_campaign', 'drafting', 'medium', 'marketing', $2,
           'manual', $3, $4::jsonb, 'standalone', $5::timestamptz)
         returning ${CAMPAIGN_RETURNING}`,
        [newsletterTitle, input.requestedBy, sourceId, JSON.stringify({
          kind: "weekly_newsletter",
          week_key: weekKey,
          created_from: "email_campaigns_tab",
          topics: topicPayload,
          source_topic_ids: input.topicIds,
          requested_at: now,
          requested_by: input.requestedBy,
        }), now],
      );
      newsletter = inserted.rows[0];
    }

    const existingWork = await client.query<WorkItemRow>(
      `select ${WORK_RETURNING}
         from public.work_items
        where source_type = any($1::text[])
          and source_id = $2
          and payload ->> 'action' = 'draft_weekly_newsletter'
        order by created_at
        limit 1
        for update`,
      [["pipeline_item", "service"], newsletter.id],
    );
    let workItem = existingWork.rows[0];
    if (!workItem) {
      workItem = await insertWorkItem(client, {
        pipelineItemId: newsletter.id,
        title: `Draft newsletter: ${newsletterTitle}`,
        instruction: createNewsletterInstruction({
          title: newsletterTitle,
          topics: topicPayload.map((topic) => ({ title: topic.title, summary: topic.summary, sourceUrl: topic.source_url })),
        }),
        priority: "medium",
        actor: input.requestedBy,
        payload: {
          trigger: "email_campaigns_selected_topics",
          pipeline_type: "email_campaign",
          pipeline_item_id: newsletter.id,
          relation_type: "draft_newsletter",
          map_relation_type: "draft_newsletter",
          action: "draft_weekly_newsletter",
          source_topic_ids: input.topicIds,
          newsletter_kind: "weekly_newsletter",
        },
      });
    }
    await ensureWorkArtifacts(client, {
      pipelineItemId: newsletter.id,
      workItem,
      relationType: "draft_newsletter",
      actor: input.requestedBy,
      trigger: "email_campaigns_selected_topics",
      action: "draft_weekly_newsletter",
    });

    for (const topic of topics) {
      await client.query(
        `update public.pipeline_items
            set status = case when status = any($1::text[]) then status else 'used_in_newsletter' end,
                metadata = case
                  when metadata ? 'newsletter_usage' then metadata
                  else jsonb_set(metadata, '{newsletter_usage}', $2::jsonb, true)
                end,
                updated_at = case
                  when metadata ? 'newsletter_usage' and status = any($1::text[]) then updated_at
                  else $3::timestamptz
                end
          where id = $4`,
        [TERMINAL_PIPELINE_STATUSES, JSON.stringify({
          newsletter_pipeline_item_id: newsletter.id,
          newsletter_work_item_id: workItem.id,
          used_at: now,
        }), now, topic.id],
      );
    }

    const eventLog = await client.query(
      `select id from public.event_log
        where domain = 'email'
          and event_type = 'email_campaign.newsletter_requested'
          and entity_id = $1
        limit 1`,
      [newsletter.id],
    );
    if (!eventLog.rows[0]) {
      await client.query(
        `insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
         values ('email', 'email_campaign.newsletter_requested', 'pipeline_item', $1, $2, $3::jsonb)`,
        [newsletter.id, input.requestedBy, JSON.stringify({
          work_item_id: workItem.id,
          source_topic_ids: input.topicIds,
          trigger: "email_campaigns_selected_topics",
        })],
      );
    }

    return { newsletter: normalizeRow(newsletter), workItem: normalizeRow(workItem) };
  });
}

export async function requestEmailChangesLocalAtomic(input: {
  campaignId: string;
  feedback: string;
  actorIdentity: string;
  now?: string;
}) {
  return withTransaction(async (client) => {
    const now = input.now || new Date().toISOString();
    const item = await lockCampaign(client, input.campaignId);
    const metadata = asObject(item.metadata);
    const draft = asObject(metadata.draft);
    const versions = Array.isArray(metadata.draft_versions) ? metadata.draft_versions : [];
    const kind = readString(metadata.kind);

    const existingResult = await client.query<WorkItemRow>(
      `select ${WORK_RETURNING}
         from public.work_items
        where source_type = any($1::text[])
          and source_id = $2
          and payload ->> 'action' = 'revise_email_draft'
          and payload ->> 'feedback' = $3
        order by created_at desc
        limit 1
        for update`,
      [["pipeline_item", "service"], item.id, input.feedback],
    );
    let workItem = existingResult.rows[0];
    const existingRevision = workItem ? Number(asObject(workItem.payload).revision_number) : NaN;
    const revisionNumber = Number.isFinite(existingRevision) && existingRevision > 0 ? existingRevision : versions.length + 1;
    const relationType = `revise_email_draft_${revisionNumber}`;
    const instruction = buildRevisionInstruction({ title: item.title, feedback: input.feedback, kind, currentDraft: draft });
    const payloadPatch = {
      trigger: "email_campaign_review_changes_requested",
      pipeline_type: "email_campaign",
      pipeline_item_id: item.id,
      relation_type: relationType,
      map_relation_type: "revise_email_draft",
      action: "revise_email_draft",
      review_notes: input.feedback,
      feedback: input.feedback,
      revision_number: revisionNumber,
      email_campaign_kind: kind,
    };

    if (!workItem) {
      workItem = await insertWorkItem(client, {
        pipelineItemId: item.id,
        title: `Rehacer email draft: ${item.title}`,
        instruction,
        priority: item.priority || "medium",
        actor: input.actorIdentity,
        payload: payloadPatch,
      });
    } else if (!TERMINAL_WORK_STATUSES.has(workItem.status)) {
      const updated = await client.query<WorkItemRow>(
        `update public.work_items
            set title = $1,
                instruction = $2,
                priority = $3,
                owner_agent = 'marketing',
                target_agent_id = 'marketing',
                requested_by = $4,
                payload = coalesce(payload, '{}'::jsonb) || $5::jsonb,
                updated_at = $6::timestamptz
          where id = $7
          returning ${WORK_RETURNING}`,
        [`Rehacer email draft: ${item.title}`, instruction, item.priority || "medium", input.actorIdentity, JSON.stringify(payloadPatch), now, workItem.id],
      );
      workItem = updated.rows[0];
    }
    await ensureWorkArtifacts(client, {
      pipelineItemId: item.id,
      workItem,
      relationType: "revise_email_draft",
      actor: input.actorIdentity,
      trigger: "email_campaign_review_changes_requested",
      action: "revise_email_draft",
    });

    const alreadyVersioned = versions.some((version) => asObject(version).work_item_id === workItem.id);
    const nextVersions = alreadyVersioned ? versions : [...versions, {
      version: revisionNumber,
      draft,
      feedback: input.feedback,
      requested_at: now,
      requested_by: input.actorIdentity,
      work_item_id: workItem.id,
    }];
    const nextMetadata = {
      ...metadata,
      draft_versions: nextVersions,
      review: {
        ...asObject(metadata.review),
        status: "changes_requested",
        feedback: input.feedback,
        last_requested_at: now,
        last_requested_by: input.actorIdentity,
        revision_work_item_id: workItem.id,
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "changes_requested",
        last_work_item_id: workItem.id,
        updated_at: now,
      },
    };
    const updatedCampaign = await client.query<PipelineItemRow>(
      `update public.pipeline_items
          set status = case when status = any($1::text[]) then status else 'drafting' end,
              metadata = $2::jsonb,
              updated_at = $3::timestamptz
        where id = $4
        returning ${CAMPAIGN_RETURNING}`,
      [TERMINAL_PIPELINE_STATUSES, JSON.stringify(nextMetadata), now, item.id],
    );
    return { item: normalizeRow(updatedCampaign.rows[0]), workItem: normalizeRow(workItem) };
  });
}

export async function scheduleEmailCampaignLocalAtomic(input: {
  campaignId: string;
  scheduledFor: string;
  actorIdentity: string;
  now?: string;
}) {
  return withTransaction(async (client) => {
    const now = input.now || new Date().toISOString();
    const item = await lockCampaign(client, input.campaignId);
    const metadata = asObject(item.metadata);
    const { workItem, effectiveScheduledFor } = await upsertSendEmailWorkItem(client, {
      item,
      metadata,
      scheduledFor: input.scheduledFor,
      actorIdentity: input.actorIdentity,
      now,
    });

    const nextMetadata = {
      ...metadata,
      schedule: {
        ...asObject(metadata.schedule),
        scheduled_for: effectiveScheduledFor,
        scheduled_at: now,
        scheduled_by: input.actorIdentity,
        send_work_item_id: workItem.id,
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "scheduled",
        last_work_item_id: workItem.id,
        updated_at: now,
      },
    };
    const updatedCampaign = await client.query<PipelineItemRow>(
      `update public.pipeline_items
          set status = case when status = any($1::text[]) then status else 'scheduled' end,
              scheduled_for = case when status = any($1::text[]) then scheduled_for else $2::timestamptz end,
              metadata = $3::jsonb,
              updated_at = $4::timestamptz
        where id = $5
        returning ${CAMPAIGN_RETURNING}`,
      [TERMINAL_PIPELINE_STATUSES, effectiveScheduledFor, JSON.stringify(nextMetadata), now, item.id],
    );
    return { item: normalizeRow(updatedCampaign.rows[0]), workItem: normalizeRow(workItem) };
  });
}

export async function approveEmailCampaignLocalAtomic(input: {
  campaignId: string;
  actorIdentity: string;
  now?: string;
}) {
  return withTransaction(async (client) => {
    const now = input.now || new Date().toISOString();
    const item = await lockCampaign(client, input.campaignId);
    const metadata = asObject(item.metadata);
    const kind = readString(metadata.kind);
    const approvedMetadata: JsonRecord = {
      ...metadata,
      review: {
        ...asObject(metadata.review),
        status: "approved",
        approved_at: now,
        approved_by: input.actorIdentity,
        launch_generation: readString(asObject(metadata.launch_package).launch_generation),
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "approved",
        updated_at: now,
      },
    };
    const scheduledFor = kind === "video_announcement"
      ? getApprovalAutoScheduleTarget(metadata, item.scheduled_for)
      : null;

    if (!scheduledFor) {
      const updatedCampaign = await client.query<PipelineItemRow>(
        `update public.pipeline_items
            set status = case when status = any($1::text[]) then status else 'approved' end,
                metadata = $2::jsonb,
                updated_at = $3::timestamptz
          where id = $4
          returning ${CAMPAIGN_RETURNING}`,
        [TERMINAL_PIPELINE_STATUSES, JSON.stringify(approvedMetadata), now, item.id],
      );
      return { item: normalizeRow(updatedCampaign.rows[0]) };
    }

    const { workItem, effectiveScheduledFor } = await upsertSendEmailWorkItem(client, {
      item,
      metadata: approvedMetadata,
      scheduledFor,
      actorIdentity: input.actorIdentity,
      now,
    });
    const nextMetadata = {
      ...approvedMetadata,
      schedule: {
        ...asObject(approvedMetadata.schedule),
        scheduled_for: effectiveScheduledFor,
        scheduled_at: now,
        scheduled_by: input.actorIdentity,
        send_work_item_id: workItem.id,
      },
      runtime_feedback: {
        ...asObject(approvedMetadata.runtime_feedback),
        last_status: "scheduled",
        last_work_item_id: workItem.id,
        updated_at: now,
      },
    };
    const updatedCampaign = await client.query<PipelineItemRow>(
      `update public.pipeline_items
          set status = case when status = any($1::text[]) then status else 'scheduled' end,
              scheduled_for = case when status = any($1::text[]) then scheduled_for else $2::timestamptz end,
              metadata = $3::jsonb,
              updated_at = $4::timestamptz
        where id = $5
        returning ${CAMPAIGN_RETURNING}`,
      [TERMINAL_PIPELINE_STATUSES, effectiveScheduledFor, JSON.stringify(nextMetadata), now, item.id],
    );
    return { item: normalizeRow(updatedCampaign.rows[0]), workItem: normalizeRow(workItem) };
  });
}
