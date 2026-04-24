import { createServiceClient, supabaseAdmin } from "@/lib/supabase/admin";

export type IntelInboxStatus = "new" | "saved" | "dismissed" | "promoted";

export type IntelInboxListItem = {
  id: string;
  enrichedItemId: number;
  title: string;
  summary: string;
  lane: string | null;
  primaryTopic: string | null;
  suggestedOwner: string | null;
  suggestedDestination: string | null;
  promoteType: string | null;
  promoteOwner: string | null;
  promoteStatusDefault: string | null;
  overallScore: number;
  reviewStatus: IntelInboxStatus;
  reviewId: string | null;
  createdPipelineItemId: string | null;
  updatedAt: string;
  createdAt: string;
};

export type IntelInboxDetail = {
  item: IntelInboxListItem & {
    whyItMatters: string | null;
    rawItemId: number | null;
    metadata: Record<string, unknown>;
    formatScores: Record<string, number>;
    promoteCollaborators: string[];
  };
  rawSource: {
    id: number;
    title: string | null;
    url: string | null;
    canonicalUrl: string | null;
    sourceContext: string | null;
    author: string | null;
    lane: string | null;
    contentText: string | null;
    publishedAt: string | null;
    firstSeenAt: string | null;
    engagementScore: number;
    engagementCount: number | null;
    rawJson: Record<string, unknown>;
    metadataJson: Record<string, unknown>;
  } | null;
  review: {
    id: string | null;
    reviewer: string | null;
    status: IntelInboxStatus;
    selectedPipelineType: string | null;
    selectedOwnerAgent: string | null;
    selectedCollaborators: string[];
    decisionReasoning: string | null;
    notes: string | null;
    createdPipelineItemId: string | null;
    reviewedAt: string | null;
    updatedAt: string | null;
  } | null;
  pipelineItem: {
    id: string;
    title: string;
    pipelineType: string;
    status: string;
    ownerAgent: string | null;
    updatedAt: string;
  } | null;
};

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizeStatus(value: unknown): IntelInboxStatus {
  if (value === "saved" || value === "dismissed" || value === "promoted") return value;
  return "new";
}

function stripTrailingPeriod(text: string) {
  return text.trim().replace(/[.。!]+$/g, "");
}

function sentence(text: string) {
  const clean = stripTrailingPeriod(text);
  if (!clean) return "";
  return `${clean}.`;
}

function buildReadableSummary(params: {
  title: string;
  summaryShort: string | null;
  whyItMatters: string | null;
  rawTitle: string | null;
  rawContentText: string | null;
}) {
  const title = params.title.trim();
  const summary = (params.summaryShort || "").trim();
  const why = (params.whyItMatters || "").trim();
  const rawTitle = (params.rawTitle || "").trim();
  const rawContent = (params.rawContentText || "").trim();

  const lowerCombined = `${title} ${rawTitle} ${summary}`.toLowerCase();
  const versionMatch = lowerCombined.match(/(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){1,3})/i);
  const version = versionMatch?.[1] || null;

  if (lowerCombined.includes("openclaw") && version) {
    const first = `Se actualizó OpenClaw a la versión ${version}.`;
    const secondSource = summary || rawContent || why;
    if (secondSource) {
      return `${first}\n\n${sentence(`Los cambios más importantes incluyen ${stripTrailingPeriod(secondSource).charAt(0).toLowerCase()}${stripTrailingPeriod(secondSource).slice(1)}`)}`;
    }
    return first;
  }

  const leadSource = summary || rawTitle || title;
  const detailSource = rawContent || why;

  if (detailSource && stripTrailingPeriod(detailSource) !== stripTrailingPeriod(leadSource)) {
    return `${sentence(leadSource)}\n\n${sentence(detailSource)}`;
  }

  return sentence(leadSource) || "Sin resumen";
}

