const PAYLOAD_KEYS = [
  "action",
  "pipeline_item_id",
  "pipeline_type",
  "relation_type",
  "trigger",
  "schedule_kind",
  "dispatch_state",
  "error",
  "dispatch_failure_reason",
  "dead_letter_reason",
  "operator_alert",
  "requires_human_approval",
  "risk",
  "proposed_action",
  "approval_prompt",
  "summary",
  "target_channel_name",
  "suppress_link_previews",
  "current_url",
  "url",
  "wake_failure_count",
  "stale_claim_requeue_count",
] as const;

const BOOLEAN_KEYS = new Set(["requires_human_approval", "suppress_link_previews"]);
const NUMBER_KEYS = new Set(["wake_failure_count", "stale_claim_requeue_count"]);

const JSON_PATH_SELECT = PAYLOAD_KEYS.map((key) => `payload->>${key}`).join(",");
const WORK_QUEUE_JSON_PATH_SELECT = [
  "action",
  "pipeline_item_id",
  "pipeline_type",
  "relation_type",
  "trigger",
  "schedule_kind",
  "dispatch_state",
  "error",
  "dispatch_failure_reason",
  "dead_letter_reason",
  "operator_alert",
  "requires_human_approval",
  "target_channel_name",
  "suppress_link_previews",
  "current_url",
  "url",
  "wake_failure_count",
  "stale_claim_requeue_count",
].map((key) => `payload->>${key}`).join(",");
const LINKED_JSON_PATH_SELECT = [
  "action",
  "pipeline_item_id",
  "pipeline_type",
  "relation_type",
  "trigger",
  "target_channel_name",
  "suppress_link_previews",
].map((key) => `payload->>${key}`).join(",");

export const COMPACT_WORK_ITEM_SELECT =
  "id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,started_at,completed_at,scheduled_for," +
  JSON_PATH_SELECT;

export const COMPACT_WORK_QUEUE_ITEM_SELECT =
  "id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,started_at,completed_at,scheduled_for," +
  WORK_QUEUE_JSON_PATH_SELECT;

export const COMPACT_LINKED_WORK_ITEM_SELECT =
  "id,source_id,source_type,title,status,owner_agent,target_agent_id,created_at,scheduled_for," +
  LINKED_JSON_PATH_SELECT;

function normalizePayloadValue(key: string, value: unknown) {
  if (value == null || value === "") return undefined;
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.toLowerCase() === "true";
  }
  if (NUMBER_KEYS.has(key)) {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return value;
}

export function compactWorkItemPayload(row: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};

  for (const key of PAYLOAD_KEYS) {
    const value = normalizePayloadValue(key, row[key]);
    if (value !== undefined) payload[key] = value;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

export function compactWorkItemRow<T extends Record<string, unknown>>(row: T): T & { payload: Record<string, unknown> | null } {
  const compact = { ...row } as Record<string, unknown>;

  for (const key of PAYLOAD_KEYS) {
    delete compact[key];
  }

  compact.payload = compactWorkItemPayload(row);
  return compact as T & { payload: Record<string, unknown> | null };
}
