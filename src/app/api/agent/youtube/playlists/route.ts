import { NextResponse, type NextRequest } from "next/server";
import {
  PlaylistQueryError,
  listYouTubePlaylists,
  parsePlaylistQuery,
  resolvePlaylistReference,
} from "@/lib/youtube/playlists";

export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const key = process.env.AGENT_API_KEY;
  if (!key) return false;
  const authorization = req.headers.get("authorization");
  return authorization === `Bearer ${key}`;
}

/**
 * GET /api/agent/youtube/playlists
 * Filters: use_case, tag, status=active|archived|draft|all,
 * include_videos=true|false, resolve=<exact ID|slug|alias>.
 * Resolution is exact-only and returns 404/409 rather than guessing.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const filters = parsePlaylistQuery(req.nextUrl.searchParams);
    const playlists = await listYouTubePlaylists(filters);
    if (filters.resolve) {
      const resolution = resolvePlaylistReference(playlists, filters.resolve);
      if (resolution.state === "not_found") {
        return NextResponse.json({
          resolution: "not_found",
          reference: filters.resolve,
          candidates: [],
          message: "No exact playlist ID, canonical slug, or alias matched; no guess was made.",
        }, { status: 404 });
      }
      if (resolution.state === "ambiguous") {
        return NextResponse.json({
          resolution: "ambiguous",
          reference: filters.resolve,
          candidates: resolution.candidates,
          message: "More than one exact alias matched; no guess was made.",
        }, { status: 409 });
      }
      return NextResponse.json({ resolution: "resolved", playlist: resolution.playlist });
    }

    return NextResponse.json({
      count: playlists.length,
      filters: {
        use_case: filters.useCases,
        tag: filters.tags,
        status: filters.status,
        include_videos: filters.includeVideos,
      },
      playlists,
    });
  } catch (error) {
    if (error instanceof PlaylistQueryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[agent/youtube/playlists] catalog query failed", error);
    return NextResponse.json({ error: "youtube_playlist_catalog_query_failed" }, { status: 500 });
  }
}