export async function listIntelInbox(options?: {
  status?: IntelInboxStatus | "all";
  lane?: string | null;
  owner?: string | null;
  limit?: number;
  offset?: number;
}) {
  const db = supabaseAdmin;
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  let query = db
    .from("intel_items_enriched")
    .select("id,raw_item_id,lane,summary_short,summary_display,why_it_matters,primary_topic,suggested_owner,suggested_destination,overall_score,promote_title,promote_type,promote_owner,promote_status_default,created_at,metadata_json")
    .order("overall_score", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (options?.lane && options.lane !== "all") query = query.eq("lane", options.lane);
  if (options?.owner && options.owner !== "all") query = query.eq("promote_owner", options.owner);

  const { data: enrichedRows, error } = await query;
  if (error) throw error;

  const rows = (enrichedRows || []) as Array<Record<string, unknown>>;
  const enrichedIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);

  const { data: reviews, error: reviewsError } = enrichedIds.length
    ? await db
        .from("intel_inbox_reviews")
        .select("id,enriched_item_id,status,created_pipeline_item_id,updated_at")
        .in("enriched_item_id", enrichedIds)
    : { data: [], error: null };

  if (reviewsError) throw reviewsError;

  const reviewByItem = new Map<number, Record<string, unknown>>();
  for (const review of (reviews || []) as Array<Record<string, unknown>>) {
    const enrichedItemId = Number(review.enriched_item_id);
    if (!Number.isFinite(enrichedItemId)) continue;
    const current = reviewByItem.get(enrichedItemId);
    if (!current) {
      reviewByItem.set(enrichedItemId, review);
      continue;
    }
    const currentUpdated = String(current.updated_at || current.created_at || "");
    const nextUpdated = String(review.updated_at || review.created_at || "");
    if (nextUpdated > currentUpdated) reviewByItem.set(enrichedItemId, review);
  }

  const items: IntelInboxListItem[] = rows
    .map((row) => {
      const id = Number(row.id);
      const metadata = toObject(row.metadata_json);
      const review = reviewByItem.get(id);
      const title = String(row.promote_title || metadata.headline_short || row.summary_short || `Intel item ${id}`);
      return {
        id: String(id),
        enrichedItemId: id,
        title,
        summary: typeof row.summary_display === "string" && row.summary_display.trim()
          ? row.summary_display.trim()
          : buildReadableSummary({
              title,
              summaryShort: typeof row.summary_short === "string" ? row.summary_short : null,
              whyItMatters: typeof row.why_it_matters === "string" ? row.why_it_matters : null,
              rawTitle: null,
              rawContentText: null,
            }),
        lane: typeof row.lane === "string" ? row.lane : null,
        primaryTopic: typeof row.primary_topic === "string" ? row.primary_topic : null,
        suggestedOwner: typeof row.suggested_owner === "string" ? row.suggested_owner : null,
        suggestedDestination: typeof row.suggested_destination === "string" ? row.suggested_destination : null,
        promoteType: typeof row.promote_type === "string" ? row.promote_type : null,
        promoteOwner: typeof row.promote_owner === "string" ? row.promote_owner : null,
        promoteStatusDefault: typeof row.promote_status_default === "string" ? row.promote_status_default : null,
        overallScore: toNumber(row.overall_score),
        reviewStatus: normalizeStatus(review?.status),
        reviewId: review?.id ? String(review.id) : null,
        createdPipelineItemId: review?.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
        updatedAt: String(review?.updated_at || row.created_at || new Date().toISOString()),
        createdAt: String(row.created_at || new Date().toISOString()),
      };
    })
    .filter((item) => (options?.status && options.status !== "all" ? item.reviewStatus === options.status : true));

  return {
    items,
    total: items.length,
    limit,
    offset,
  };
}

