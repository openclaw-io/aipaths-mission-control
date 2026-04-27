import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

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

type ProjectRow = {
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

function buildNormalizedProject(project: ProjectRow) {
  const rawInput = cleanText(
    getMetadataString(project.metadata, "raw_input") ||
      project.description ||
      project.summary ||
      project.name ||
      ""
  );

  const intent = classifyIntent(rawInput);
  const lowered = rawInput.toLowerCase();

  let normalizedName = sentenceCase(rawInput);
  let summary = rawInput;
  let description = `Requested outcome: ${sentenceCase(rawInput)}.`;
  let clarityScore = 0.72;
  let clarificationQuestions: ClarificationQuestion[] = [];
  let plan: PlanStep[] = buildGenericPlan(rawInput || "this project");

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
    normalizedName = "Audit project workflow and legacy behavior";
    summary = "Audit the current project flow, identify legacy behavior, and propose cleanups.";
    description = "Review the current project workflow end to end, validate where the code or UX still behaves like legacy logic, and recommend the next cleanup or fix pass.";
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
    priority: project.priority || "medium",
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

  const supabase = createServiceClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, status, key, name, summary, description, priority, metadata, plan, clarification_questions")
    .eq("status", "planning")
    .order("updated_at", { ascending: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let promoted = 0;
  let clarified = 0;
  const details: Array<{ projectId: string; action: string }> = [];

  for (const project of (projects || []) as ProjectRow[]) {
    const hasOpenQuestions = (project.clarification_questions || []).some((q) => (q.status || "open") === "open");
    if (hasOpenQuestions) {
      details.push({ projectId: project.id, action: "waiting_for_clarification" });
      continue;
    }

    const metadata = (project.metadata || {}) as JsonObject;
    const alreadyNormalized = typeof metadata.normalized_at === "string" || typeof metadata.interpreted_title === "string";
    const hasMeaningfulPlan = Array.isArray(project.plan) && project.plan.length > 0;
    const hasMeaningfulName = cleanText(project.name).length > 0 && !/^new project$/i.test(cleanText(project.name));
    const hasMeaningfulSummary = cleanText(project.summary).length > 0;

    if (alreadyNormalized && (hasMeaningfulPlan || hasMeaningfulName || hasMeaningfulSummary)) {
      details.push({ projectId: project.id, action: "already_normalized_skipped" });
      continue;
    }

    const normalized = buildNormalizedProject(project);
    const now = new Date().toISOString();
    const nextStatus = normalized.needsClarification ? "needs_clarification" : "needs_approval";

    const { error: updateError } = await supabase
      .from("projects")
      .update({
        name: normalized.normalizedName,
        summary: normalized.summary,
        description: normalized.description,
        priority: normalized.priority,
        status: nextStatus,
        plan: normalized.needsClarification ? [] : normalized.plan,
        clarification_questions: normalized.needsClarification ? normalized.clarificationQuestions : [],
        metadata: {
          ...(project.metadata || {}),
          raw_input: normalized.rawInput,
          clarity_score: normalized.clarityScore,
          normalized_at: now,
          normalized_by: "project-planner",
          interpreted_title: normalized.normalizedName,
          interpreted_summary: normalized.summary,
          intent_type: normalized.intent,
        },
        updated_at: now,
      })
      .eq("id", project.id)
      .eq("status", "planning");

    if (updateError) {
      details.push({ projectId: project.id, action: `error:${updateError.message}` });
      continue;
    }

    if (normalized.needsClarification) {
      await supabase.from("project_events").insert({
        project_id: project.id,
        event_type: "project.clarification_requested",
        from_status: "planning",
        to_status: "needs_clarification",
        actor: "project-planner",
        payload: {
          clarity_score: normalized.clarityScore,
          source: "intent_based_normalization",
          intent_type: normalized.intent,
        },
        created_at: now,
      });
      clarified++;
      details.push({ projectId: project.id, action: "normalized_and_requested_clarification" });
      continue;
    }

    await supabase.from("project_events").insert({
      project_id: project.id,
      event_type: "project.ready_for_approval",
      from_status: "planning",
      to_status: "needs_approval",
      actor: "project-planner",
      payload: {
        clarity_score: normalized.clarityScore,
        source: "intent_based_normalization",
        intent_type: normalized.intent,
      },
      created_at: now,
    });

    promoted++;
    details.push({ projectId: project.id, action: `normalized_${normalized.intent}_project_and_promoted` });
  }

  return NextResponse.json({ promoted, clarified, details });
}
