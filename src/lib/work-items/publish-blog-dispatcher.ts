export const PUBLISH_BLOG_DISPATCHER_CALLER = "publish_blog_dispatcher_v1" as const;
export const PUBLISH_BLOG_DISPATCHER_CRON_NAME = "publish-blog-dispatcher" as const;

type JsonRecord = Record<string, unknown>;

export type PublishBlogDispatchCandidate = {
  id: string;
  status: string;
  scheduled_for: string | Date | null;
  source_type: string | null;
  source_id: string | null;
  owner_agent: string | null;
  target_agent_id: string | null;
  payload: JsonRecord | null;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/**
 * Mission Control only classifies the row locked by notify. Runtime-workers is
 * the sole dispatcher and health writer for this contract.
 */
export function isPublishBlogDispatchCandidate(
  row: PublishBlogDispatchCandidate,
  now = new Date(),
) {
  const payload = record(row.payload);
  const pipelineItemId = typeof payload.pipeline_item_id === "string" ? payload.pipeline_item_id : "";
  const scheduledAt = row.scheduled_for instanceof Date
    ? row.scheduled_for.getTime()
    : typeof row.scheduled_for === "string" ? Date.parse(row.scheduled_for) : Number.NaN;
  return row.status === "ready"
    && Number.isFinite(scheduledAt)
    && scheduledAt <= now.getTime()
    && row.owner_agent === "dev"
    && row.target_agent_id === "dev"
    && ["pipeline_item", "service"].includes(String(row.source_type || ""))
    && typeof row.source_id === "string"
    && payload.pipeline_type === "blog"
    && pipelineItemId.length > 0
    && row.source_id === pipelineItemId
    && payload.dedupe_key === `${pipelineItemId}:publish_blog`
    && payload.requires_human_approval !== true
    && payload.relation_type === "publish"
    && payload.action === "publish_blog"
    && payload.schedule_kind === "publication";
}
