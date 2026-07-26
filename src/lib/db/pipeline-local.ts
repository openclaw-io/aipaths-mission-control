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

export async function getPipelineItemLocal(id: string, pipelineType?: string) {
  const params: unknown[] = [id];
  let sql = `select ${PIPELINE_ITEM_RETURNING} from pipeline_items where id = $1`;
  if (pipelineType) {
    params.push(pipelineType);
    sql += ` and pipeline_type = $${params.length}`;
  }
  sql += " limit 1";

  const { rows } = await query(sql, params);
  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function updatePipelineItemLocal(id: string, updates: PipelineItemUpdate) {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return getPipelineItemLocal(id);
  }

  const values: unknown[] = [];
  const setters = entries.map(([key, value], index) => {
    values.push(key === "metadata" ? JSON.stringify(value) : value);
    if (key === "metadata") return `${key} = $${index + 1}::jsonb`;
    return `${key} = $${index + 1}`;
  });
  values.push(id);

  const { rows } = await query(
    `update pipeline_items
        set ${setters.join(", ")}
      where id = $${values.length}
      returning ${PIPELINE_ITEM_RETURNING}`,
    values,
  );

  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function createPipelineWorkItemLocal(input: PipelineWorkInput) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `select id, title, status, source_type, owner_agent, target_agent_id, scheduled_for, payload
         from work_items
        where source_type = any($1::text[])
          and source_id = $2
          and status = any($3::text[])
          and payload ->> 'relation_type' = $4
        order by created_at desc
        limit 1`,
      [["pipeline_item", "service"], input.pipelineItemId, OPEN_WORK_STATUSES, input.payloadRelationType || input.relationType],
    );

    if (existing.rows[0]) {
      return { workItem: normalizeRow(existing.rows[0]), created: false };
    }

    const payloadRelationType = input.payloadRelationType || input.relationType;
    const mapRelationType = input.mapRelationType || input.relationType;
    const payload = {
      trigger: input.trigger,
      pipeline_type: input.pipelineType,
      pipeline_item_id: input.pipelineItemId,
      relation_type: payloadRelationType,
      map_relation_type: mapRelationType,
      action: input.action,
      review_notes: input.reviewNotes,
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

    try {
      await client.query(
        `insert into pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
         values ($1, $2, $3)`,
        [input.pipelineItemId, workItem.id, mapRelationType],
      );
    } catch (error) {
      console.error("[pipeline-local] Failed to insert pipeline_work_map", {
        pipelineItemId: input.pipelineItemId,
        workItemId: workItem.id,
        relationType: mapRelationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await client.query(
        `insert into pipeline_events (pipeline_item_id, event_type, actor, from_status, to_status, payload)
         values ($1, 'pipeline_item.work_item_created', 'pipeline-local', null, null, $2::jsonb)`,
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
        ],
      );
    } catch (error) {
      console.error("[pipeline-local] Failed to insert pipeline_events", {
        pipelineItemId: input.pipelineItemId,
        workItemId: workItem.id,
        relationType: payloadRelationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { workItem: normalizeRow(workItem), created: true };
  });
}

export async function getOrCreateVideoAnnouncementEmailItemLocal(input: {
  videoPipelineItemId: string;
  title: string;
  priority: string | null;
  requestedBy: string;
  youtubeUrl: string | null;
  videoId: string | null;
  summary: string | null;
}) {
  return withTransaction(async (client) => {
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

    if (existing.rows[0]) {
      return normalizeRow(existing.rows[0]);
    }

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
      [
        `Anuncio video: ${input.title}`,
        input.priority || "medium",
        input.requestedBy,
        input.videoPipelineItemId,
        JSON.stringify(metadata),
        now,
      ],
    );

    return normalizeRow(inserted.rows[0]);
  });
}
