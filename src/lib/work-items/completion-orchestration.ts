import {
  YOUTUBE_GATE_ORDER,
  YOUTUBE_GATE_STATUSES,
  buildGateHistoryEntry,
  derivePipelineItemStatus,
  getGateEntry,
  getScores,
  getYouTubeMetadata,
  type YouTubeGateKey,
  type YouTubeGateStatus,
} from "@/lib/youtube-pipeline";

export type JsonRecord = Record<string, unknown>;

export type CompletionQueryClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type WorkItemRow = JsonRecord & {
  id: string;
  status?: string | null;
  title?: string | null;
  priority?: string | null;
  owner_agent?: string | null;
  requested_by?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  payload?: JsonRecord | null;
};

type VerifyPublishedContent = (input: {
  type: "blog" | "guide";
  url: string;
  expectedTitle: string;
  expectedSlug?: string | null;
  expectedDescription?: string | null;
}) => Promise<JsonRecord & { ok: boolean; finalUrl?: string | null }>;

export type CompletionOrchestrationInput = {
  existing: WorkItemRow;
  updated: WorkItemRow;
  body: JsonRecord;
  verifyPublishedContent: VerifyPublishedContent;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function getNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractCurrentUrl(body: JsonRecord) {
  const direct = readString(body.current_url);
  if (direct) return direct;
  const outputUrl = getNestedString(body.output, ["current_url"]);
  if (outputUrl) return outputUrl;
  const resultUrl = readString(body.result)?.match(/https?:\/\/\S+/)?.[0];
  return resultUrl?.replace(/[),.;]+$/, "") || null;
}

function extractCommunityCopy(body: JsonRecord) {
  const outputCopy = getNestedString(body.output, ["copy", "text"])
    || getNestedString(body.output, ["copy"])
    || getNestedString(body.output, ["text"]);
  if (outputCopy) return outputCopy;

  const result = readString(body.result);
  if (!result) return null;
  const labeledDraft = result.match(/(?:Draft community\/news post \(Spanish\)|Draft community\/news post|Draft news post|Borrador(?: listo)?(?: para aprobaci[oó]n)?(?:\s*[—:-]\s*noticia comunidad)?|Copy|Final copy|Texto final)\s*[:\n]+([\s\S]+)/i)?.[1]?.trim();
  const candidate = (labeledDraft || result)
    .replace(/\n+Recommendation:[\s\S]*$/i, "")
    .replace(/\n+Recomendaci[oó]n:[\s\S]*$/i, "")
    .trim();
  return /^(drafted|sent|validated|recommendation|publish after|copy listo|borrador listo|no publicado|hecho|listo)[\s\S]{0,220}$/i.test(candidate)
    ? null
    : candidate;
}

function extractScheduledFor(body: JsonRecord) {
  const direct = readString(body.scheduled_for);
  if (direct) return direct;
  const output = getNestedString(body.output, ["scheduled_for"])
    || getNestedString(body.output, ["schedule", "scheduled_for"]);
  if (output) return output;
  return readString(body.result)?.match(/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})/)?.[0] || null;
}

function isYouTubeGateKey(value: unknown): value is YouTubeGateKey {
  return typeof value === "string" && (YOUTUBE_GATE_ORDER as readonly string[]).includes(value);
}

function isYouTubeGateStatus(value: unknown): value is YouTubeGateStatus {
  return typeof value === "string" && (YOUTUBE_GATE_STATUSES as readonly string[]).includes(value);
}

function extractYouTubeGateStatus(body: JsonRecord) {
  const value = body.gate_status || getNestedString(body.output, ["gate_status"]);
  return isYouTubeGateStatus(value) ? value : null;
}

function extractYouTubeEvidenceSummary(body: JsonRecord) {
  return getNestedString(body.output, ["evidence_summary"])
    || getNestedString(body.output, ["summary"])
    || getNestedString(body.output, ["recommendation"])
    || readString(body.result)?.slice(0, 1800)
    || null;
}

