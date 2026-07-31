import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";
import { createScheduledYouTubeLaunchPackage, extractYouTubeVideoId, type JsonRecord } from "@/lib/youtube-launch-package";
import { createScheduledYouTubeLaunchPackageLocal } from "@/lib/youtube-launch-package-local";

export const dynamic = "force-dynamic";

function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function checkAgentAuth(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === process.env.AGENT_API_KEY;
}

async function getRequester(request: NextRequest, useLocalMode: boolean) {
  if (checkAgentAuth(request)) return "agent:strategist";

  if (useLocalMode) {
    return getLocalMissionControlUser()?.email || null;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.email || user?.id || null;
}

function bodyString(body: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = trimToNull(body[key]);
    if (value) return value;
  }
  return null;
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/youtube/launch-package",
    purpose: "Create or rerun a scheduled YouTube launch package from a scheduled YouTube URL/video_id + publish_at. Newsletter is excluded in V1; Marketing email announcement handoff is included.",
    auth: "Mission Control user session or Authorization bearer agent API key.",
    body: {
      youtube_url: "https://www.youtube.com/watch?v=Dn1pJz5fq-w",
      publish_at: "2026-07-07T14:00:00Z",
      title: "Cómo construí un equipo usando IA",
      playlist_context_url: "https://www.youtube.com/watch?v=Dn1pJz5fq-w&list=PLAYLIST_ID",
      target_email_send_at: "Optional ISO date; defaults to publish_at+3h",
      email_tracking_ref: "Optional; defaults to email-youtube-<video_id>",
      optional_diagnostic_cta: "Optional diagnostic CTA URL for Marketing context",
      refs: { optional: "Any reference links/context Strategist wants preserved" },
    },
    creates_or_updates: [
      "video pipeline item metadata.launch_package without setting published_at",
      "strategist live-check work item at publish_at+2m",
      "community Ready-for-Review draft work item; approval later targets publish_at+30m",
      "dev website publish work item at publish_at+15m",
      "marketing email campaign draft handoff; approval later targets publish_at+3h by default",
      "YouTube pinned-comment draft handoff for Gonza review",
      "YouTube launch preflight at T-30m or immediately when inside that window",
      "YouTube snapshot work items at +24h, +7d, +28d",
    ],
    dedupe: "work_items payload video_id + relation_type; reruns update open schedules/instructions and preserve terminal work items",
  });
}

export async function POST(request: NextRequest) {
  const useLocalMode = isLocalAuthDisabled();
  const requester = await getRequester(request, useLocalMode);
  if (!requester) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: JsonRecord;
  try {
    body = (await request.json()) as JsonRecord;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const youtubeUrl = bodyString(body, ["youtube_url", "youtubeUrl", "video_url", "url"]);
  const videoId = bodyString(body, ["video_id", "videoId", "youtube_video_id"]) || extractYouTubeVideoId(youtubeUrl);
  const publishAt = bodyString(body, ["publish_at", "publishAt", "scheduled_publish_at"]);
  const title = bodyString(body, ["title", "video_title"]);
  const playlistContextUrl = bodyString(body, ["playlist_context_url", "playlistContextUrl", "playlist_url", "playlistUrl"]);
  const playlistId = bodyString(body, ["playlist_id", "playlistId"]);
  const cta = bodyString(body, ["cta", "community_cta", "communityCta"]);
  const targetEmailSendAt = bodyString(body, ["target_email_send_at", "targetEmailSendAt"]);
  const emailTrackingRef = bodyString(body, ["email_tracking_ref", "emailTrackingRef"]);
  const optionalDiagnosticCta = bodyString(body, ["optional_diagnostic_cta", "optionalDiagnosticCta", "diagnostic_cta", "diagnosticCta"]);
  const preparedAt = bodyString(body, ["prepared_at", "preparedAt"]);

  if (!publishAt) return NextResponse.json({ error: "publish_at is required" }, { status: 400 });
  if (!youtubeUrl && !videoId) return NextResponse.json({ error: "youtube_url or video_id is required" }, { status: 400 });

  try {
    const launchInput = {
      youtubeUrl,
      videoId,
      publishAt,
      title,
      playlistContextUrl,
      playlistId,
      cta,
      targetEmailSendAt,
      emailTrackingRef,
      optionalDiagnosticCta,
      preparedAt,
      refs: body.refs ?? body.references ?? null,
      requestedBy: bodyString(body, ["requested_by", "requestedBy"]) || requester,
    };
    const result = useLocalMode
      ? await createScheduledYouTubeLaunchPackageLocal(launchInput)
      : await createScheduledYouTubeLaunchPackage(createServiceClient(), launchInput);

    return NextResponse.json({
      ok: true,
      video_item_id: result.videoItem.id,
      community_item_id: result.communityItem.id,
      marketing_item_id: result.marketingItem.id,
      pinned_comment_item_id: result.pinnedCommentItem.id,
      video_id: result.videoId,
      youtube_url: result.youtubeUrl,
      playlist_context_url: result.playlistContextUrl,
      publish_at: result.publishAt,
      target_community_publish_at: result.targetCommunityPublishAt,
      target_email_send_at: result.targetEmailSendAt,
      video_item_created: result.videoItemCreated,
      community_item_created: result.communityItemCreated,
      marketing_item_created: result.marketingItemCreated,
      pinned_comment_item_created: result.pinnedCommentItemCreated,
      work_items: result.workItems.map((entry) => ({
        relation_type: entry.relationType,
        id: entry.workItem?.id,
        status: entry.workItem?.status,
        created: entry.created,
        updated: entry.updated,
        skipped: entry.skipped,
      })),
      newsletter_scope: "excluded_v1",
      email_campaign_handoff: "included_v1_marketing_owned",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
