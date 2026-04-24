import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function checkAuth(req: NextRequest): boolean {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { status, result, output, current_url, published_at } = body;

  const validStatuses = ["draft", "ready", "blocked", "in_progress", "done", "failed", "canceled"];
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from("work_items")
    .select("*")
    .eq("id", id)
    .single();

  if (existingError || !existing) {
    return NextResponse.json({ error: existingError?.message || "Work item not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status) updates.status = status;
  if (status === "in_progress") updates.started_at = new Date().toISOString();
  if (status === "done") updates.completed_at = new Date().toISOString();
  if (status === "failed") updates.completed_at = new Date().toISOString();
  if (result) updates.instruction = `${existing.instruction || ""}\n\nResult:\n${String(result)}`.trim();
  if (output) updates.payload = { ...(existing.payload || {}), output };

  const { data, error } = await db
    .from("work_items")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload = data.payload || {};
  if (status === "done" && payload.pipeline_type === "blog" && payload.pipeline_item_id) {
    const pipelineItemId = payload.pipeline_item_id as string;

    if (payload.action === "localize_blog_to_en") {
      const { data: pipelineItem } = await db
        .from("pipeline_items")
        .select("metadata, title, priority")
        .eq("id", pipelineItemId)
        .single();

      await db
        .from("pipeline_items")
        .update({
          status: "scheduled",
          metadata: {
            ...(pipelineItem?.metadata || {}),
            localization: {
              ...(((pipelineItem?.metadata || {}) as any).localization || {}),
              en_ready: true,
              translated_at: new Date().toISOString(),
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", pipelineItemId);

      const { data: publishWorkItem } = await db
        .from("work_items")
        .insert({
          kind: "task",
          source_type: "service",
          source_id: pipelineItemId,
          title: `Publish blog: ${pipelineItem?.title || existing.title}`,
          instruction: [
            `Pipeline blog item: ${pipelineItem?.title || existing.title}`,
            "",
            "Task:",
            "- Publish the blog to the website",
            "- When done, update the work item with current_url and optional notes",
            "- Mission Control will mark the pipeline item live and store published_at/current_url",
          ].join("\n"),
          status: "draft",
          priority: pipelineItem?.priority || existing.priority || "medium",
          owner_agent: "dev",
          requested_by: existing.requested_by,
          payload: {
            trigger: "work_item_completion",
            pipeline_type: "blog",
            pipeline_item_id: pipelineItemId,
            action: "publish_blog",
          },
        })
        .select("id")
        .single();

      if (publishWorkItem?.id && process.env.AGENT_API_KEY) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
        await fetch(`${baseUrl}/api/work-items/notify`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workItemId: publishWorkItem.id, agent: "dev", title: pipelineItem?.title || existing.title, action: "created" }),
        }).catch(() => {});
      }
    }

    if (payload.action === "publish_blog") {
      await db
        .from("pipeline_items")
        .update({
          status: "live",
          published_at: published_at || new Date().toISOString(),
          current_url: current_url || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pipelineItemId);
    }
  }

  await db.from("event_log").insert({
    domain: "work",
    event_type: `work_item.${status || 'updated'}`,
    entity_type: "work_item",
    entity_id: data.id,
    actor: data.owner_agent || "unknown",
    payload: {
      status: data.status,
      requested_by: data.requested_by,
      source_type: data.source_type,
      source_id: data.source_id,
      pipeline_type: payload.pipeline_type,
      pipeline_item_id: payload.pipeline_item_id,
      action: payload.action,
      current_url: current_url || null,
    },
  });

  return NextResponse.json(data);
}
