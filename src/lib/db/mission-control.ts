import { query, withTransaction } from "@/lib/db/postgres";

export type JsonRecord = Record<string, unknown>;

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

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeValue(entry)]));
  }
  return value;
}

export function normalizeRow<T>(row: T): T {
  return normalizeValue(row) as T;
}

export function normalizeRows<T>(rows: T[]): T[] {
  return rows.map((row) => normalizeRow(row));
}

export async function getWorkItemsBoard(includeRules: boolean) {
  const [itemsRes, eventsRes, rulesRes] = await Promise.all([
    query(`SELECT ${WORK_ITEM_COLUMNS} FROM public.work_items ORDER BY created_at DESC LIMIT 200`),
    query(`
      SELECT id, domain, event_type, entity_type, entity_id, actor, payload, created_at
      FROM public.event_log
      WHERE domain = 'work'
      ORDER BY created_at DESC
      LIMIT 100
    `),
    includeRules
      ? query(`
          SELECT
            r.*,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', o.id,
                  'scheduled_for', o.scheduled_for,
                  'work_item_id', o.work_item_id,
                  'status', o.status
                ) ORDER BY o.scheduled_for
              ) FILTER (WHERE o.id IS NOT NULL),
              '[]'::jsonb
            ) AS recurring_work_occurrences
          FROM public.recurring_work_rules r
          LEFT JOIN public.recurring_work_occurrences o ON o.rule_id = r.id
          GROUP BY r.id
          ORDER BY r.created_at DESC
        `)
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    items: normalizeRows(itemsRes.rows),
    events: normalizeRows(eventsRes.rows),
    rules: normalizeRows(rulesRes.rows),
  };
}

export async function getWorkItem(id: string) {
  const { rows } = await query(`SELECT ${WORK_ITEM_COLUMNS} FROM public.work_items WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? normalizeRow(rows[0]) : null;
}

export async function getSuggestions() {
  const { rows } = await query(
    `SELECT ${WORK_ITEM_COLUMNS}
     FROM public.work_items
     WHERE status = ANY($1::text[])
       AND payload ->> 'requires_human_approval' = 'true'
     ORDER BY created_at DESC
     LIMIT 200`,
    [["blocked", "draft"]],
  );
  return normalizeRows(rows);
}

export async function getOfficeState() {
  const [tasksRes, memoryRes, cronRes] = await Promise.all([
    query(`
      SELECT id, title, owner_agent, target_agent_id, status, created_at, started_at, completed_at
      FROM public.work_items
      ORDER BY created_at DESC
    `),
    query(`
      SELECT agent, date, created_at
      FROM public.memories
      WHERE type = 'journal'
      ORDER BY date DESC, created_at DESC
      LIMIT 50
    `),
    query(`SELECT cron_name, last_status FROM public.cron_health`),
  ]);

  return {
    tasks: normalizeRows(tasksRes.rows),
    memory: normalizeRows(memoryRes.rows),
    cronRows: normalizeRows(cronRes.rows),
  };
}

export async function listMemories(input: {
  agent?: string | null;
  type?: string | null;
  from?: string | null;
  to?: string | null;
  limit: number;
}) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.agent) {
    params.push(input.agent);
    conditions.push(`agent = $${params.length}`);
  }
  if (input.type) {
    params.push(input.type);
    conditions.push(`type = $${params.length}`);
  }
  if (input.from) {
    params.push(input.from);
    conditions.push(`date >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    conditions.push(`date <= $${params.length}`);
  }
  params.push(input.limit);

  const { rows } = await query(
    `SELECT id, agent, type, title, content, tags, date, created_at, updated_at
     FROM public.memories
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY date DESC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return normalizeRows(rows);
}

export async function upsertMemory(input: {
  agent: string;
  type: string;
  title?: string | null;
  content: string;
  tags?: string[] | null;
  date: string;
  embedding?: number[] | null;
}) {
  return withTransaction(async (client) => {
    if (input.type === "journal") {
      const existing = await client.query<{ id: string; content: string }>(
        `SELECT id, content FROM public.memories WHERE agent = $1 AND type = 'journal' AND date = $2 LIMIT 1`,
        [input.agent, input.date],
      );

      if (existing.rows[0]) {
        const merged = `${existing.rows[0].content}\n\n${input.content}`;
        const updated = await client.query(
          `UPDATE public.memories
           SET content = $1,
               title = COALESCE($2, title),
               tags = COALESCE($3::text[], tags),
               embedding = $4::jsonb,
               updated_at = now()
           WHERE id = $5
           RETURNING id, agent, type, title, content, tags, date, created_at, updated_at`,
          [merged, input.title ?? null, input.tags ?? null, input.embedding ? JSON.stringify(input.embedding) : null, existing.rows[0].id],
        );
        return normalizeRow(updated.rows[0]);
      }
    }

    const inserted = await client.query(
      `INSERT INTO public.memories (agent, type, title, content, tags, date, embedding)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::jsonb)
       RETURNING id, agent, type, title, content, tags, date, created_at, updated_at`,
      [input.agent, input.type, input.title ?? null, input.content, input.tags ?? [], input.date, input.embedding ? JSON.stringify(input.embedding) : null],
    );
    return normalizeRow(inserted.rows[0]);
  });
}

export async function searchMemories(input: {
  text: string;
  agent?: string | null;
  type?: string | null;
  limit: number;
}) {
  const params: unknown[] = [`%${input.text}%`];
  const conditions = [`content ILIKE $1`];

  if (input.agent) {
    params.push(input.agent);
    conditions.push(`agent = $${params.length}`);
  }
  if (input.type) {
    params.push(input.type);
    conditions.push(`type = $${params.length}`);
  }
  params.push(input.limit);

  const { rows } = await query(
    `SELECT id, agent, type, title, content, tags, date, created_at, NULL::double precision AS similarity
     FROM public.memories
     WHERE ${conditions.join(" AND ")}
     ORDER BY date DESC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return normalizeRows(rows);
}

export async function createDedupedSuggestionLocal(input: {
  title: string;
  instruction: string;
  dedupeKey: string;
  ownerAgent?: string;
  targetAgentId?: string;
  requestedBy?: string;
  priority?: string;
  risk?: "low" | "medium" | "high";
  proposedAction?: string;
  approvalPrompt?: string;
  sourceType?: string;
  sourceId?: string;
  kind?: string;
  status?: "draft" | "blocked";
  scheduledFor?: string | null;
  payload?: JsonRecord;
}) {
  const dedupeKey = input.dedupeKey.trim();
  if (!dedupeKey) throw new Error("dedupeKey is required");

  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT id, title, status
       FROM public.work_items
       WHERE payload ->> 'dedupe_key' = $1
         AND status = ANY($2::text[])
       ORDER BY created_at DESC
       LIMIT 1`,
      [dedupeKey, ["draft", "blocked", "ready", "in_progress"]],
    );

    if (existing.rows[0]) {
      return {
        id: String(existing.rows[0].id),
        title: String(existing.rows[0].title || input.title),
        status: String(existing.rows[0].status),
        created: false,
        dedupe_key: dedupeKey,
      };
    }

    const ownerAgent = input.ownerAgent || input.targetAgentId || "systems";
    const targetAgentId = input.targetAgentId || input.ownerAgent || "systems";
    const payload = {
      ...(input.payload || {}),
      requires_human_approval: true,
      dedupe_key: dedupeKey,
      risk: input.risk || "medium",
      proposed_action: input.proposedAction || input.title,
      approval_prompt: input.approvalPrompt || input.instruction,
      suggestion_source: input.payload?.suggestion_source || "mission_control",
    };

    const inserted = await client.query(
      `INSERT INTO public.work_items (
         kind, source_type, source_id, title, instruction, status, priority,
         owner_agent, target_agent_id, requested_by, scheduled_for, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING id, title, status`,
      [
        input.kind || "task",
        input.sourceType || "service",
        input.sourceId || null,
        input.title,
        input.instruction,
        input.status || "draft",
        input.priority || "medium",
        ownerAgent,
        targetAgentId,
        input.requestedBy || "mission-control-suggestions",
        input.scheduledFor ?? null,
        JSON.stringify(payload),
      ],
    );

    await client.query(
      `INSERT INTO public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
       VALUES ('work', 'work_item.suggestion_created', 'work_item', $1, $2, $3::jsonb)`,
      [
        inserted.rows[0].id,
        input.requestedBy || "mission-control-suggestions",
        JSON.stringify({
          dedupe_key: dedupeKey,
          title: input.title,
          owner_agent: ownerAgent,
          target_agent_id: targetAgentId,
          proposed_action: payload.proposed_action,
          risk: payload.risk,
          source_type: input.sourceType || "service",
          source_id: input.sourceId || null,
        }),
      ],
    );

    return {
      id: String(inserted.rows[0].id),
      title: String(inserted.rows[0].title || input.title),
      status: String(inserted.rows[0].status),
      created: true,
      dedupe_key: dedupeKey,
    };
  });
}

export async function insertUsageLog(input: {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  taskId?: string | null;
}) {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.usage_logs (agent, date, model, input_tokens, output_tokens, cost_usd, task_id)
     VALUES ($1, current_date, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.agent, input.model, input.inputTokens, input.outputTokens, input.costUsd, input.taskId ?? null],
  );
  return rows[0];
}

export async function patchAgentWorkItem(id: string, body: JsonRecord) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(`SELECT * FROM public.work_items WHERE id = $1 LIMIT 1`, [id]);
    const existing = existingRes.rows[0];
    if (!existing) return null;

    const status = typeof body.status === "string" ? body.status : null;
    const result = body.result;
    const output = body.output;
    const scheduledFor = typeof body.scheduled_for === "string" || body.scheduled_for === null ? body.scheduled_for : undefined;
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
    if (status === "done" || status === "failed") updates.completed_at = new Date();
    if (scheduledFor !== undefined) updates.scheduled_for = scheduledFor;
    if (result) updates.instruction = `${existing.instruction || ""}\n\nResult:\n${String(result)}`.trim();

    let nextPayload: JsonRecord | null = null;
    if (output !== undefined) nextPayload = { ...(existing.payload || {}), output };
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

    const updateSql = `
      UPDATE public.work_items
      SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(", ")}
      WHERE id = $${values.length}
      RETURNING ${WORK_ITEM_COLUMNS}
    `;
    const updated = await client.query(updateSql, values);
    const row = updated.rows[0];

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
          current_url: typeof body.current_url === "string" ? body.current_url : null,
          scheduled_for: scheduledFor,
        }),
      ],
    );

    return normalizeRow(row);
  });
}
