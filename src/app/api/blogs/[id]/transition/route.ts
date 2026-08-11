import type { PoolClient } from "pg";
import { NextResponse, type NextRequest } from "next/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { createPipelineWorkItemLocal, getPipelineItemLocal, updatePipelineItemLocal, withLockedPipelineItemLocal } from "@/lib/db/pipeline-local";
import { resolvePublicationSlotLocal } from "@/lib/publication/scheduling-local";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { createPipelineWorkItem } from "@/lib/work-items/pipeline-materializer";
import { resolvePublicationSlot } from "@/lib/publication/scheduling";

export const dynamic = "force-dynamic";

const BLOG_STATUSES = [
  "draft",
  "parked",
  "rejected",
  "researching",
  "ready_for_review",
  "changes_requested",
  "approved",
  "localizing",
  "final_check",
  "scheduled",
  "live",
  "archived",
] as const;

type BlogTransitionItem = Record<string, unknown> & {
  id: string;
  title: string;
  priority?: string | null;
  scheduled_for?: string | null;
  metadata?: Record<string, unknown> | null;
};

const ACTION_TARGET: Record<string, string> = {
  promote: "researching",
  park: "parked",
  unpark: "draft",
  reject: "rejected",
  approve: "localizing",
  approve_final: "scheduled",
  request_final_changes: "localizing",
  request_changes: "changes_requested",
  move_to_review: "ready_for_review",
  mark_scheduled: "scheduled",
  mark_live: "live",
  archive: "archived",
};

const ALLOWED: Record<string, string[]> = {
  draft: ["parked", "rejected", "researching"],
  parked: ["draft", "rejected", "researching"],
  researching: ["ready_for_review", "parked", "rejected"],
  ready_for_review: ["changes_requested", "localizing", "rejected"],
  changes_requested: ["ready_for_review", "rejected"],
  localizing: ["final_check", "scheduled", "ready_for_review"],
  final_check: ["scheduled", "localizing", "rejected"],
  scheduled: ["live"],
  live: ["archived"],
};

function createWorkItemTitle(action: string, title: string) {
  switch (action) {
    case "promote":
      return `Develop blog draft: ${title}`;
    case "request_changes":
      return `Revise blog draft: ${title}`;
    case "approve":
      return `Localize blog to EN: ${title}`;
    case "request_final_changes":
      return `Finalize blog package: ${title}`;
    default:
      return `Work on blog: ${title}`;
  }
}

function createWorkItemInstruction(action: string, item: { title: string }, reviewNotes?: string) {
  switch (action) {
    case "promote":
      return [
        `Pipeline blog item: ${item.title}`,
        "",
        "Task:",
        "- Review the source material and cited sources",
        "- Research the story further and improve the framing",
        "- Produce a real blog draft suitable for editorial review",
        "- When ready, move the pipeline item to ready_for_review",
      ].join("\n");
    case "request_changes":
      return [
        `Pipeline blog item: ${item.title}`,
        "",
        "Task:",
        "- Revise the blog draft based on editorial feedback",
        "- When ready, move the pipeline item back to ready_for_review",
        "",
        "Review notes:",
        reviewNotes || "(missing)",
      ].join("\n");
    case "approve":
      return [
        `Pipeline blog item: ${item.title}`,
        "",
        "Task:",
        "- Create the English translation/localized version of the approved blog",
        "- Preserve meaning and quality, not just literal translation",
        "- Generate or prepare a clean hero/thumbnail candidate for the blog",
        "- Store final-package details in the pipeline item metadata when possible: localization.en and hero_image",
        "- When localization and thumbnail are complete, complete this work item; Mission Control will move the pipeline item to final_check",
      ].join("\n");
    case "request_final_changes":
      return [
        `Pipeline blog item: ${item.title}`,
        "",
        "Task:",
        "- Revise the final publication package based on the final-check feedback",
        "- Check the English translation/localized version",
        "- Check or regenerate the blog hero/thumbnail candidate",
        "- When ready, complete this work item; Mission Control will move the pipeline item back to final_check",
        "",
        "Final-check notes:",
        reviewNotes || "(missing)",
      ].join("\n");
    default:
      return `Work on blog item: ${item.title}`;
  }
}