function communityPublishTarget(metadata: JsonRecord) {
  const destinationKey = readString(metadata.intel_destination_key);
  const destinationLabel = readString(metadata.destination_label)?.toLowerCase() || "";
  const kind = readString(metadata.kind);
  const sourceType = readString(asRecord(metadata.source).type);

  if (destinationKey === "news" || destinationLabel === "news" || kind === "news" || metadata.intel) {
    return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia" };
  }
  if (destinationKey === "poll" || destinationLabel.includes("encuesta") || kind === "poll") {
    return { channelId: "1283759728798994533", channelName: "📔_encuestas" };
  }
  if (["blog", "guide", "doc", "video"].includes(String(sourceType || destinationKey || kind || ""))) {
    return { channelId: "1445797470662692864", channelName: "_📣anuncios" };
  }
  return { channelId: "1498256983122378883", channelName: "🛰️_radar_ia" };
}

function isPublished(item: JsonRecord) {
  return item.status === "published" || item.status === "live" || Boolean(item.published_at) || Boolean(item.current_url);
}

async function ensureMappedWorkItem(client: CompletionQueryClient, input: {
  pipelineItemId: string;
  mapPipelineItemId?: string;
  relationType: string;
  mapRelationType?: string;
  action: string;
  title: string;
  instruction: string;
  ownerAgent: string;
  requestedBy: string;
  priority: string;
  scheduledFor?: string | null;
  trigger: string;
  payloadExtra?: JsonRecord;
}) {
  const existing = await client.query<WorkItemRow>(
    `SELECT *
       FROM public.work_items
      WHERE source_type = ANY($1::text[])
        AND source_id = $2
        AND status = ANY($3::text[])
        AND payload ->> 'action' = $4
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [["pipeline_item", "service"], input.pipelineItemId, ["draft", "ready", "blocked", "in_progress", "done"], input.action],
  );
  if (existing.rows[0]) return { row: existing.rows[0], created: false };

  const payload = {
    trigger: input.trigger,
    pipeline_type: input.payloadExtra?.pipeline_type,
    pipeline_item_id: input.pipelineItemId,
    relation_type: input.relationType,
    action: input.action,
    ...(input.payloadExtra || {}),
  };
  const inserted = await client.query<WorkItemRow>(
    `INSERT INTO public.work_items (
       kind, source_type, source_id, title, instruction, status, priority,
       owner_agent, target_agent_id, requested_by, scheduled_for, payload
     ) VALUES ('task', 'pipeline_item', $1, $2, $3, 'ready', $4, $5, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.pipelineItemId,
      input.title,
      input.instruction,
      input.priority,
      input.ownerAgent,
      input.requestedBy,
      input.scheduledFor || null,
      JSON.stringify(payload),
    ],
  );
  const row = inserted.rows[0];
  const mapPipelineItemId = input.mapPipelineItemId || input.pipelineItemId;
  const mapRelationType = input.mapRelationType || input.relationType;
  await client.query(
    `INSERT INTO public.pipeline_work_map (pipeline_item_id, work_item_id, relation_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (pipeline_item_id, work_item_id, relation_type) DO NOTHING`,
    [mapPipelineItemId, row.id, mapRelationType],
  );
  await client.query(
    `INSERT INTO public.pipeline_events (pipeline_item_id, event_type, actor, payload)
     VALUES ($1, 'pipeline_item.work_item_created', 'work-item-completion', $2::jsonb)`,
    [mapPipelineItemId, JSON.stringify({ work_item_id: row.id, relation_type: input.relationType, action: input.action })],
  );
  return { row, created: true };
}

async function ensureCommunityPublishWorkItem(client: CompletionQueryClient, item: JsonRecord, workItem: WorkItemRow, scheduledFor: string) {
  const metadata = asRecord(item.metadata);
  const copy = asRecord(metadata.copy);
  const target = communityPublishTarget(metadata);
  const title = readString(item.title) || readString(workItem.title) || "Community post";
  return ensureMappedWorkItem(client, {
    pipelineItemId: String(item.id),
    relationType: "publish",
    action: "publish_community_post",
    title: `Publish community post: ${title}`,
    instruction: [
      `Publish community post "${title}".`,
      `Pipeline item ID: ${item.id}.`,
      `Publish to <#${target.channelId}> (${target.channelName}).`,
      "Publish only the approved copy and wrap raw URLs as <https://...> to suppress previews.",
      "Complete this work item with current_url and published_at when available.",
      readString(copy.text) ? `Approved copy:\n${copy.text}` : null,
    ].filter(Boolean).join("\n\n"),
    ownerAgent: "community",
    requestedBy: readString(item.requested_by) || readString(workItem.requested_by) || "mission-control",
    priority: readString(item.priority) || readString(workItem.priority) || "medium",
    scheduledFor,
    trigger: "community_schedule",
    payloadExtra: {
      pipeline_type: "community_post",
      schedule_kind: "publication",
      target_channel_id: target.channelId,
      target_channel_name: target.channelName,
      log_channel_id: "1473660854800224316",
      suppress_link_previews: true,
    },
  });
}

