import type { PoolClient } from "pg";
import { normalizeRow } from "@/lib/db/mission-control";
import { query, withTransaction } from "@/lib/db/postgres";
import type { PipelineWorkInput } from "@/lib/work-items/pipeline-materializer";

export type JsonRecord = Record<string, unknown>;

export const PIPELINE_ITEM_RETURNING = `
  id, pipeline_type, title, slug, status, priority, owner_agent, requested_by,
  source_type, source_id, scheduled_for, published_at, current_url, content_path,
  content_format, metadata, created_at, updated_at
`;

const OPEN_WORK_STATUSES = ["draft", "ready", "blocked", "in_progress"];
type TransactionClient = Pick<PoolClient, "query">;

function shouldPreserveBlockedLiveGate(item: { status?: string | null; payload?: Record<string, unknown> | null }) {
  if (item.status !== "blocked") return false;
  const payload = (item.payload || {}) as Record<string, unknown>;
  return payload.requires_live_check_passed === true
    || payload.dispatch_state === "blocked_live_gate"
    || typeof payload.public_gate_applies_to === "string";
}

function updateExistingWorkStatus(item: { status?: string | null; payload?: Record<string, unknown> | null }, scheduledFor?: string | null) {
  if (scheduledFor) return "ready";
  if (item.status === "in_progress") return "in_progress";
  if (shouldPreserveBlockedLiveGate(item)) return "blocked";
  return "ready";
}

type PipelineItemUpdate = {
  status?: string;
  priority?: string | null;
  owner_agent?: string | null;
  metadata?: JsonRecord;
  updated_at?: string;
  published_at?: string | null;
  scheduled_for?: string | null;
  current_url?: string | null;
};

