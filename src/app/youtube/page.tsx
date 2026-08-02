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
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
}

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
            and payload ->> 'pipeline_type' = 'video'
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
        .select("id,source_id,source_type,title,status,owner_agent,target_agent_id,created_at,scheduled_for,payload")
        .in("source_type", ["pipeline_item", "service"])
        .eq("payload->>pipeline_type", "video")
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