async function resolveGuideSchedule(client: CompletionQueryClient, pipelineItem: JsonRecord, metadata: JsonRecord) {
  const existing = readString(pipelineItem.scheduled_for) || getNestedString(metadata, ["schedule", "scheduled_for"]);
  if (existing) return { scheduledFor: existing, source: "existing" };

  const occupiedResult = await client.query<{ scheduled_for: string | Date }>(
    `SELECT scheduled_for
       FROM public.work_items
      WHERE status = ANY($1::text[])
        AND scheduled_for IS NOT NULL
        AND scheduled_for > now()
        AND payload ->> 'schedule_kind' = 'publication'`,
    [["draft", "ready", "blocked", "in_progress"]],
  );
  const occupied = new Set(occupiedResult.rows.map((row) => new Date(row.scheduled_for).toISOString()));
  const candidate = new Date();
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCHours(12, 0, 0, 0);
  for (let day = 0; day < 30; day += 1) {
    if (candidate.getUTCDay() !== 0 && candidate.getUTCDay() !== 6) {
      for (const hour of [12, 19]) {
        candidate.setUTCHours(hour, 0, 0, 0);
        if (!occupied.has(candidate.toISOString())) return { scheduledFor: candidate.toISOString(), source: "auto_allocated" };
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return { scheduledFor: candidate.toISOString(), source: "auto_allocated" };
}

async function createGuideAnnouncement(client: CompletionQueryClient, guide: JsonRecord, url: string, workItem: WorkItemRow) {
  const existing = await client.query<JsonRecord>(
    `SELECT * FROM public.pipeline_items
      WHERE pipeline_type = 'community_post' AND source_id = $1
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [guide.id],
  );
  let communityItem = existing.rows[0];
  if (!communityItem) {
    const title = readString(guide.title) || "published guide";
    const slug = readString(guide.slug);
    const inserted = await client.query<JsonRecord>(
      `INSERT INTO public.pipeline_items (
         pipeline_type, title, slug, status, priority, owner_agent, requested_by,
         source_type, source_id, metadata
       ) VALUES ('community_post', $1, $2, 'draft', $3, 'community', $4, 'manual', $5, $6::jsonb)
       RETURNING *`,
      [
        `Announce guide: ${title}`,
        slug ? `announce-${slug}` : null,
        readString(guide.priority) || "medium",
        readString(workItem.requested_by) || readString(guide.requested_by) || "mission-control",
        guide.id,
        JSON.stringify({
          kind: "guide_announcement",
          channel: "discord",
          source: { type: readString(guide.pipeline_type) || "guide", pipeline_item_id: guide.id, url, title, slug },
          copy: { text: "", poll_options: [] },
          automation: { trigger: "published_content_verified", created_at: new Date().toISOString() },
        }),
      ],
    );
    communityItem = inserted.rows[0];
  }

  const guideTitle = readString(guide.title) || "published guide";
  await ensureMappedWorkItem(client, {
    pipelineItemId: String(communityItem.id),
    relationType: "distribute_community",
    action: "draft_guide_announcement",
    title: `Draft Discord announcement: ${guideTitle}`,
    instruction: [
      `Community post item: ${communityItem.title}`,
      "Draft a concise Discord announcement for this newly published guide.",
      "Include the guide link and leave it ready for review; do not publish directly.",
      `Guide: ${guideTitle}`,
      `URL: ${url}`,
    ].join("\n\n"),
    ownerAgent: "community",
    requestedBy: readString(workItem.requested_by) || readString(guide.requested_by) || "mission-control",
    priority: readString(guide.priority) || "medium",
    trigger: "published_content_verified",
    payloadExtra: { pipeline_type: "community_post", source_guide_pipeline_item_id: guide.id },
  });
}

async function updatePipelineItem(client: CompletionQueryClient, id: string, status: string, metadata: JsonRecord, extra: {
  scheduledFor?: string | null;
  publishedAt?: string | null;
  currentUrl?: string | null;
} = {}) {
  await client.query(
    `UPDATE public.pipeline_items
        SET status = $2,
            metadata = $3::jsonb,
            scheduled_for = CASE WHEN $4::boolean THEN $5::timestamptz ELSE scheduled_for END,
            published_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE published_at END,
            current_url = CASE WHEN $8::boolean THEN $9::text ELSE current_url END,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      status,
      JSON.stringify(metadata),
      extra.scheduledFor !== undefined,
      extra.scheduledFor ?? null,
      extra.publishedAt !== undefined,
      extra.publishedAt ?? null,
      extra.currentUrl !== undefined,
      extra.currentUrl ?? null,
    ],
  );
}

export async function orchestrateWorkItemCompletion(
  client: CompletionQueryClient,
  input: CompletionOrchestrationInput,
) {
  const { existing, updated, body, verifyPublishedContent } = input;
  if (body.status !== "done" || existing.status === "done") return { applied: false, reason: "not_a_new_completion" };

  const payload = asRecord(updated.payload);
  const sourcePipelineItemId = ["pipeline_item", "service"].includes(String(updated.source_type || ""))
    ? readString(updated.source_id)
    : null;
  const pipelineItemId = readString(payload.pipeline_item_id) || sourcePipelineItemId;
  if (!pipelineItemId) return { applied: false, reason: "not_pipeline_backed" };

  const pipelineResult = await client.query<JsonRecord>(
    "SELECT * FROM public.pipeline_items WHERE id = $1 LIMIT 1 FOR UPDATE",
    [pipelineItemId],
  );
  const pipelineItem = pipelineResult.rows[0];
  if (!pipelineItem) return { applied: false, reason: "pipeline_item_not_found" };

  let pipelineType = readString(payload.pipeline_type) || readString(pipelineItem.pipeline_type) || "";
  let action = readString(payload.action) || "";
  const title = String(updated.title || "").toLowerCase();
  const relationType = readString(payload.relation_type) || "";
  if (!action && pipelineType === "community_post") {
    if (relationType === "publish" || title.includes("publish")) action = "publish_community_post";
    else if (relationType === "schedule" || title.includes("schedule")) action = "schedule_community_post";
    else action = title.includes("revise") ? "revise_community_announcement" : "draft_guide_announcement";
  } else if (!action && ["blog", "doc", "guide"].includes(pipelineType)) {
    if (title.includes("publish")) action = pipelineType === "blog" ? "publish_blog" : "publish_guide";
    if (title.includes("localize")) action = pipelineType === "blog" ? "localize_blog_to_en" : "localize_guide_to_en";
  }
  pipelineType = pipelineType === "doc" ? "guide" : pipelineType;

  const now = new Date().toISOString();
  const metadata = asRecord(pipelineItem.metadata);

  if (pipelineType === "video" && action.startsWith("youtube_gate_")) {
    const candidateGate = relationType || action.replace("youtube_gate_", "");
    if (isYouTubeGateKey(candidateGate)) {
      const youtubeMetadata = getYouTubeMetadata(metadata);
      const previousGate = getGateEntry(youtubeMetadata, candidateGate);
      const nextStatus = extractYouTubeGateStatus(body)
        || (previousGate.status === "not_started" || !previousGate.status ? "in_progress" : previousGate.status);
      const evidenceSummary = extractYouTubeEvidenceSummary(body);
      const nextMetadata = {
        ...youtubeMetadata,
        gates: {
          ...asRecord(youtubeMetadata.gates),
          [candidateGate]: {
            ...previousGate,
            status: nextStatus,
            evidence_summary: evidenceSummary || previousGate.evidence_summary,
            work_item_id: updated.id,
            updated_at: now,
            history: [
              ...(Array.isArray(previousGate.history) ? previousGate.history : []),
              buildGateHistoryEntry({
                at: now,
                by: readString(updated.owner_agent) || "youtube",
                status: nextStatus,
                reason: previousGate.reason || null,
                evidenceSummary: evidenceSummary || previousGate.evidence_summary || null,
                nextAction: previousGate.next_action || null,
                scores: getScores(youtubeMetadata),
              }),
            ],
          },
        },
        runtime_feedback: {
          ...asRecord(youtubeMetadata.runtime_feedback),
          last_status: "youtube_gate_work_completed",
          last_work_item_id: updated.id,
          last_gate_key: candidateGate,
          updated_at: now,
        },
      };
      await updatePipelineItem(
        client,
        pipelineItemId,
        derivePipelineItemStatus(nextMetadata, {
          currentStatus: readString(pipelineItem.status),
          publishedAt: pipelineItem.published_at ? String(pipelineItem.published_at) : null,
        }),
        nextMetadata,
      );
      return { applied: true, effect: "youtube_gate" };
    }
  }

  if (pipelineType === "community_post") {
    if (action === "publish_community_post") {
      const currentUrl = extractCurrentUrl(body);
      await updatePipelineItem(client, pipelineItemId, "published", {
        ...metadata,
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: "published",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      }, {
        publishedAt: readString(body.published_at) || now,
        currentUrl,
      });
      return { applied: true, effect: "community_published" };
    }

    const draftActions = new Set([
      "draft_guide_announcement",
      "revise_community_announcement",
      "draft_community_news",
      "develop_community_post",
    ]);
    if (draftActions.has(action)) {
      const copyText = extractCommunityCopy(body);
      const copyMetadata = asRecord(metadata.copy);
      await updatePipelineItem(client, pipelineItemId, copyText ? "ready_for_review" : "draft", {
        ...metadata,
        copy: { ...copyMetadata, text: copyText || copyMetadata.text || "" },
        ...(!copyText ? {
          review: {
            ...asRecord(metadata.review),
            notes: "Community work item completed without announcement copy. Needs a clean re-draft before review.",
            last_requested_at: now,
            last_requested_by: "system",
          },
        } : {}),
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: copyText ? "copy_saved" : "completed_without_copy",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      });
      return { applied: true, effect: "community_draft" };
    }

    if (action === "schedule_community_post") {
      const scheduledFor = extractScheduledFor(body);
      const alreadyPublished = isPublished(pipelineItem);
      const publishWork = scheduledFor && !alreadyPublished
        ? await ensureCommunityPublishWorkItem(client, pipelineItem, updated, scheduledFor)
        : null;
      const previousSchedule = asRecord(metadata.schedule);
      const publishWorkItemId = alreadyPublished
        ? readString(previousSchedule.publish_work_item_id)
        : readString(publishWork?.row.id);
      await updatePipelineItem(client, pipelineItemId, alreadyPublished
        ? String(pipelineItem.status)
        : scheduledFor ? "scheduled" : "approved", {
        ...metadata,
        schedule: {
          ...previousSchedule,
          scheduled_for: scheduledFor,
          scheduled_at: now,
          scheduled_by: readString(updated.owner_agent) || "community",
          source: "work_items",
          publish_work_item_id: publishWorkItemId,
        },
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: alreadyPublished
            ? "schedule_skipped_already_published"
            : scheduledFor ? "publish_work_item_scheduled" : "schedule_missing_date",
          last_work_item_id: updated.id,
          publish_work_item_id: publishWorkItemId,
          updated_at: now,
        },
      }, { scheduledFor: null });
      return { applied: true, effect: "community_scheduled" };
    }
  }

  if (pipelineType === "email_campaign") {
    const emailDraft = asRecord(asRecord(body.output).email_draft);
    if (Object.keys(emailDraft).length) {
      await updatePipelineItem(client, pipelineItemId, "ready_for_review", {
        ...metadata,
        draft: emailDraft,
        review: {
          ...asRecord(metadata.review),
          status: "ready_for_review",
          ready_at: now,
          source_work_item_id: updated.id,
        },
        runtime_feedback: {
          ...asRecord(metadata.runtime_feedback),
          last_status: "draft_saved",
          last_work_item_id: updated.id,
          updated_at: now,
        },
      });
      return { applied: true, effect: "email_draft" };
    }
  }

  const isBlog = pipelineType === "blog";
  const isGuide = pipelineType === "guide";
  const localizeAction = action === "localize_blog_to_en" || action === "localize_guide_to_en";
  if ((isBlog || isGuide) && localizeAction) {
    const localization = { ...asRecord(metadata.localization), en_ready: true, translated_at: now };
    if (isBlog) {
      await updatePipelineItem(client, pipelineItemId, "final_check", {
        ...metadata,
        localization,
        final_check: {
          ...asRecord(metadata.final_check),
          status: "ready",
          ready_at: now,
          source_work_item_id: updated.id,
        },
      });
    } else {
      const schedule = await resolveGuideSchedule(client, pipelineItem, metadata);
      const publishWork = await ensureMappedWorkItem(client, {
        pipelineItemId,
        relationType: "publish",
        action: "publish_guide",
        title: `Publish guide: ${readString(pipelineItem.title) || readString(updated.title) || "Guide"}`,
        instruction: [
          `Pipeline guide item: ${readString(pipelineItem.title) || readString(updated.title) || "Guide"}`,
          "Publish the guide to the website.",
          "When done, complete the work item with current_url and optional notes.",
        ].join("\n\n"),
        ownerAgent: "dev",
        requestedBy: readString(updated.requested_by) || "mission-control",
        priority: readString(pipelineItem.priority) || readString(updated.priority) || "medium",
        scheduledFor: schedule.scheduledFor,
        trigger: "work_item_completion",
        payloadExtra: { pipeline_type: "guide", schedule_kind: "publication" },
      });
      await updatePipelineItem(client, pipelineItemId, "scheduled", {
        ...metadata,
        localization,
        schedule: {
          ...asRecord(metadata.schedule),
          scheduled_for: schedule.scheduledFor,
          scheduled_at: now,
          scheduled_by: readString(updated.owner_agent) || "content",
          source: schedule.source,
          publish_work_item_id: publishWork.row.id,
        },
      }, { scheduledFor: schedule.scheduledFor });
    }
    return { applied: true, effect: "content_localized" };
  }

  const publishAction = action === "publish_blog" || action === "publish_guide";
  if ((isBlog || isGuide) && publishAction) {
    const publishUrl = extractCurrentUrl(body);
    const expectedDescription = getNestedString(metadata, ["seo", "meta_description"])
      || getNestedString(metadata, ["draft_summary"])
      || getNestedString(metadata, ["summary"]);
    const verification = await verifyPublishedContent({
      type: isGuide ? "guide" : "blog",
      url: publishUrl || "",
      expectedTitle: typeof pipelineItem.title === "string" ? pipelineItem.title : "",
      expectedSlug: readString(pipelineItem.slug),
      expectedDescription,
    });
    const verificationMetadata = {
      ...asRecord(metadata.publication_verification),
      checked_at: now,
      work_item_id: updated.id,
      url: publishUrl,
      result: verification,
    };
    if (verification.ok) {
      const liveUrl = readString(verification.finalUrl) || publishUrl;
      await updatePipelineItem(client, pipelineItemId, "live", {
        ...metadata,
        publication_verification: verificationMetadata,
      }, {
        publishedAt: readString(body.published_at) || now,
        currentUrl: liveUrl,
      });
      if (isGuide && liveUrl) await createGuideAnnouncement(client, pipelineItem, liveUrl, updated);
    } else {
      await updatePipelineItem(client, pipelineItemId, String(pipelineItem.status), {
        ...metadata,
        publication_verification: verificationMetadata,
      });
      await client.query(
        `INSERT INTO public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
         VALUES ('content', 'published_content.verification_failed', 'pipeline_item', $1, $2, $3::jsonb)`,
        [pipelineItemId, readString(updated.owner_agent) || "dev", JSON.stringify({
          pipeline_type: pipelineType,
          action,
          work_item_id: updated.id,
          verification,
        })],
      );
    }
    return { applied: true, effect: "content_published", verified: verification.ok };
  }

  return { applied: false, reason: "no_completion_effect" };
}