async function getPipelineItemWithClient(client: TransactionClient, id: string, pipelineTypes?: string[], forUpdate = false) {
  const params: unknown[] = [id];
  let sql = `select ${PIPELINE_ITEM_RETURNING} from pipeline_items where id = $1`;
  if (pipelineTypes?.length) {
    params.push(pipelineTypes);
    sql += ` and pipeline_type = any($${params.length}::text[])`;
  }
  sql += ` limit 1${forUpdate ? " for update" : ""}`;
  const { rows } = await client.query(sql, params);
  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function getPipelineItemLocal(id: string, pipelineType?: string) {
  const { rows } = await query(
    `select ${PIPELINE_ITEM_RETURNING}
       from pipeline_items
      where id = $1${pipelineType ? " and pipeline_type = $2" : ""}
      limit 1`,
    pipelineType ? [id, pipelineType] : [id],
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

async function updatePipelineItemWithClient(client: TransactionClient, id: string, updates: PipelineItemUpdate) {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (!entries.length) return getPipelineItemWithClient(client, id);

  const values: unknown[] = [];
  const setters = entries.map(([key, value], index) => {
    values.push(key === "metadata" ? JSON.stringify(value) : value);
    return key === "metadata" ? `${key} = $${index + 1}::jsonb` : `${key} = $${index + 1}`;
  });
  values.push(id);

  const { rows } = await client.query(
    `update pipeline_items
        set ${setters.join(", ")}
      where id = $${values.length}
      returning ${PIPELINE_ITEM_RETURNING}`,
    values,
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function updatePipelineItemLocal(id: string, updates: PipelineItemUpdate, client?: TransactionClient) {
  if (client) return updatePipelineItemWithClient(client, id, updates);
  return withTransaction((transactionClient) => updatePipelineItemWithClient(transactionClient, id, updates));
}

/**
 * Serializes every local transition for one pipeline row. All writes performed
 * with the supplied client commit or roll back as one unit.
 */
export async function withLockedPipelineItemLocal<T>(
  id: string,
  pipelineTypes: string[],
  run: (context: { client: TransactionClient; item: JsonRecord & { id: string; pipeline_type: string; status: string } }) => Promise<T>,
): Promise<T | null> {
  return withTransaction(async (client) => {
    const item = await getPipelineItemWithClient(client, id, pipelineTypes, true) as (JsonRecord & { id: string; pipeline_type: string; status: string }) | null;
    if (!item) return null;
    return run({ client, item });
  });
}

async function ensureWorkMapAndCreationEvent(
  client: TransactionClient,
  input: PipelineWorkInput,
  workItem: Record<string, unknown>,
) {
  const payloadRelationType = input.payloadRelationType || input.relationType;
  const mapRelationType = input.mapRelationType || input.relationType;

  await client.query(
    `insert into pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     values ($1, $2, $3)
     on conflict (pipeline_item_id, work_item_id, relation_type) do nothing`,
    [input.pipelineItemId, workItem.id, mapRelationType],
  );

  await client.query(
    `insert into pipeline_events (pipeline_item_id, event_type, actor, from_status, to_status, payload)
     select $1, 'pipeline_item.work_item_created', 'pipeline-local', null, null, $2::jsonb
      where not exists (
        select 1 from pipeline_events
         where pipeline_item_id = $1
           and event_type = 'pipeline_item.work_item_created'
           and payload ->> 'work_item_id' = $3
      )`,
    [
      input.pipelineItemId,
      JSON.stringify({
        work_item_id: workItem.id,
        relation_type: payloadRelationType,
        map_relation_type: mapRelationType,
        source_type: "pipeline_item",
        target_agent_id: input.ownerAgent,
        trigger: input.trigger,
        action: input.action,
      }),
      String(workItem.id),
    ],
  );
}

async function createPipelineWorkItemWithClient(client: TransactionClient, input: PipelineWorkInput) {
  const payloadRelationType = input.payloadRelationType || input.relationType;
  const mapRelationType = input.mapRelationType || input.relationType;
  const dedupeKey = `${input.pipelineItemId}:${payloadRelationType}`;

  // Also protects standalone callers that do not already hold the pipeline row lock.
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [dedupeKey]);

  const existing = await client.query(
    `select id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload
       from work_items
      where source_type = any($1::text[])
        and source_id = $2
        and status = any($3::text[])
        and payload ->> 'relation_type' = $4
      order by created_at desc
      limit 1
      for update`,
    [["pipeline_item", "service"], input.pipelineItemId, OPEN_WORK_STATUSES, payloadRelationType],
  );

  if (existing.rows[0]) {
    if (input.updateExisting) {
      const nextStatus = updateExistingWorkStatus(existing.rows[0], input.scheduledFor);
      const existingPayload = (existing.rows[0].payload || {}) as Record<string, unknown>;
      const payload: Record<string, unknown> = {
        ...existingPayload,
        trigger: input.trigger,
        pipeline_type: input.pipelineType,
        pipeline_item_id: input.pipelineItemId,
        relation_type: payloadRelationType,
        map_relation_type: mapRelationType,
        action: input.action,
        review_notes: input.reviewNotes,
        dedupe_key: dedupeKey,
        ...(input.payloadExtra || {}),
      };
      if (input.scheduledFor && existingPayload.dispatch_state === "blocked_live_gate") {
        payload.previous_dispatch_state = "blocked_live_gate";
        payload.dispatch_state = "ready_after_explicit_schedule";
      }
      const updated = await client.query(
        `update work_items
            set title = $1,
                instruction = $2,
                status = $9,
                priority = $3,
                owner_agent = $4,
                target_agent_id = $4,
                requested_by = $5,
                scheduled_for = $6::timestamptz,
                started_at = case when $9 = 'ready' then null else started_at end,
                completed_at = case when $9 = 'ready' then null else completed_at end,
                payload = $7::jsonb,
                updated_at = now()
          where id = $8
          returning id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload`,
        [
          input.title,
          input.instruction,
          input.priority || "medium",
          input.ownerAgent,
          input.requestedBy,
          input.scheduledFor || null,
          JSON.stringify(payload),
          existing.rows[0].id,
          nextStatus,
        ],
      );
      await ensureWorkMapAndCreationEvent(client, input, updated.rows[0]);
      return { workItem: normalizeRow(updated.rows[0]), created: false, updatedExisting: true };
    }
    await ensureWorkMapAndCreationEvent(client, input, existing.rows[0]);
    return { workItem: normalizeRow(existing.rows[0]), created: false };
  }

  const payload: Record<string, unknown> = {
    trigger: input.trigger,
    pipeline_type: input.pipelineType,
    pipeline_item_id: input.pipelineItemId,
    relation_type: payloadRelationType,
    map_relation_type: mapRelationType,
    action: input.action,
    review_notes: input.reviewNotes,
    dedupe_key: dedupeKey,
    ...(input.payloadExtra || {}),
  };

  const inserted = await client.query(
    `insert into work_items (
       kind, source_type, source_id, title, instruction, status, priority,
       owner_agent, target_agent_id, requested_by, scheduled_for, payload
     ) values (
       'task', 'pipeline_item', $1, $2, $3, 'ready', $4,
       $5, $5, $6, $7, $8::jsonb
     )
     returning id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload`,
    [
      input.pipelineItemId,
      input.title,
      input.instruction,
      input.priority || "medium",
      input.ownerAgent,
      input.requestedBy,
      input.scheduledFor || null,
      JSON.stringify(payload),
    ],
  );

  const workItem = inserted.rows[0];
  await ensureWorkMapAndCreationEvent(client, input, workItem);
  return { workItem: normalizeRow(workItem), created: true };
}

export async function createPipelineWorkItemLocal(input: PipelineWorkInput, client?: TransactionClient) {
  if (client) return createPipelineWorkItemWithClient(client, input);
  return withTransaction((transactionClient) => createPipelineWorkItemWithClient(transactionClient, input));
}

export async function insertPipelineTransitionEventLocal(
  client: TransactionClient,
  input: {
    domain: string;
    eventType: string;
    pipelineItemId: string;
    actor: string;
    dedupeKey: string;
    payload?: JsonRecord;
  },
) {
  const payload = { ...(input.payload || {}), dedupe_key: input.dedupeKey };
  const result = await client.query(
    `insert into event_log (domain, event_type, entity_type, entity_id, actor, payload)
     select $1, $2, 'pipeline_item', $3, $4, $5::jsonb
      where not exists (
        select 1 from event_log
         where domain = $1
           and event_type = $2
           and entity_type = 'pipeline_item'
           and entity_id = $3
           and payload ->> 'dedupe_key' = $6
      )
     returning id`,
    [input.domain, input.eventType, input.pipelineItemId, input.actor, JSON.stringify(payload), input.dedupeKey],
  );
  return { created: result.rowCount === 1, id: result.rows[0]?.id || null };
}

async function getOrCreateVideoAnnouncementEmailItemWithClient(client: TransactionClient, input: {
  videoPipelineItemId: string;
  title: string;
  priority: string | null;
  requestedBy: string;
  youtubeUrl: string | null;
  videoId: string | null;
  summary: string | null;
}) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`video-announcement:${input.videoPipelineItemId}`]);
  const existing = await client.query(
    `select id, title, status
       from pipeline_items
      where pipeline_type = 'email_campaign'
        and metadata ->> 'kind' = 'video_announcement'
        and metadata ->> 'source_video_pipeline_item_id' = $1
      order by updated_at desc nulls last, created_at desc
      limit 1`,
    [input.videoPipelineItemId],
  );
  if (existing.rows[0]) return normalizeRow(existing.rows[0]);

  const now = new Date().toISOString();
  const metadata = {
    kind: "video_announcement",
    source_video_pipeline_item_id: input.videoPipelineItemId,
    youtube_url: input.youtubeUrl,
    video_id: input.videoId,
    summary: input.summary,
    requested_at: now,
    requested_by: input.requestedBy,
  };
  const inserted = await client.query(
    `insert into pipeline_items (
       title, pipeline_type, status, priority, owner_agent, requested_by,
       source_type, source_id, metadata, asset_role, updated_at
     ) values (
       $1, 'email_campaign', 'drafting', $2, 'marketing', $3,
       'pipeline_item', $4, $5::jsonb, 'standalone', $6
     )
     returning id, title, status`,
    [`Anuncio video: ${input.title}`, input.priority || "medium", input.requestedBy, input.videoPipelineItemId, JSON.stringify(metadata), now],
  );
  return normalizeRow(inserted.rows[0]);
}

export async function getOrCreateVideoAnnouncementEmailItemLocal(
  input: Parameters<typeof getOrCreateVideoAnnouncementEmailItemWithClient>[1],
  client?: TransactionClient,
) {
  if (client) return getOrCreateVideoAnnouncementEmailItemWithClient(client, input);
  return withTransaction((transactionClient) => getOrCreateVideoAnnouncementEmailItemWithClient(transactionClient, input));
}
