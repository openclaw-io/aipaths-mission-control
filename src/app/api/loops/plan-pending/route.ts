import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type ClarificationQuestion = {
  id: string;
  question: string;
  status: string;
};

type PlanStep = {
  id: string;
  title: string;
  status: string;
  notes: string | null;
};

type LoopRow = {
  id: string;
  status: string;
  key: string | null;
  name: string | null;
  summary: string | null;
  description: string | null;
  priority: string | null;
  metadata: JsonObject | null;
  plan: PlanStep[] | null;
  clarification_questions: ClarificationQuestion[] | null;
};

function cleanText(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function sentenceCase(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getMetadataString(metadata: JsonObject | null, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function buildCommunicationPlan(target: string): PlanStep[] {
  return [
    { id: "step-1", title: `Draft the message for ${target}`, status: "pending", notes: null },
    { id: "step-2", title: "Send the message through the right shared channel", status: "pending", notes: null },
    { id: "step-3", title: "Confirm delivery and summarize the result", status: "pending", notes: null },
  ];
}

function buildAuditPlan(): PlanStep[] {
  return [
    { id: "step-1", title: "Inspect the current flow and identify legacy or broken behavior", status: "pending", notes: null },
    { id: "step-2", title: "Document concrete issues, edge cases, and cleanup opportunities", status: "pending", notes: null },
    { id: "step-3", title: "Propose the fixes and the recommended next implementation pass", status: "pending", notes: null },
  ];
}

function buildImplementationPlan(): PlanStep[] {
  return [
    { id: "step-1", title: "Define the change clearly and inspect the affected system surface", status: "pending", notes: null },
    { id: "step-2", title: "Implement the requested change", status: "pending", notes: null },
    { id: "step-3", title: "Validate the result and summarize what changed", status: "pending", notes: null },
  ];
}

function buildGenericPlan(summary: string): PlanStep[] {
  return [
    { id: "step-1", title: `Clarify the exact target outcome for ${summary.slice(0, 56)}`, status: "pending", notes: null },
    { id: "step-2", title: "Carry out the core work", status: "pending", notes: null },
    { id: "step-3", title: "Review the outcome and report back", status: "pending", notes: null },
  ];
}

function pendingPlanReworkContext(metadata: JsonObject) {
  const context = metadata.plan_rework_context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  return context.status === "pending" ? context as JsonObject : null;
}

type PlanReworkOperation = {
  type: "append_step";
  step_id: string;
  title: string;
};

function parsePlanReworkOperation(plan: PlanStep[], feedback: string): PlanReworkOperation | null {
  const normalized = cleanText(feedback).replace(/[.!?]+$/, "");
  const english = normalized.match(/^add\s+(?:an?\s+)?(?:explicit\s+)?(.+?)\s+step$/i);
  const spanish = normalized.match(/^(?:agrega|añade|incorpora)\s+(?:un\s+)?paso\s+(?:expl[ií]cito\s+)?(?:para\s+)?(.+)$/i);
  const rawTitle = cleanText(english?.[1] || spanish?.[1] || "");
  if (!rawTitle) return null;

  let suffix = plan.length + 1;
  const existingIds = new Set(plan.map((step) => step.id));
  while (existingIds.has(`plan-rework-${suffix}`)) suffix += 1;
  return {
    type: "append_step",
    step_id: `plan-rework-${suffix}`,
    title: sentenceCase(rawTitle),
  };
}

function revisePlanForOperation(plan: PlanStep[], operation: PlanReworkOperation): PlanStep[] {
  const reopened = plan.map((step) => ({ ...step, status: "pending" }));
  return [
    ...reopened,
    {
      id: operation.step_id,
      title: operation.title,
      status: "pending",
      notes: null,
    },
  ];
}

function planContainsAppliedOperation(plan: PlanStep[], operation: PlanReworkOperation) {
  return plan.some((step) => step.id === operation.step_id
    && step.title === operation.title
    && step.status === "pending");
}

function classifyIntent(input: string) {
  const lowered = input.toLowerCase();

  if (/(auditoria|auditor[ií]a|diagnostico|diagnóstico|validar|revisar|edge case|legacy|emprolijar|cleanup|bug|error|reload|server error|this page couldn.?t load|mission control se me bugea|se reinicia)/.test(lowered)) {
    return "audit" as const;
  }

  if (/(crear|armar|hacer|implementar|build|fix|resolver|cambiar)/.test(lowered)) {
    return "implementation" as const;
  }

  if (/(mensaje|mandar|enviar|discord|canal|channel|avisar|announce|postear)/.test(lowered)) {
    return "communication" as const;
  }

  return "generic" as const;
}

function buildNormalizedLoop(loop: LoopRow) {
  const rawInput = cleanText(
    getMetadataString(loop.metadata, "raw_input") ||
      loop.description ||
      loop.summary ||
      loop.name ||
      ""
  );

  const intent = classifyIntent(rawInput);
  const lowered = rawInput.toLowerCase();

  let normalizedName = sentenceCase(rawInput);
  let summary = rawInput;
  let description = `Requested outcome: ${sentenceCase(rawInput)}.`;
  let clarityScore = 0.72;
  let clarificationQuestions: ClarificationQuestion[] = [];
  let plan: PlanStep[] = buildGenericPlan(rawInput || "this loop");

  if (intent === "communication") {
    const target = lowered.includes("discord") ? "the shared Discord channel" : "the requested channel";
    normalizedName = "Send message in shared Discord channel";
    summary = `Send a message through ${target}.`;
    description = `Write and send the requested message through ${target}, then confirm it was delivered.`;
    clarityScore = /(que diga|mensaje|decir|texto|simple tarea)/.test(lowered) ? 0.9 : 0.62;
    if (clarityScore < 0.75) {
      clarificationQuestions = [
        {
          id: "clarify-1",
          question: "What exact message should be sent in the shared Discord channel?",
          status: "open",
        },
      ];
    }
    plan = buildCommunicationPlan(target);
  } else if (intent === "audit") {
    normalizedName = "Audit loop workflow and legacy behavior";
    summary = "Audit the current loop flow, identify legacy behavior, and propose cleanups.";
    description = "Review the current loop workflow end to end, validate where the code or UX still behaves like legacy logic, and recommend the next cleanup or fix pass.";
    clarityScore = 0.84;
    plan = buildAuditPlan();
  } else if (intent === "implementation") {
    normalizedName = toTitleCase(rawInput.split(/[,.:]/)[0]).slice(0, 90) || "Implementation task";
    summary = sentenceCase(rawInput.length > 160 ? `${rawInput.slice(0, 157).trim()}...` : rawInput);
    description = `Implement the requested change: ${sentenceCase(rawInput)}.`;
    clarityScore = rawInput.length > 80 ? 0.8 : 0.68;
    if (clarityScore < 0.72) {
      clarificationQuestions = [
        {
          id: "clarify-1",
          question: "What outcome should count as done for this implementation request?",
          status: "open",
        },
      ];
    }
    plan = buildImplementationPlan();
  }

  return {
    rawInput,
    normalizedName,
    summary,
    description,
    priority: loop.priority || "medium",
    clarityScore,
    needsClarification: clarificationQuestions.length > 0,
    clarificationQuestions,
    plan,
    intent,
  };
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") || "";
  const expected = process.env.MISSION_CONTROL_API_KEY || process.env.AGENT_API_KEY || "";

  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows: loops } = await query<LoopRow>(`
    SELECT id, status, key, name, summary, description, priority, metadata, plan, clarification_questions
    FROM public.loops
    WHERE status = 'planning'
    ORDER BY updated_at ASC
    LIMIT 10
  `);

  let promoted = 0;
  let clarified = 0;
  const details: Array<{ loopId: string; action: string }> = [];

  for (const loop of (loops || []) as LoopRow[]) {
    const hasOpenQuestions = (loop.clarification_questions || []).some((q) => (q.status || "open") === "open");
    if (hasOpenQuestions) {
      details.push({ loopId: loop.id, action: "waiting_for_clarification" });
      continue;
    }

    const metadata = (loop.metadata || {}) as JsonObject;
    const alreadyNormalized = typeof metadata.normalized_at === "string" || typeof metadata.interpreted_title === "string";
    const hasMeaningfulPlan = Array.isArray(loop.plan) && loop.plan.length > 0;
    const hasMeaningfulName = cleanText(loop.name).length > 0 && !/^new loop$/i.test(cleanText(loop.name));
    const hasMeaningfulSummary = cleanText(loop.summary).length > 0;

    if (alreadyNormalized && hasMeaningfulPlan) {
      try {
        const outcome = await withTransaction(async (client) => {
          // Re-read and lock before interpreting feedback. Every plan and metadata
          // decision below is derived from this locked snapshot, preventing two
          // planner invocations from consuming stale context or losing updates.
          const lockedResult = await client.query<LoopRow>(`
            SELECT id, status, key, name, summary, description, priority, metadata, plan, clarification_questions
              FROM public.loops
             WHERE id = $1
             LIMIT 1
             FOR UPDATE
          `, [loop.id]);
          const lockedLoop = lockedResult.rows[0];
          if (!lockedLoop || lockedLoop.status !== "planning") return { kind: "status_changed" as const };

          const lockedMetadata = (lockedLoop.metadata || {}) as JsonObject;
          const lockedAlreadyNormalized = typeof lockedMetadata.normalized_at === "string"
            || typeof lockedMetadata.interpreted_title === "string";
          const lockedPlan = Array.isArray(lockedLoop.plan) ? lockedLoop.plan : [];
          if (!lockedAlreadyNormalized || lockedPlan.length === 0) return { kind: "stale_outer_snapshot" as const };

          const clarificationHistory = Array.isArray(lockedMetadata.clarification_history)
            ? lockedMetadata.clarification_history
            : [];
          const latestClarification = clarificationHistory.at(-1);
          const latestResponse = latestClarification && typeof latestClarification === "object" && !Array.isArray(latestClarification)
            ? cleanText(String((latestClarification as JsonObject).response || "")).toLowerCase()
            : "";
          const explicitlyNotReady = Boolean(
            lockedMetadata.normalization_invalidated_at
            || lockedMetadata.manual_triage_reason
            || /desestim|cancel|descart|viejo|old/.test(latestResponse)
          );
          if (explicitlyNotReady) return { kind: "not_ready" as const };

          const now = new Date().toISOString();
          const storedPlanReworkContext = lockedMetadata.plan_rework_context;
          if (storedPlanReworkContext
            && typeof storedPlanReworkContext === "object"
            && !Array.isArray(storedPlanReworkContext)
            && storedPlanReworkContext.status === "needs_attention") {
            return { kind: "needs_attention" as const };
          }
          const planReworkContext = pendingPlanReworkContext(lockedMetadata);
          if (planReworkContext) {
            const feedback = typeof planReworkContext.feedback === "string"
              ? cleanText(planReworkContext.feedback)
              : "";
            const operation = parsePlanReworkOperation(lockedPlan, feedback);
            if (!operation) {
              const needsAttentionMetadata = {
                ...lockedMetadata,
                plan_rework_context: {
                  ...planReworkContext,
                  status: "needs_attention",
                  needs_attention_at: now,
                  needs_attention_reason: "unsupported_feedback_operation",
                  planner_revision_contract: "deterministic-plan-operations-v1",
                },
              };
              await client.query(`
                UPDATE public.loops
                   SET metadata = $1::jsonb,
                       updated_at = $2::timestamptz
                 WHERE id = $3
                   AND status = 'planning'
                 RETURNING id
              `, [JSON.stringify(needsAttentionMetadata), now, loop.id]);
              await client.query(`
                INSERT INTO public.loop_events
                  (loop_id, event_type, from_status, to_status, actor, payload, created_at)
                VALUES
                  ($1, 'loop.plan_rework_needs_attention', 'planning', 'planning', 'loop-planner', $2::jsonb, $3::timestamptz)
              `, [loop.id, JSON.stringify({
                source: "plan_rework_revision",
                reason: "unsupported_feedback_operation",
                feedback: feedback || null,
              }), now]);
              return { kind: "needs_attention" as const };
            }

            const revisedPlan = revisePlanForOperation(lockedPlan, operation);
            if (!planContainsAppliedOperation(revisedPlan, operation)) {
              throw new Error("plan_rework_operation_verification_failed");
            }
            const revisedMetadata = {
              ...lockedMetadata,
              plan_rework_context: {
                ...planReworkContext,
                status: "consumed",
                consumed_at: now,
                consumed_by: "loop-planner",
                planner_revision_contract: "deterministic-plan-operations-v1",
                applied_operations: [operation],
              },
            };
            const updateResult = await client.query(`
              UPDATE public.loops
                 SET status = 'needs_approval',
                     plan = $1::jsonb,
                     metadata = $2::jsonb,
                     updated_at = $3::timestamptz
               WHERE id = $4
                 AND status = 'planning'
               RETURNING id
            `, [JSON.stringify(revisedPlan), JSON.stringify(revisedMetadata), now, loop.id]);
            if (!updateResult.rows[0]) throw new Error("locked_plan_rework_update_failed");
            await client.query(`
              INSERT INTO public.loop_events
                (loop_id, event_type, from_status, to_status, actor, payload, created_at)
              VALUES
                ($1, 'loop.ready_for_approval', 'planning', 'needs_approval', 'loop-planner', $2::jsonb, $3::timestamptz)
            `, [loop.id, JSON.stringify({
              source: "plan_rework_revision",
              guarded: true,
              feedback: feedback || null,
              applied_operations: [operation],
            }), now]);
            return { kind: "promoted_rework" as const };
          }

          const updateResult = await client.query(`
            UPDATE public.loops
               SET status = 'needs_approval',
                   updated_at = $1::timestamptz
             WHERE id = $2
               AND status = 'planning'
             RETURNING id
          `, [now, loop.id]);
          if (!updateResult.rows[0]) throw new Error("locked_plan_promotion_failed");
          await client.query(`
            INSERT INTO public.loop_events
              (loop_id, event_type, from_status, to_status, actor, payload, created_at)
            VALUES
              ($1, 'loop.ready_for_approval', 'planning', 'needs_approval', 'loop-planner', $2::jsonb, $3::timestamptz)
          `, [loop.id, JSON.stringify({ source: "explicit_plan_pending_promotion", guarded: true }), now]);
          return { kind: "promoted_existing" as const };
        });

        if (outcome.kind === "promoted_rework" || outcome.kind === "promoted_existing") {
          promoted++;
          details.push({
            loopId: loop.id,
            action: outcome.kind === "promoted_rework"
              ? "plan_rework_consumed_and_promoted"
              : "already_planned_and_promoted",
          });
        } else if (outcome.kind === "needs_attention") {
          details.push({ loopId: loop.id, action: "plan_rework_needs_attention" });
        } else if (outcome.kind === "not_ready") {
          details.push({ loopId: loop.id, action: "already_normalized_not_ready" });
        } else {
          details.push({ loopId: loop.id, action: "skipped_status_changed" });
        }
      } catch (updateError) {
        details.push({ loopId: loop.id, action: `error:${updateError instanceof Error ? updateError.message : "update_failed"}` });
      }
      continue;
    }

    if (alreadyNormalized && (hasMeaningfulName || hasMeaningfulSummary)) {
      details.push({ loopId: loop.id, action: "already_normalized_skipped" });
      continue;
    }

    const normalized = buildNormalizedLoop(loop);
    const now = new Date().toISOString();
    const nextStatus = normalized.needsClarification ? "needs_clarification" : "needs_approval";

    try {
      const eventType = normalized.needsClarification
        ? "loop.clarification_requested"
        : "loop.ready_for_approval";

      const updated = await withTransaction(async (client) => {
        const metadata = {
          ...(loop.metadata || {}),
          raw_input: normalized.rawInput,
          clarity_score: normalized.clarityScore,
          normalized_at: now,
          normalized_by: "loop-planner",
          interpreted_title: normalized.normalizedName,
          interpreted_summary: normalized.summary,
          intent_type: normalized.intent,
        };

        const updateResult = await client.query(`
          UPDATE public.loops
          SET name = $1,
              summary = $2,
              description = $3,
              priority = $4,
              status = $5,
              plan = $6::jsonb,
              clarification_questions = $7::jsonb,
              metadata = $8::jsonb,
              updated_at = $9::timestamptz
          WHERE id = $10
            AND status = 'planning'
          RETURNING id
        `, [
          normalized.normalizedName,
          normalized.summary,
          normalized.description,
          normalized.priority,
          nextStatus,
          JSON.stringify(normalized.needsClarification ? [] : normalized.plan),
          JSON.stringify(normalized.needsClarification ? normalized.clarificationQuestions : []),
          JSON.stringify(metadata),
          now,
          loop.id,
        ]);

        if (!updateResult.rows[0]) return false;

        await client.query(`
          INSERT INTO public.loop_events (loop_id, event_type, from_status, to_status, actor, payload, created_at)
          VALUES ($1, $2, 'planning', $3, 'loop-planner', $4::jsonb, $5::timestamptz)
        `, [
          loop.id,
          eventType,
          nextStatus,
          JSON.stringify({
            clarity_score: normalized.clarityScore,
            source: "intent_based_normalization",
            intent_type: normalized.intent,
          }),
          now,
        ]);

        return true;
      });

      if (!updated) {
        details.push({ loopId: loop.id, action: "skipped_status_changed" });
        continue;
      }
    } catch (updateError) {
      details.push({ loopId: loop.id, action: `error:${updateError instanceof Error ? updateError.message : "update_failed"}` });
      continue;
    }

    if (normalized.needsClarification) {
      clarified++;
      details.push({ loopId: loop.id, action: "normalized_and_requested_clarification" });
      continue;
    }
    promoted++;
    details.push({ loopId: loop.id, action: `normalized_${normalized.intent}_loop_and_promoted` });
  }

  return NextResponse.json({ promoted, clarified, details });
}
