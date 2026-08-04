import { isLocalAuthDisabled } from "@/lib/auth/local";
import { normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { YouTubeDecisionBoard } from "@/components/youtube/YouTubeDecisionBoard";
import { isYouTubeLaunchPlaylistEligible, listYouTubePlaylists } from "@/lib/youtube/playlists";

export const dynamic = "force-dynamic";

export interface VideoPipelineItem {
  id: string;
  pipeline_type: string;
  title: string;
  slug: string | null;
  status: string;
  priority: string | null;
  owner_agent: string | null;
  target_agent_id?: string | null;
  requested_by: string | null;
  source_type: string | null;
  source_id: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  current_url: string | null;
  content_path: string | null;
  content_format: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LinkedWorkItem {
  id: string;
  source_id: string;
  source_type: string;
  title: string;
  status: string;
  owner_agent: string | null;
  target_agent_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  completed_at?: string | null;
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
}

type LaunchApprovalPipelineItem = {
  id: string;
  pipeline_type: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

export default async function YouTubePage() {
  const localSupabasePlaceholder = isLocalSupabasePlaceholder();

  const governedPlaylists = await listYouTubePlaylists({
    useCases: [],
    tags: [],
    status: "active",
    includeVideos: false,
    resolve: null,
  });
  const playlistOptions = governedPlaylists
    .filter(isYouTubeLaunchPlaylistEligible)
    .map((playlist) => ({
      playlist_id: playlist.playlist_id,
      title: playlist.title,
      purpose: playlist.purpose,
    }));

  let videos: VideoPipelineItem[] = [];
  let linkedWorkItems: LinkedWorkItem[] = [];

  if (localSupabasePlaceholder) {
    const [videoRes, workRes] = await Promise.all([
      query<VideoPipelineItem>(
        `select id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at
           from pipeline_items
          where pipeline_type = 'video'
          order by created_at desc`,
      ),
      query<LinkedWorkItem>(
        `select id, source_id, source_type, title, status, owner_agent, target_agent_id, created_at, scheduled_for, payload
           from work_items
          where source_type = any($1::text[])
            and (
              payload ->> 'pipeline_type' = 'video'
              or payload ->> 'source_video_pipeline_item_id' is not null
            )
          order by created_at desc`,
        [["pipeline_item", "service"]],
      ),
    ]);

    videos = normalizeRows(videoRes.rows as VideoPipelineItem[]);
    linkedWorkItems = normalizeRows(workRes.rows as LinkedWorkItem[]);
  } else {
    const [{ data, error }, { data: workItems, error: workError }] = await Promise.all([
      supabaseAdmin
        .from("pipeline_items")
        .select("id, pipeline_type, title, slug, status, priority, owner_agent, requested_by, source_type, source_id, scheduled_for, published_at, current_url, content_path, content_format, metadata, created_at, updated_at")
        .eq("pipeline_type", "video")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("work_items")
        .select("id,source_id,source_type,title,status,owner_agent,target_agent_id,created_at,updated_at,completed_at,scheduled_for,payload")
        .in("source_type", ["pipeline_item", "service"])
        .or("payload->>pipeline_type.eq.video,payload->>source_video_pipeline_item_id.not.is.null")
        .order("created_at", { ascending: false }),
    ]);

    if (error) {
      console.error("[YouTubePage] Failed to fetch video items:", error);
    }
    if (workError) {
      console.error("[YouTubePage] Failed to fetch work items:", workError);
    }

    videos = (data ?? []) as VideoPipelineItem[];
    linkedWorkItems = (workItems ?? []) as unknown as LinkedWorkItem[];
  }

  linkedWorkItems = await hydrateAuthoritativeLaunchApprovals(linkedWorkItems, localSupabasePlaceholder);

  return (
    <YouTubeDecisionBoard
      initialItems={videos}
      initialWorkItems={linkedWorkItems}
      playlistOptions={playlistOptions}
    />
  );
}

function isLocalSupabasePlaceholder() {
  return isLocalAuthDisabled();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function hydrateAuthoritativeLaunchApprovals(workItems: LinkedWorkItem[], useLocalMode: boolean) {
  const childIds = [...new Set(workItems.flatMap((workItem) => {
    const payload = record(workItem.payload);
    const id = stringValue(payload.approval_target_pipeline_item_id) || stringValue(payload.pipeline_item_id);
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? [id] : [];
  }))];
  if (!childIds.length) return workItems;

  let children: LaunchApprovalPipelineItem[] = [];
  if (useLocalMode) {
    const result = await query<LaunchApprovalPipelineItem>(
      `select id,pipeline_type,status,metadata
         from pipeline_items
        where id = any($1::uuid[])`,
      [childIds],
    );
    children = normalizeRows(result.rows as LaunchApprovalPipelineItem[]);
  } else {
    const { data, error } = await supabaseAdmin
      .from("pipeline_items")
      .select("id,pipeline_type,status,metadata")
      .in("id", childIds);
    if (error) console.error("[YouTubePage] Failed to fetch launch approval cards:", error);
    children = (data ?? []) as LaunchApprovalPipelineItem[];
  }

  const byId = new Map(children.map((child) => [child.id, child]));
  return workItems.map((workItem) => {
    const payload = record(workItem.payload);
    if (payload.launch_state_contract !== "scheduled_launch_v2") return workItem;
    const childId = stringValue(payload.approval_target_pipeline_item_id) || stringValue(payload.pipeline_item_id);
    const child = childId ? byId.get(childId) : null;
    if (!child) return workItem;
    const metadata = record(child.metadata);
    const review = record(metadata.review);
    const schedule = record(metadata.schedule);
    const launchPackage = record(metadata.launch_package);
    const expectedLaunchGeneration = stringValue(payload.launch_generation);
    const childLaunchGeneration = stringValue(launchPackage.launch_generation);
    const approvalLaunchGeneration = stringValue(review.launch_generation) || stringValue(schedule.approval_launch_generation);
    const approvedBy = stringValue(review.approved_by) || stringValue(schedule.approved_by);
    const reviewStatus = stringValue(review.status);
    const approvalIsCurrent = Boolean(expectedLaunchGeneration)
      && childLaunchGeneration === expectedLaunchGeneration
      && approvalLaunchGeneration === expectedLaunchGeneration;
    const approved = approvalIsCurrent && (reviewStatus === "approved" || reviewStatus === "gonza_approved" || Boolean(approvedBy));
    return {
      ...workItem,
      payload: {
        ...payload,
        authoritative_approval: {
          pipeline_item_id: child.id,
          pipeline_type: child.pipeline_type,
          card_status: child.status,
          status: approved
            ? "approved"
            : (["approved", "gonza_approved"].includes(reviewStatus || "") ? "pending" : (reviewStatus || "pending")),
          approved_by: approvalIsCurrent ? approvedBy : null,
          launch_generation: approvalLaunchGeneration,
        },
      },
    };
  });
}
