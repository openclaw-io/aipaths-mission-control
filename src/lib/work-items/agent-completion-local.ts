import { verifyPublishedContent } from "@/lib/content/live-verification";
import { normalizeRow, type JsonRecord } from "@/lib/db/mission-control";
import { withTransaction } from "@/lib/db/postgres";
import { orchestrateWorkItemCompletion } from "@/lib/work-items/completion-orchestration";

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

export async function patchAgentWorkItemWithCompletion(id: string, body: JsonRecord) {
  return withTransaction(async (client) => {
    // Serialize concurrent completion retries. The work-item update, pipeline
    // completion effects, generated work items/maps, and event log commit or
    // roll back as one local Postgres transaction.
    const existingResult = await client.query(
      "SELECT * FROM public.work_items WHERE id = $1 LIMIT 1 FOR UPDATE",
      [id],
    );
    const existing = existingResult.rows[0];
    if (!existing) return null;

    const status = typeof body.status === "string" ? body.status : null;
    const scheduledFor = typeof body.scheduled_for === "string" || body.scheduled_for === null
      ? body.scheduled_for
      : undefined;
    const payloadPatch = body.payload_patch && typeof body.payload_patch === "object" && !Array.isArray(body.payload_patch)
      ? body.payload_patch as JsonRecord
      : null;
    const payloadIncrement = body.payload_increment && typeof body.payload_increment === "object" && !Array.isArray(body.payload_increment)
      ? body.payload_increment as JsonRecord
      : null;

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (status) updates.status = status;
    if (status === "ready") {
      updates.started_at = null;
      updates.completed_at = null;
    }
    if (status === "in_progress") updates.started_at = new Date();
    if ((status === "done" || status === "failed") && existing.status !== status) {
      updates.completed_at = new Date();
    }
    if (scheduledFor !== undefined) updates.scheduled_for = scheduledFor;
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
    if (nextPayload) updates.payload = nextPayload;

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
      verifyPublishedContent,
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