async function notifyWorkItem(id: string, agent: string, title: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) return;

  await fetch(`${baseUrl}/api/work-items/notify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workItemId: id, agent, title, action: "created" }),
  }).catch((err) => {
    console.error("[blogs.transition] Failed to notify work item", err);
  });
}

function getNestedString(source: unknown, path: string[]) {
  let current = source as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    const next = current[key];
    if (typeof next === "string" && key === path[path.length - 1]) return next.trim() || null;
    current = next as Record<string, unknown> | undefined;
  }
  return null;
}

async function resolveBlogPublishSchedule(db: ReturnType<typeof createServiceClient>, item: BlogTransitionItem) {
  const metadata = item.metadata || {};
  const explicitScheduledFor =
    getNestedString(metadata, ["final_check", "scheduled_for"]) ||
    getNestedString(metadata, ["final_package", "publish_assets", "scheduled_for"]);

  return resolvePublicationSlot(db, {
    explicitScheduledFor,
    existingScheduledFor: item.scheduled_for || getNestedString(metadata, ["schedule", "scheduled_for"]),
    pipelineItemId: item.id,
  });
}

async function resolveBlogPublishScheduleLocal(item: BlogTransitionItem, client?: Pick<PoolClient, "query">) {
  const metadata = item.metadata || {};
  const explicitScheduledFor =
    getNestedString(metadata, ["final_check", "scheduled_for"]) ||
    getNestedString(metadata, ["final_package", "publish_assets", "scheduled_for"]);

  return resolvePublicationSlotLocal({
    explicitScheduledFor,
    existingScheduledFor: item.scheduled_for || getNestedString(metadata, ["schedule", "scheduled_for"]),
    pipelineItemId: item.id,
    client,
  });
}

function createPublishInstruction(item: BlogTransitionItem) {
  const metadata = item.metadata || {};
  const slug = typeof item.slug === "string" ? item.slug : null;
  const heroPath =
    getNestedString(metadata, ["hero_image", "media_path"]) ||
    getNestedString(metadata, ["hero_image", "local_path"]) ||
    getNestedString(metadata, ["hero_image", "url"]) ||
    getNestedString(metadata, ["cover_image", "url"]);
  const enSlug = getNestedString(metadata, ["localization", "en", "slug"]);

  return [
    `Pipeline blog item: ${item.title}`,
    `Pipeline item ID: ${item.id}`,
    slug ? `Blog slug/folder: ${slug}` : null,
    enSlug ? `EN slug: ${enSlug}` : null,
    heroPath ? `Approved hero/thumbnail source: ${heroPath}` : "Approved hero/thumbnail source: see pipeline metadata.hero_image",
    "",
    "Task:",
    "- Publish only the final-check approved blog package to the website.",
    "- Copy/store the approved hero image in the content repo standard path: public/images/blogs/[blog-folder]/hero.png.",
    "- Set frontmatter coverImage to the GitHub raw URL for that hero.png.",
    "- Use the approved Spanish copy, English localization, and hero/thumbnail from the pipeline item metadata/files.",
    "- When done, complete this work item with current_url and optional notes.",
    "- Mission Control will mark the pipeline item live and store published_at/current_url after verification.",
  ].filter(Boolean).join("\n");
}

async function ensurePublishWorkItem(db: ReturnType<typeof createServiceClient>, item: BlogTransitionItem, requestedBy: string, scheduledFor: string) {
  const { data: existingItems, error: existingError } = await db
    .from("work_items")
    .select("id, status, payload")
    .in("source_type", ["pipeline_item", "service"])
    .eq("source_id", item.id)
    .in("status", ["draft", "ready", "blocked", "in_progress"])
    .order("created_at", { ascending: false });

  if (existingError) throw existingError;

  const existingPublish = (existingItems || []).find((workItem: { payload?: Record<string, unknown> | null }) => {
    const payload = workItem.payload || {};
    return payload.action === "publish_blog" && payload.pipeline_item_id === item.id;
  });

  const publishPayload = {
    ...((existingPublish?.payload || {}) as Record<string, unknown>),
    trigger: "blog_final_check_approved",
    pipeline_type: "blog",
    pipeline_item_id: item.id,
    relation_type: "publish",
    action: "publish_blog",
    schedule_kind: "publication",
    dedupe_key: `${item.id}:publish_blog`,
  };

  if (existingPublish?.id) {
    const { data: updatedPublish, error: updatePublishError } = await db
      .from("work_items")
      .update({
        title: `Publish blog: ${item.title}`,
        instruction: createPublishInstruction(item),
        status: existingPublish.status === "in_progress" ? "in_progress" : "ready",
        scheduled_for: scheduledFor,
        priority: item.priority || "medium",
        owner_agent: "dev",
        target_agent_id: "dev",
        requested_by: requestedBy,
        payload: publishPayload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingPublish.id)
      .select("id, status, payload")
      .single();

    if (updatePublishError) throw updatePublishError;
    return updatedPublish;
  }

  const { data: publishWorkItem, error: insertError } = await db
    .from("work_items")
    .insert({
      kind: "task",
      source_type: "service",
      source_id: item.id,
      title: `Publish blog: ${item.title}`,
      instruction: createPublishInstruction(item),
      status: "ready",
      scheduled_for: scheduledFor,
      priority: item.priority || "medium",
      owner_agent: "dev",
      target_agent_id: "dev",
      requested_by: requestedBy,
      payload: publishPayload,
    })
    .select("id, status, payload")
    .single();

  if (insertError) throw insertError;

  const { error: mapError } = await db.from("pipeline_work_map").insert({
    pipeline_item_id: item.id,
    work_item_id: publishWorkItem.id,
    relation_type: "publish",
  });
  if (mapError && !String(mapError.message || "").includes("duplicate")) throw mapError;

  await db.from("event_log").insert({
    domain: "work",
    event_type: "work_item.publication_prepared",
    entity_type: "work_item",
    entity_id: publishWorkItem.id,
    actor: "blog-final-check",
    payload: {
      pipeline_type: "blog",
      pipeline_item_id: item.id,
      action: "publish_blog",
      scheduled_for: scheduledFor,
      dedupe_key: `${item.id}:publish_blog`,
    },
  });

  return publishWorkItem;
}

async function ensurePublishWorkItemLocal(
  client: Pick<PoolClient, "query">,
  item: BlogTransitionItem,
  requestedBy: string,
  scheduledFor: string,
) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`blog-publish:${item.id}`]);
  const existingRows = await client.query<{ id: string; status: string; payload: Record<string, unknown> | null }>(
    `select id, status, payload
       from work_items
      where source_type = any($1::text[])
        and source_id = $2
        and status = any($3::text[])
        and payload ->> 'action' = 'publish_blog'
      order by created_at desc
      limit 1`,
    [["pipeline_item", "service"], item.id, ["draft", "ready", "blocked", "in_progress"]],
  );
  const existingPublish = existingRows.rows[0];
  const publishPayload = {
    ...((existingPublish?.payload || {}) as Record<string, unknown>),
    trigger: "blog_final_check_approved",
    pipeline_type: "blog",
    pipeline_item_id: item.id,
    relation_type: "publish",
    action: "publish_blog",
    schedule_kind: "publication",
    dedupe_key: `${item.id}:publish_blog`,
  };

  let publishWorkItem: { id: string; status: string; payload: Record<string, unknown> | null };
  if (existingPublish?.id) {
    const updatedRows = await client.query<{ id: string; status: string; payload: Record<string, unknown> | null }>(
      `update work_items
          set title = $1, instruction = $2, status = $3, scheduled_for = $4,
              priority = $5, owner_agent = 'dev', target_agent_id = 'dev',
              requested_by = $6, payload = $7::jsonb, updated_at = $8
        where id = $9
        returning id, status, payload`,
      [
        `Publish blog: ${item.title}`,
        createPublishInstruction(item),
        existingPublish.status === "in_progress" ? "in_progress" : "ready",
        scheduledFor,
        item.priority || "medium",
        requestedBy,
        JSON.stringify(publishPayload),
        new Date().toISOString(),
        existingPublish.id,
      ],
    );
    publishWorkItem = updatedRows.rows[0];
  } else {
    const insertedRows = await client.query<{ id: string; status: string; payload: Record<string, unknown> | null }>(
      `insert into work_items (
         kind, source_type, source_id, title, instruction, status, scheduled_for,
         priority, owner_agent, target_agent_id, requested_by, payload
       ) values (
         'task', 'service', $1, $2, $3, 'ready', $4,
         $5, 'dev', 'dev', $6, $7::jsonb
       )
       returning id, status, payload`,
      [item.id, `Publish blog: ${item.title}`, createPublishInstruction(item), scheduledFor, item.priority || "medium", requestedBy, JSON.stringify(publishPayload)],
    );
    publishWorkItem = insertedRows.rows[0];
  }

  await client.query(
    `insert into pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     values ($1, $2, 'publish')
     on conflict (pipeline_item_id, work_item_id, relation_type) do nothing`,
    [item.id, publishWorkItem.id],
  );
  await client.query(
    `insert into event_log (domain, event_type, entity_type, entity_id, actor, payload)
     select 'work', 'work_item.publication_prepared', 'work_item', $1, 'blog-final-check', $2::jsonb
      where not exists (
        select 1 from event_log
         where event_type = 'work_item.publication_prepared'
           and entity_type = 'work_item'
           and entity_id = $1
           and payload ->> 'dedupe_key' = $3
      )`,
    [
      publishWorkItem.id,
      JSON.stringify({
        pipeline_type: "blog",
        pipeline_item_id: item.id,
        action: "publish_blog",
        scheduled_for: scheduledFor,
        dedupe_key: `${item.id}:publish_blog`,
      }),
      `${item.id}:publish_blog`,
    ],
  );
  return publishWorkItem;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { action, reviewNotes, current_url } = await request.json();
  const targetStatus = ACTION_TARGET[action];
  if (!targetStatus || !(BLOG_STATUSES as readonly string[]).includes(targetStatus)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const item = useLocalMode
    ? await getPipelineItemLocal(id, "blog")
    : await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .select("*")
          .eq("id", id)
          .eq("pipeline_type", "blog")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!item) {
    return NextResponse.json({ error: "Blog item not found" }, { status: 404 });
  }

  const allowedTargets = ALLOWED[item.status] || [];
  if (!allowedTargets.includes(targetStatus)) {
    return NextResponse.json({ error: `Action ${action} not allowed from ${item.status}` }, { status: 400 });
  }

  if (["request_changes", "request_final_changes"].includes(action) && (!reviewNotes || !String(reviewNotes).trim())) {
    return NextResponse.json({ error: "reviewNotes is required" }, { status: 400 });
  }

  const buildMetadata = (transitionItem: BlogTransitionItem) => ({
    ...(transitionItem.metadata || {}),
    ...(action === "request_changes"
      ? {
          review: {
            notes: String(reviewNotes).trim(),
            last_requested_at: new Date().toISOString(),
            last_requested_by: actorIdentity,
          },
        }
      : {}),
    ...(action === "request_final_changes"
      ? {
          final_check: {
            ...(((transitionItem.metadata || {}) as Record<string, unknown>).final_check as Record<string, unknown> | undefined || {}),
            status: "changes_requested",
            notes: String(reviewNotes).trim(),
            last_requested_at: new Date().toISOString(),
            last_requested_by: actorIdentity,
          },
        }
      : {}),
    ...(action === "approve_final"
      ? {
          final_check: {
            ...(((transitionItem.metadata || {}) as Record<string, unknown>).final_check as Record<string, unknown> | undefined || {}),
            status: "approved",
            approved_at: new Date().toISOString(),
            approved_by: actorIdentity,
          },
        }
      : {}),
  });
  const metadata = buildMetadata(item);

  if (useLocalMode) {
    try {
      const localResult = await withLockedPipelineItemLocal(id, ["blog"], async ({ client, item: lockedRow }) => {
        const lockedItem = lockedRow as unknown as BlogTransitionItem & { status: string; owner_agent?: string | null; updated_at?: string | null };
        if (String(lockedItem.updated_at || "") !== String(item.updated_at || "")) {
          throw new Error("Concurrent blog transition detected");
        }
        if (!(ALLOWED[lockedItem.status] || []).includes(targetStatus)) {
          throw new Error(`Action ${action} not allowed from ${lockedItem.status}`);
        }

        const localMetadata = buildMetadata(lockedItem);
        const localSchedule = action === "approve_final"
          ? await resolveBlogPublishScheduleLocal(lockedItem, client)
          : null;
        const localScheduledFor = localSchedule?.scheduledFor || null;
        const publishWorkItem = action === "approve_final" && localScheduledFor
          ? await ensurePublishWorkItemLocal(client, lockedItem, actorIdentity, localScheduledFor)
          : null;
        const localUpdatePayload: Record<string, unknown> = {
          status: targetStatus,
          owner_agent: action === "approve" ? "content" : lockedItem.owner_agent || "content",
          metadata: action === "approve_final" && localScheduledFor
            ? {
                ...localMetadata,
                schedule: {
                  ...((((localMetadata as unknown as Record<string, unknown>).schedule as Record<string, unknown> | undefined) || {})),
                  scheduled_for: localScheduledFor,
                  scheduled_at: new Date().toISOString(),
                  scheduled_by: actorIdentity,
                  source: localSchedule?.source || "auto_allocated",
                  publish_work_item_id: publishWorkItem?.id || null,
                },
                final_check: {
                  ...((localMetadata.final_check || {}) as Record<string, unknown>),
                  publish_work_item_id: publishWorkItem?.id || null,
                },
              }
            : localMetadata,
          updated_at: new Date().toISOString(),
        };
        if (action === "approve_final" && localScheduledFor) localUpdatePayload.scheduled_for = localScheduledFor;
        if (action === "mark_live") {
          localUpdatePayload.published_at = new Date().toISOString();
          localUpdatePayload.current_url = current_url || null;
        }

        const updatedItem = await updatePipelineItemLocal(id, localUpdatePayload, client);
        let notify: { id: string; agent: string; title: string } | null = null;
        if (["promote", "request_changes", "approve", "request_final_changes"].includes(action)) {
          const relationType = action === "promote" ? "investigate" : "followup";
          const actionName = action === "approve" || action === "request_final_changes"
            ? "localize_blog_to_en"
            : action === "promote" ? "develop_blog_draft" : "revise_blog_draft";
          const { workItem } = await createPipelineWorkItemLocal({
            pipelineItemId: lockedItem.id,
            pipelineType: "blog",
            title: createWorkItemTitle(action, lockedItem.title),
            instruction: createWorkItemInstruction(action, lockedItem, reviewNotes),
            priority: lockedItem.priority || "medium",
            ownerAgent: "content",
            requestedBy: actorIdentity,
            relationType,
            action: actionName,
            trigger: "manual_transition",
            reviewNotes: action === "request_changes" || action === "request_final_changes" ? String(reviewNotes).trim() : undefined,
          }, client);
          if (workItem?.id) notify = { id: workItem.id, agent: "content", title: lockedItem.title };
        }
        return { updatedItem, notify };
      });
      if (!localResult?.updatedItem) return NextResponse.json({ error: "Failed to update blog item" }, { status: 500 });
      if (localResult.notify) void notifyWorkItem(localResult.notify.id, localResult.notify.agent, localResult.notify.title);
      return NextResponse.json(localResult.updatedItem);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed local blog transition";
      return NextResponse.json({ error: message }, { status: message.startsWith("Concurrent") ? 409 : 500 });
    }
  }

  const publishSchedule = action === "approve_final"
    ? await resolveBlogPublishSchedule(db!, item)
    : null;
  const publishScheduledFor = publishSchedule?.scheduledFor || null;
  let publishWorkItemId: string | null = null;

  if (action === "approve_final" && publishScheduledFor) {
    try {
      const publishWorkItem = await ensurePublishWorkItem(db!, item, actorIdentity, publishScheduledFor);
      publishWorkItemId = publishWorkItem?.id || null;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create publish work item" }, { status: 500 });
    }
  }

  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    owner_agent: action === "approve" ? "content" : item.owner_agent || "content",
    metadata: action === "approve_final" && publishScheduledFor
      ? {
          ...metadata,
          schedule: {
            ...((((metadata as unknown as Record<string, unknown>).schedule as Record<string, unknown> | undefined) || {})),
            scheduled_for: publishScheduledFor,
            scheduled_at: new Date().toISOString(),
            scheduled_by: actorIdentity,
            source: publishSchedule?.source || "auto_allocated",
            publish_work_item_id: publishWorkItemId,
          },
          final_check: {
            ...(((metadata.final_check || {}) as Record<string, unknown>)),
            publish_work_item_id: publishWorkItemId,
          },
        }
      : metadata,
    updated_at: new Date().toISOString(),
  };

  if (action === "approve_final" && publishScheduledFor) {
    updatePayload.scheduled_for = publishScheduledFor;
  }

  if (action === "mark_live") {
    updatePayload.published_at = new Date().toISOString();
    updatePayload.current_url = current_url || null;
  }

  const updated = await (async () => {
        const { data, error } = await db!
          .from("pipeline_items")
          .update(updatePayload)
          .eq("id", id)
          .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, published_at, current_url, metadata, created_at, updated_at")
          .single();
        if (error) throw new Error(error.message);
        return data;
      })().catch(() => null);

  if (!updated) {
    return NextResponse.json({ error: "Failed to update blog item" }, { status: 500 });
  }

  if (["promote", "request_changes", "approve", "request_final_changes"].includes(action)) {
    const owner_agent = "content";
    const relationType = action === "promote" ? "investigate" : "followup";
    const actionName = action === "approve" || action === "request_final_changes" ? "localize_blog_to_en" : action === "promote" ? "develop_blog_draft" : "revise_blog_draft";

    const workInput = {
      pipelineItemId: item.id,
      pipelineType: "blog",
      title: createWorkItemTitle(action, item.title),
      instruction: createWorkItemInstruction(action, item, reviewNotes),
      priority: item.priority || "medium",
      ownerAgent: owner_agent,
      requestedBy: actorIdentity,
      relationType,
      action: actionName,
      trigger: "manual_transition",
      reviewNotes: action === "request_changes" || action === "request_final_changes" ? String(reviewNotes).trim() : undefined,
    };
    const { workItem } = await createPipelineWorkItem(db!, workInput);

    if (workItem?.id) {
      void notifyWorkItem(workItem.id, owner_agent, item.title);
    }
  }

  return NextResponse.json(updated);
}
