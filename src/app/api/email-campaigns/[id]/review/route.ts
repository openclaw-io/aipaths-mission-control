import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { getPipelineItemLocal, updatePipelineItemLocal } from "@/lib/db/pipeline-local";
import {
  EmailCampaignLocalError,
  requestEmailChangesLocalAtomic,
  scheduleEmailCampaignLocalAtomic,
} from "@/lib/email-campaigns/local";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildRevisionInstruction(input: {
  title: string;
  feedback: string;
  kind: string | null;
  currentDraft: JsonRecord;
}) {
  return [
    `Email campaign pipeline item: ${input.title}`,
    `Campaign type: ${input.kind || "email_campaign"}`,
    "",
    "Task:",
    "- Rework the Spanish email draft using Gonza's feedback below.",
    "- Preserve what works, but produce a fresh improved version.",
    "- Do not send or schedule the email.",
    "- Complete this work item with output.email_draft containing: subject, preview_text, body_markdown.",
    "- Mission Control will move the email card to ready_for_review after completion.",
    "",
    "Feedback / corrections:",
    input.feedback,
    "",
    "Current draft JSON:",
    JSON.stringify(input.currentDraft, null, 2),
  ].join("\n");
}

function buildSendInstruction(input: {
  title: string;
  kind: string | null;
  scheduledFor: string;
  draft: JsonRecord;
  requiresYouTubeLiveGate?: boolean;
}) {
  return [
    `Email campaign pipeline item: ${input.title}`,
    `Campaign type: ${input.kind || "email_campaign"}`,
    `Scheduled for: ${input.scheduledFor}`,
    "",
    "Task:",
    "- Prepare/send this approved email campaign at the scheduled time using the current AIPaths email-send workflow.",
    "- Use only the approved draft below. Do not rewrite unless there is a blocking formatting issue.",
    "- If real sending infrastructure is not available yet, complete the work item as blocked/failed with the exact blocker; do not invent a send result.",
    ...(input.requiresYouTubeLiveGate ? [
      "- YouTube launch gate: before sending, verify privacyStatus=public/live and that Gonza approved this campaign; block if not confirmed.",
    ] : []),
    "- When sent, complete this work item with output.sent_at and any provider/campaign URL or ID available.",
    "",
    "Approved draft JSON:",
    JSON.stringify(input.draft, null, 2),
  ].join("\n");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const useLocalMode = isLocalAuthDisabled();
  const supabase = useLocalMode ? null : await createClient();
  const db = useLocalMode ? null : createServiceClient();
  const actor = useLocalMode ? getLocalMissionControlUser() : null;
  let user: { email?: string | null; id?: string | null } | null = actor ? { email: actor.email, id: actor.email } : null;
  if (!useLocalMode) {
    const authResult = await supabase!.auth.getUser();
    user = authResult.data.user;
  }

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const actorIdentity = String(user.email || user.id || "local@mission-control");

  const body = await request.json().catch(() => ({}));
  const action = readString(body.action);
  const feedback = readString(body.feedback);
  const scheduledForInput = readString(body.scheduled_for) || readString(body.scheduledFor);

  if (useLocalMode && action === "request_changes") {
    if (!feedback) return NextResponse.json({ error: "feedback is required" }, { status: 400 });
    try {
      return NextResponse.json(await requestEmailChangesLocalAtomic({
        campaignId: id,
        feedback,
        actorIdentity,
      }));
    } catch (error) {
      if (error instanceof EmailCampaignLocalError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  if (useLocalMode && action === "schedule") {
    if (!scheduledForInput) return NextResponse.json({ error: "scheduled_for is required" }, { status: 400 });
    const scheduledTimestamp = Date.parse(scheduledForInput);
    if (Number.isNaN(scheduledTimestamp)) return NextResponse.json({ error: "scheduled_for must be a valid date" }, { status: 400 });
    try {
      return NextResponse.json(await scheduleEmailCampaignLocalAtomic({
        campaignId: id,
        scheduledFor: new Date(scheduledTimestamp).toISOString(),
        actorIdentity,
      }));
    } catch (error) {
      if (error instanceof EmailCampaignLocalError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  const item = useLocalMode
    ? await getPipelineItemLocal(id, "email_campaign")
    : await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .select("*")
          .eq("id", id)
          .eq("pipeline_type", "email_campaign")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!item) {
    return NextResponse.json({ error: "Email campaign not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const metadata = asObject(item.metadata);
  const draft = asObject(metadata.draft);
  const versions = Array.isArray(metadata.draft_versions) ? metadata.draft_versions : [];

  if (action === "request_changes") {
    if (!feedback) return NextResponse.json({ error: "feedback is required" }, { status: 400 });

    const revisionNumber = versions.length + 1;
    const workInput = {
      pipelineItemId: item.id,
      pipelineType: "email_campaign",
      title: `Rehacer email draft: ${item.title}`,
      instruction: buildRevisionInstruction({
        title: item.title,
        feedback,
        kind: readString(metadata.kind),
        currentDraft: draft,
      }),
      priority: item.priority || "medium",
      ownerAgent: "marketing",
      requestedBy: actorIdentity,
      relationType: `revise_email_draft_${revisionNumber}`,
      mapRelationType: "revise_email_draft",
      payloadRelationType: `revise_email_draft_${revisionNumber}`,
      action: "revise_email_draft",
      trigger: "email_campaign_review_changes_requested",
      reviewNotes: feedback,
      payloadExtra: {
        feedback,
        revision_number: revisionNumber,
        email_campaign_kind: readString(metadata.kind),
      },
    };
    const result = await createPipelineWorkItem(db!, workInput);

    const nextMetadata = {
      ...metadata,
      draft_versions: [
        ...versions,
        {
          version: revisionNumber,
          draft,
          feedback,
          requested_at: now,
          requested_by: actorIdentity,
          work_item_id: result.workItem.id,
        },
      ],
      review: {
        ...asObject(metadata.review),
        status: "changes_requested",
        feedback,
        last_requested_at: now,
        last_requested_by: actorIdentity,
        revision_work_item_id: result.workItem.id,
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "changes_requested",
        last_work_item_id: result.workItem.id,
        updated_at: now,
      },
    };

    const updated = await (async () => {
      const { data, error } = await db!
        .from("pipeline_items")
        .update({ status: "drafting", metadata: nextMetadata, updated_at: now })
        .eq("id", item.id)
        .select("id,title,status,metadata,updated_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    })().catch(() => null);

    if (!updated) return NextResponse.json({ error: "Failed to update email campaign" }, { status: 500 });

    return NextResponse.json({ item: updated, workItem: result.workItem });
  }

  if (action === "approve") {
    const nextMetadata = {
      ...metadata,
      review: {
        ...asObject(metadata.review),
        status: "approved",
        approved_at: now,
        approved_by: actorIdentity,
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "approved",
        updated_at: now,
      },
    };

    const updated = useLocalMode
      ? await updatePipelineItemLocal(item.id, { status: "approved", metadata: nextMetadata, updated_at: now })
      : await (async () => {
          const { data, error } = await db!
            .from("pipeline_items")
            .update({ status: "approved", metadata: nextMetadata, updated_at: now })
            .eq("id", item.id)
            .select("id,title,status,metadata,updated_at")
            .single();
          if (error) throw new Error(error.message);
          return data;
        })().catch(() => null);

    if (!updated) return NextResponse.json({ error: "Failed to approve email campaign" }, { status: 500 });

    return NextResponse.json({ item: updated });
  }

  if (action === "schedule") {
    if (!scheduledForInput) return NextResponse.json({ error: "scheduled_for is required" }, { status: 400 });
    const scheduledTimestamp = Date.parse(scheduledForInput);
    if (Number.isNaN(scheduledTimestamp)) return NextResponse.json({ error: "scheduled_for must be a valid date" }, { status: 400 });
    const scheduledFor = new Date(scheduledTimestamp).toISOString();

    const workInput = {
      pipelineItemId: item.id,
      pipelineType: "email_campaign",
      title: `Send email campaign: ${item.title}`,
      instruction: buildSendInstruction({
        title: item.title,
        kind: readString(metadata.kind),
        scheduledFor,
        draft,
        requiresYouTubeLiveGate: readString(metadata.kind) === "video_announcement" || readString(asObject(metadata.source).video_id) !== null,
      }),
      priority: item.priority || "medium",
      ownerAgent: "marketing",
      requestedBy: actorIdentity,
      relationType: "send_email_campaign",
      action: "send_email_campaign",
      trigger: "email_campaign_scheduled",
      scheduledFor,
      payloadExtra: {
        email_campaign_kind: readString(metadata.kind),
        schedule_kind: "email_send",
        ...(readString(metadata.kind) === "video_announcement" || readString(asObject(metadata.source).video_id) !== null ? {
          public_gate_applies_to: "publish_or_send_only",
          requires_live_check_passed: true,
          requires_gonza_approval: true,
          source_video_id: readString(asObject(metadata.source).video_id),
        } : {}),
      },
    };
    const result = await createPipelineWorkItem(db!, workInput);

    // If an open send work item already existed, createPipelineWorkItem dedupes it;
    // keep its schedule/instructions aligned with the latest selected date.
    await db!
      .from("work_items")
      .update({
        title: `Send email campaign: ${item.title}`,
        instruction: buildSendInstruction({
          title: item.title,
          kind: readString(metadata.kind),
          scheduledFor,
          draft,
          requiresYouTubeLiveGate: readString(metadata.kind) === "video_announcement" || readString(asObject(metadata.source).video_id) !== null,
        }),
        scheduled_for: scheduledFor,
        status: result.workItem.status === "in_progress" ? "in_progress" : "ready",
        updated_at: now,
      })
      .eq("id", result.workItem.id);

    const nextMetadata = {
      ...metadata,
      schedule: {
        ...asObject(metadata.schedule),
        scheduled_for: scheduledFor,
        scheduled_at: now,
        scheduled_by: actorIdentity,
        send_work_item_id: result.workItem.id,
      },
      runtime_feedback: {
        ...asObject(metadata.runtime_feedback),
        last_status: "scheduled",
        last_work_item_id: result.workItem.id,
        updated_at: now,
      },
    };

    const updated = await (async () => {
      const { data, error } = await db!
        .from("pipeline_items")
        .update({ status: "scheduled", scheduled_for: scheduledFor, metadata: nextMetadata, updated_at: now })
        .eq("id", item.id)
        .select("id,title,status,scheduled_for,metadata,updated_at")
        .single();
      if (error) throw new Error(error.message);
      return data;
    })().catch(() => null);

    if (!updated) return NextResponse.json({ error: "Failed to schedule email campaign" }, { status: 500 });

    return NextResponse.json({ item: updated, workItem: { ...result.workItem, scheduled_for: scheduledFor } });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