export async function getIntelInboxDetail(id: string) {
  const enrichedId = Number(id);
  if (!Number.isFinite(enrichedId)) return null;

  const db = supabaseAdmin;
  const { data: enriched, error } = await db
    .from("intel_items_enriched")
    .select("*")
    .eq("id", enrichedId)
    .maybeSingle();

  if (error) throw error;
  if (!enriched) return null;

  const { data: reviewRows, error: reviewError } = await db
    .from("intel_inbox_reviews")
    .select("*")
    .eq("enriched_item_id", enrichedId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (reviewError) throw reviewError;

  const review = ((reviewRows || [])[0] || null) as Record<string, unknown> | null;

  const rawItemId = Number(enriched.raw_item_id);
  let rawSource: IntelInboxDetail["rawSource"] = null;
  if (Number.isFinite(rawItemId)) {
    const { data: raw, error: rawError } = await db
      .from("intel_items_raw")
      .select("id,title,url,canonical_url,source_context,author,lane,content_text,published_at,first_seen_at,engagement_score,engagement_count,raw_json,metadata_json")
      .eq("id", rawItemId)
      .maybeSingle();
    if (rawError) throw rawError;
    if (raw) {
      rawSource = {
        id: raw.id,
        title: raw.title || null,
        url: raw.url || null,
        canonicalUrl: raw.canonical_url || null,
        sourceContext: raw.source_context || null,
        author: raw.author || null,
        lane: raw.lane || null,
        contentText: raw.content_text || null,
        publishedAt: raw.published_at || null,
        firstSeenAt: raw.first_seen_at || null,
        engagementScore: toNumber(raw.engagement_score),
        engagementCount: typeof raw.engagement_count === "number" ? raw.engagement_count : null,
        rawJson: toObject(raw.raw_json),
        metadataJson: toObject(raw.metadata_json),
      };
    }
  }

  let pipelineItem: IntelInboxDetail["pipelineItem"] = null;
  if (review?.created_pipeline_item_id) {
    const { data: pipeline, error: pipelineError } = await db
      .from("pipeline_items")
      .select("id,title,pipeline_type,status,owner_agent,updated_at")
      .eq("id", String(review.created_pipeline_item_id))
      .maybeSingle();
    if (pipelineError) throw pipelineError;
    if (pipeline) {
      pipelineItem = {
        id: pipeline.id,
        title: pipeline.title,
        pipelineType: pipeline.pipeline_type,
        status: pipeline.status,
        ownerAgent: pipeline.owner_agent,
        updatedAt: pipeline.updated_at,
      };
    }
  }

  const metadata = toObject(enriched.metadata_json);

  const title = String(enriched.promote_title || metadata.headline_short || enriched.summary_short || `Intel item ${enriched.id}`);
  const readableSummary = typeof enriched.summary_display === "string" && enriched.summary_display.trim()
    ? enriched.summary_display.trim()
    : buildReadableSummary({
        title,
        summaryShort: enriched.summary_short || null,
        whyItMatters: enriched.why_it_matters || null,
        rawTitle: rawSource?.title || null,
        rawContentText: rawSource?.contentText || null,
      });

  return {
    item: {
      id: String(enriched.id),
      enrichedItemId: enriched.id,
      title,
      summary: readableSummary,
      lane: enriched.lane || null,
      primaryTopic: enriched.primary_topic || null,
      suggestedOwner: enriched.suggested_owner || null,
      suggestedDestination: enriched.suggested_destination || null,
      promoteType: enriched.promote_type || null,
      promoteOwner: enriched.promote_owner || null,
      promoteStatusDefault: enriched.promote_status_default || null,
      overallScore: toNumber(enriched.overall_score),
      reviewStatus: normalizeStatus(review?.status),
      reviewId: review?.id ? String(review.id) : null,
      createdPipelineItemId: review?.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
      updatedAt: String(review?.updated_at || enriched.created_at || new Date().toISOString()),
      createdAt: String(enriched.created_at || new Date().toISOString()),
      whyItMatters: enriched.why_it_matters || null,
      rawItemId: Number.isFinite(rawItemId) ? rawItemId : null,
      metadata,
      formatScores: {
        doc: toNumber(enriched.format_doc_score),
        video: toNumber(enriched.format_video_score),
        email_campaign: toNumber(enriched.format_email_campaign_score),
      },
      promoteCollaborators: Array.isArray(metadata.promote_collaborators)
        ? metadata.promote_collaborators.filter((value): value is string => typeof value === "string")
        : [],
    },
    rawSource,
    review: review
      ? {
          id: review.id ? String(review.id) : null,
          reviewer: typeof review.reviewer === "string" ? review.reviewer : null,
          status: normalizeStatus(review.status),
          selectedPipelineType: typeof review.selected_pipeline_type === "string" ? review.selected_pipeline_type : null,
          selectedOwnerAgent: typeof review.selected_owner_agent === "string" ? review.selected_owner_agent : null,
          selectedCollaborators: Array.isArray(review.selected_collaborators)
            ? review.selected_collaborators.filter((value): value is string => typeof value === "string")
            : [],
          decisionReasoning: typeof review.decision_reasoning === "string" ? review.decision_reasoning : null,
          notes: typeof review.notes === "string" ? review.notes : null,
          createdPipelineItemId: review.created_pipeline_item_id ? String(review.created_pipeline_item_id) : null,
          reviewedAt: typeof review.reviewed_at === "string" ? review.reviewed_at : null,
          updatedAt: typeof review.updated_at === "string" ? review.updated_at : null,
        }
      : null,
    pipelineItem,
  } satisfies IntelInboxDetail;
}

export async function saveIntelInboxDecision(params: {
  enrichedItemId: string;
  reviewer: string;
  status: IntelInboxStatus;
  notes?: string | null;
}) {
  const db = createServiceClient();
  const enrichedId = Number(params.enrichedItemId);
  if (!Number.isFinite(enrichedId)) {
    const err = new Error("Invalid enriched item id");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const payload = {
    enriched_item_id: enrichedId,
    reviewer: params.reviewer,
    status: params.status,
    notes: params.notes || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("intel_inbox_reviews")
    .upsert(payload, { onConflict: "enriched_item_id,reviewer" })
    .select("id,status,created_pipeline_item_id")
    .single();

  if (error) throw error;
  return data;
}

export async function promoteIntelInboxItem(params: {
  enrichedItemId: string;
  reviewer: string;
  notes?: string | null;
  ownerAgent?: string | null;
  collaborators?: string[];
}) {
  const db = createServiceClient();
  const enrichedId = Number(params.enrichedItemId);
  if (!Number.isFinite(enrichedId)) {
    const err = new Error("Invalid enriched item id");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const { data: enriched, error: enrichedError } = await db
    .from("intel_items_enriched")
    .select("*")
    .eq("id", enrichedId)
    .maybeSingle();
  if (enrichedError) throw enrichedError;
  if (!enriched) {
    const err = new Error("Intel item not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }

  const { data: existingReviewRows, error: existingReviewError } = await db
    .from("intel_inbox_reviews")
    .select("*")
    .eq("enriched_item_id", enrichedId)
    .eq("reviewer", params.reviewer)
    .limit(1);
  if (existingReviewError) throw existingReviewError;
  const existingReview = ((existingReviewRows || [])[0] || null) as Record<string, unknown> | null;

  if (existingReview?.created_pipeline_item_id) {
    return {
      id: String(enrichedId),
      status: "promoted",
      primaryPipelineItemId: String(existingReview.created_pipeline_item_id),
    };
  }

  const metadata = toObject(enriched.metadata_json);
  const title = String(enriched.promote_title || metadata.headline_short || enriched.summary_short || `Intel item ${enriched.id}`);
  const pipelineType = String(enriched.promote_type || "doc");
  const ownerAgent = params.ownerAgent || enriched.promote_owner || enriched.suggested_owner || null;
  const collaborators = Array.from(new Set((params.collaborators || []).filter(Boolean))).filter((agent) => agent !== ownerAgent);
  const status = enriched.promote_status_default || "draft";
  const sourceId = enriched.raw_item_id ? String(enriched.raw_item_id) : String(enriched.id);
  const metadataShell = toObject(metadata.promote_metadata_shell);

  const { data: pipelineItem, error: pipelineError } = await db
    .from("pipeline_items")
    .insert({
      title,
      pipeline_type: pipelineType,
      status,
      priority: "medium",
      owner_agent: ownerAgent,
      requested_by: params.reviewer,
      source_type: "manual",
      source_id: sourceId,
      metadata: {
        ...metadataShell,
        intel_source_type: "intel_inbox",
        intel_enriched_item_id: enriched.id,
        intel_raw_item_id: enriched.raw_item_id,
        collaborators,
        notify_agents: collaborators,
        notes: params.notes || null,
      },
      asset_role: "standalone",
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (pipelineError || !pipelineItem) throw pipelineError || new Error("Failed to create pipeline item");

  const { error: reviewError } = await db
    .from("intel_inbox_reviews")
    .upsert({
      enriched_item_id: enrichedId,
      reviewer: params.reviewer,
      status: "promoted",
      selected_pipeline_type: pipelineType,
      selected_owner_agent: ownerAgent,
      selected_collaborators: collaborators,
      notes: params.notes || null,
      created_pipeline_item_id: pipelineItem.id,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "enriched_item_id,reviewer" });
  if (reviewError) throw reviewError;

  return {
    id: String(enrichedId),
    status: "promoted",
    primaryPipelineItemId: pipelineItem.id,
  };
}
