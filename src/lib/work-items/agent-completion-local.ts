import { verifyPublishedContent } from "@/lib/content/live-verification";
import { normalizeRow, type JsonRecord } from "@/lib/db/mission-control";
import { query, withTransaction } from "@/lib/db/postgres";
import {
  buildPublicationVerificationRequest,
  orchestrateWorkItemCompletion,
  type PreparedPublicationVerification,
  type WorkItemRow,
} from "@/lib/work-items/completion-orchestration";

const WORK_ITEM_COLUMNS = `
  id,
  title,
  status,
  priority,
  owner_agent,
  target_agent_id,
  requested_by,
  source_type,
  source_id,
  kind,
  created_at,
  updated_at,
  started_at,
  completed_at,
  scheduled_for,
  payload
`;

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

function scheduledValuesEqual(left: unknown, right: string | null) {
  if (left === null || left === undefined || left === "") return right === null;
  if (right === null) return false;
  const leftTime = new Date(left as string | number | Date).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime === rightTime;
  return String(left) === right;
}

export async function patchAgentWorkItemWithCompletion(id: string, body: JsonRecord) {
  // Resolve and fetch the publication URL before opening a transaction. Once
  // locked, orchestration rebuilds this request and rejects stale evidence.
  let publicationVerification: PreparedPublicationVerification | null = null;
  if (body.status === "done") {
    const preflightWork = (await query<WorkItemRow>(
      "SELECT * FROM public.work_items WHERE id = $1 LIMIT 1",
      [id],
    )).rows[0];
    if (preflightWork) {
      const payload = (preflightWork.payload || {}) as JsonRecord;
      const pipelineItemId = typeof payload.pipeline_item_id === "string" && payload.pipeline_item_id.trim()
        ? payload.pipeline_item_id.trim()
        : ["pipeline_item", "service"].includes(String(preflightWork.source_type || "")) && typeof preflightWork.source_id === "string"
          ? preflightWork.source_id
          : null;
      if (pipelineItemId) {
        const pipelineItem = (await query<JsonRecord>(
          "SELECT * FROM public.pipeline_items WHERE id = $1 LIMIT 1",
          [pipelineItemId],
        )).rows[0];
        if (pipelineItem) {
          const request = buildPublicationVerificationRequest(preflightWork, pipelineItem, body);
          if (request) {
            publicationVerification = {
              request,
              result: await verifyPublishedContent(request),
              workItemId: preflightWork.id,
              workItemUpdatedAt: preflightWork.updated_at ? String(preflightWork.updated_at) : null,
              pipelineItemId: String(pipelineItem.id),
              pipelineItemUpdatedAt: pipelineItem.updated_at ? String(pipelineItem.updated_at) : null,
            };
          }
        }
      }
    }
  }

  return withTransaction(async (client) => {
    // Global order for Loop-backed completions: Loop -> task -> run -> work item.
    // Cardinality is checked before any work-item mutation so malformed/cross
    // mappings fail closed rather than falling through to another handler.
    const mappings = await client.query<{
      loop_id: string; relation_type: string; workflow_version: number;
    }>(
      `SELECT l.id loop_id,lwi.relation_type,l.workflow_version
         FROM public.loop_work_items lwi JOIN public.loops l ON l.id=lwi.loop_id
        WHERE lwi.work_item_id=$1 AND lwi.relation_type IN ('primary_execution','task_execution')
        ORDER BY l.id,lwi.relation_type FOR UPDATE OF l`,
      [id],
    );
    const taskMappings = mappings.rows.filter((row) => row.relation_type === "task_execution");
    const primaryMappings = mappings.rows.filter((row) => row.relation_type === "primary_execution");
    if (taskMappings.length > 0) {
      if (taskMappings.length !== 1 || primaryMappings.length !== 0 || taskMappings[0].workflow_version !== 2) {
        throw new Error("v2_task_execution_mapping_cardinality");
      }
      const lockedTasks = await client.query<{ id: string }>(
        `SELECT t.id FROM loop_task_runs r JOIN loop_tasks t ON t.id=r.task_id
          WHERE r.work_item_id=$1 ORDER BY t.id FOR UPDATE OF t`,
        [id],
      );
      if (lockedTasks.rows.length !== 1) throw new Error("v2_task_execution_run_cardinality");
      const lockedRuns = await client.query<{ id: string }>(
        "SELECT id FROM loop_task_runs WHERE work_item_id=$1 ORDER BY id FOR UPDATE",
        [id],
      );
      if (lockedRuns.rows.length !== 1) throw new Error("v2_task_execution_run_cardinality");
    } else if (primaryMappings.some((row) => row.workflow_version !== 1)) {
      throw new Error("primary_execution_requires_v1");
    }

    const existingResult = await client.query(
      "SELECT * FROM public.work_items WHERE id = $1 LIMIT 1 FOR UPDATE",
      [id],
    );
    const existing = existingResult.rows[0];
    if (!existing) return null;

    const status = typeof body.status === "string" ? body.status : null;
    if (taskMappings.length > 0 && (!status || !["in_progress", "done", "failed", "canceled"].includes(status))) {
      throw new Error("v2_task_status_transition_conflict");
    }
    const existingPayload = (existing.payload || {}) as JsonRecord;
    const terminalStatuses = new Set(["done", "failed", "canceled"]);
    const expectedAttempt = typeof existingPayload.execution_attempt_id === "string"
      ? existingPayload.execution_attempt_id
      : null;
    const suppliedAttempt = typeof body.execution_attempt_id === "string"
      ? body.execution_attempt_id
      : null;

    // Terminal rows are immutable from the agent endpoint. The sole accepted
    // replay is the identical terminal state for the current attempt, and it
    // must be a true no-op. Human review/rework is the only reopening path.
    if (terminalStatuses.has(existing.status)) {
      if (!status || status !== existing.status) throw new Error("terminal_status_conflict");
      if (expectedAttempt && suppliedAttempt !== expectedAttempt) throw new Error("stale_execution_attempt");
      return normalizeRow(existing);
    }
    const scheduledFor = typeof body.scheduled_for === "string" || body.scheduled_for === null
      ? body.scheduled_for
      : undefined;
    const payloadPatch = body.payload_patch && typeof body.payload_patch === "object" && !Array.isArray(body.payload_patch)
      ? body.payload_patch as JsonRecord
      : null;
    const payloadIncrement = body.payload_increment && typeof body.payload_increment === "object" && !Array.isArray(body.payload_increment)
      ? body.payload_increment as JsonRecord
      : null;

    const completionTime = new Date();
    const updates: Record<string, unknown> = {};
    if (status && status !== existing.status) updates.status = status;
    if (status === "ready" && existing.status !== "ready") {
      updates.started_at = null;
      updates.completed_at = null;
    }
    if (status === "in_progress" && existing.status !== "in_progress") updates.started_at = completionTime;
    if ((status === "done" || status === "failed" || status === "canceled") && existing.status !== status) {
      updates.completed_at = completionTime;
    }
    if (scheduledFor !== undefined && !scheduledValuesEqual(existing.scheduled_for, scheduledFor)) {
      updates.scheduled_for = scheduledFor;
    }
    if (body.result && !(status === "done" && existing.status === "done")) {
      updates.instruction = `${existing.instruction || ""}\n\nResult:\n${String(body.result)}`.trim();
    }

    let nextPayload: JsonRecord | null = null;
    if (body.output !== undefined) nextPayload = { ...(existing.payload || {}), output: body.output };
    if (payloadPatch) nextPayload = { ...(existing.payload || {}), ...(nextPayload || {}), ...payloadPatch };
    if (payloadIncrement) {
      const incrementedPayload: JsonRecord = { ...(existing.payload || {}), ...(nextPayload || {}) };
      for (const [key, rawDelta] of Object.entries(payloadIncrement)) {
        const delta = Number(rawDelta);
        if (Number.isFinite(delta)) incrementedPayload[key] = Number(incrementedPayload[key] || 0) + delta;
      }
      nextPayload = incrementedPayload;
    }
    if (status === "done" && existing.status !== "done") {
      nextPayload = {
        ...(existing.payload || {}),
        ...(nextPayload || {}),
        ...(body.result !== undefined ? { result: body.result } : {}),
        dispatch_state: "completed",
        dispatch_completed_at: completionTime.toISOString(),
      };
    } else if (status === "failed" && existing.status !== "failed") {
      nextPayload = {
        ...(existing.payload || {}),
        ...(nextPayload || {}),
        dispatch_state: "failed",
        dispatch_completed_at: completionTime.toISOString(),
      };
    } else if (status === "canceled" && existing.status !== "canceled") {
      nextPayload = {
        ...(existing.payload || {}),
        ...(nextPayload || {}),
        dispatch_state: "canceled",
        dispatch_completed_at: completionTime.toISOString(),
      };
    }
    if (nextPayload && !jsonValuesEqual(nextPayload, existing.payload || {})) updates.payload = nextPayload;

    // execution_attempt_id is a concurrency token, not a mutation by itself.
    // Reject empty and semantic no-ops before touching updated_at or event_log.
    if (Object.keys(updates).length === 0) throw new Error("empty_work_item_patch");
    if (expectedAttempt && suppliedAttempt !== expectedAttempt) {
      throw new Error("stale_execution_attempt");
    }
    updates.updated_at = completionTime;

    const keys = Object.keys(updates);
    const values = keys.map((key) => updates[key]);
    values.push(id);
    const updatedResult = await client.query(
      `UPDATE public.work_items
          SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(", ")}
        WHERE id = $${values.length}
        RETURNING ${WORK_ITEM_COLUMNS}`,
      values,
    );
    const row = updatedResult.rows[0];

    await orchestrateWorkItemCompletion(client, {
      existing,
      updated: row,
      body,
      publicationVerification,
    });

    const payload = (row.payload || {}) as JsonRecord;
    await client.query(
      `INSERT INTO public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
       VALUES ('work', $1, 'work_item', $2, $3, $4::jsonb)`,
      [
        `work_item.${status || "updated"}`,
        row.id,
        row.owner_agent || "unknown",
        JSON.stringify({
          status: row.status,
          requested_by: row.requested_by,
          source_type: row.source_type,
          source_id: row.source_id,
          pipeline_type: typeof payload.pipeline_type === "string" ? payload.pipeline_type : null,
          pipeline_item_id: typeof payload.pipeline_item_id === "string" ? payload.pipeline_item_id : null,
          action: typeof payload.action === "string" ? payload.action : null,
          current_url: typeof body.current_url === "string" ? body.current_url : null,
          scheduled_for: scheduledFor,
        }),
      ],
    );

    return normalizeRow(row);
  });
}
