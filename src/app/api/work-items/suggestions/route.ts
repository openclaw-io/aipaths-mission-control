import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createDedupedSuggestion, type WorkItemSuggestionInput } from "@/lib/work-items/suggestions";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSuggestion(value: unknown): WorkItemSuggestionInput | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const instruction = typeof value.instruction === "string" ? value.instruction.trim() : "";
  const dedupeKey = typeof value.dedupeKey === "string"
    ? value.dedupeKey.trim()
    : typeof value.dedupe_key === "string"
      ? value.dedupe_key.trim()
      : "";
  if (!title || !instruction || !dedupeKey) return null;

  return {
    title,
    instruction,
    dedupeKey,
    ownerAgent: typeof value.ownerAgent === "string" ? value.ownerAgent : typeof value.owner_agent === "string" ? value.owner_agent : undefined,
    targetAgentId: typeof value.targetAgentId === "string" ? value.targetAgentId : typeof value.target_agent_id === "string" ? value.target_agent_id : undefined,
    requestedBy: typeof value.requestedBy === "string" ? value.requestedBy : typeof value.requested_by === "string" ? value.requested_by : undefined,
    priority: typeof value.priority === "string" ? value.priority : undefined,
    risk: value.risk === "low" || value.risk === "medium" || value.risk === "high" ? value.risk : undefined,
    proposedAction: typeof value.proposedAction === "string" ? value.proposedAction : typeof value.proposed_action === "string" ? value.proposed_action : undefined,
    approvalPrompt: typeof value.approvalPrompt === "string" ? value.approvalPrompt : typeof value.approval_prompt === "string" ? value.approval_prompt : undefined,
    sourceType: typeof value.sourceType === "string" ? value.sourceType : typeof value.source_type === "string" ? value.source_type : undefined,
    sourceId: typeof value.sourceId === "string" ? value.sourceId : typeof value.source_id === "string" ? value.source_id : undefined,
    kind: typeof value.kind === "string" ? value.kind : undefined,
    status: value.status === "blocked" ? "blocked" : "draft",
    scheduledFor: typeof value.scheduledFor === "string" || value.scheduledFor === null ? value.scheduledFor : typeof value.scheduled_for === "string" || value.scheduled_for === null ? value.scheduled_for : undefined,
    payload: isRecord(value.payload) ? value.payload : undefined,
  };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body: unknown = await req.json().catch(() => null);
  const rawSuggestions: unknown[] = isRecord(body) && Array.isArray(body.suggestions) ? body.suggestions : [body];
  const suggestions = rawSuggestions.map((suggestion: unknown) => normalizeSuggestion(suggestion));

  if (suggestions.some((suggestion) => !suggestion)) {
    return NextResponse.json({ error: "Each suggestion requires title, instruction, and dedupeKey/dedupe_key" }, { status: 400 });
  }

  try {
    const results = [];
    for (const suggestion of suggestions as WorkItemSuggestionInput[]) {
      results.push(await createDedupedSuggestion(supabaseAdmin, suggestion));
    }
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "suggestion_create_failed" }, { status: 500 });
  }
}
