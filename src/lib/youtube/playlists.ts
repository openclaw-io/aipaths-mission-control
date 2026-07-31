import { normalizeRows } from "@/lib/db/mission-control";
import { query } from "@/lib/db/postgres";

export type YouTubePlaylistStatus = "active" | "archived" | "draft";
export type YouTubePlaylistKind = "hub" | "official_series" | "archive" | "shorts";

export interface YouTubePlaylistVideo {
  playlist_id: string;
  video_id: string;
  title: string | null;
  position: number;
  membership_reason: string | null;
  membership_role: string | null;
  source_metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface YouTubePlaylist {
  playlist_id: string;
  canonical_slug: string;
  title: string;
  description: string | null;
  url: string;
  kind: YouTubePlaylistKind;
  purpose: string | null;
  audience: string | null;
  status: YouTubePlaylistStatus;
  featured: boolean;
  home_order: number | null;
  aliases: string[];
  use_cases: string[];
  tags: string[];
  source?: string;
  source_metadata?: Record<string, unknown>;
  live_metadata?: Record<string, unknown>;
  source_observed_at?: string | null;
  last_synced_at?: string | null;
  created_at?: string;
  updated_at?: string;
  videos?: YouTubePlaylistVideo[];
}

export interface PlaylistQuery {
  useCases: string[];
  tags: string[];
  status: YouTubePlaylistStatus | "all";
  includeVideos: boolean;
  resolve: string | null;
}

export class PlaylistQueryError extends Error {
  status = 400;
}

function values(params: URLSearchParams, key: string): string[] {
  return params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function parsePlaylistQuery(params: URLSearchParams): PlaylistQuery {
  const status = (params.get("status") || "active").trim().toLowerCase();
  if (!["active", "archived", "draft", "all"].includes(status)) {
    throw new PlaylistQueryError("status must be one of: active, archived, draft, all");
  }
  const rawIncludeVideos = (params.get("include_videos") || "false").trim().toLowerCase();
  if (!["true", "false"].includes(rawIncludeVideos)) {
    throw new PlaylistQueryError("include_videos must be true or false");
  }
  const resolve = params.get("resolve")?.trim() || null;
  if (resolve !== null && resolve.length > 200) throw new PlaylistQueryError("resolve is too long");

  return {
    useCases: values(params, "use_case"),
    tags: values(params, "tag"),
    status: status as PlaylistQuery["status"],
    includeVideos: rawIncludeVideos === "true",
    resolve,
  };
}

export async function listYouTubePlaylists(filters: PlaylistQuery): Promise<YouTubePlaylist[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status !== "all") {
    params.push(filters.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (filters.useCases.length) {
    params.push(filters.useCases);
    conditions.push(`p.use_cases @> $${params.length}::text[]`);
  }
  if (filters.tags.length) {
    params.push(filters.tags);
    conditions.push(`p.tags @> $${params.length}::text[]`);
  }

  const playlistResult = await query<YouTubePlaylist>(`
    SELECT p.playlist_id, p.canonical_slug, p.title, p.description, p.url, p.kind,
           p.purpose, p.audience, p.status, p.featured, p.home_order, p.aliases,
           p.use_cases, p.tags, p.source, p.source_metadata, p.live_metadata,
           p.source_observed_at, p.last_synced_at, p.created_at, p.updated_at
      FROM public.youtube_playlists p
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY p.featured DESC, p.home_order ASC NULLS LAST, p.canonical_slug ASC, p.playlist_id ASC
  `, params);
  const playlists = normalizeRows(playlistResult.rows);
  if (!filters.includeVideos || playlists.length === 0) return playlists;

  const membershipResult = await query<YouTubePlaylistVideo>(`
    SELECT playlist_id, video_id, title, position, membership_reason, membership_role,
           source_metadata, created_at, updated_at
      FROM public.youtube_playlist_videos
     WHERE playlist_id = ANY($1::text[])
     ORDER BY playlist_id ASC, position ASC, video_id ASC
  `, [playlists.map((playlist) => playlist.playlist_id)]);
  const videos = normalizeRows(membershipResult.rows).sort((left, right) =>
    left.playlist_id.localeCompare(right.playlist_id)
      || left.position - right.position
      || left.video_id.localeCompare(right.video_id));
  const byPlaylist = new Map<string, YouTubePlaylistVideo[]>();
  for (const video of videos) {
    const current = byPlaylist.get(video.playlist_id) || [];
    current.push(video);
    byPlaylist.set(video.playlist_id, current);
  }
  return playlists.map((playlist) => ({ ...playlist, videos: byPlaylist.get(playlist.playlist_id) || [] }));
}

export type PlaylistResolution =
  | { state: "resolved"; playlist: YouTubePlaylist; candidates: string[] }
  | { state: "not_found"; candidates: string[] }
  | { state: "ambiguous"; candidates: string[] };

export function resolvePlaylistReference(playlists: YouTubePlaylist[], reference: string): PlaylistResolution {
  const raw = reference.trim();
  const normalized = raw.toLowerCase();
  if (!raw) return { state: "not_found", candidates: [] };
  const matches = playlists.filter((playlist) =>
    playlist.playlist_id === raw
    || playlist.canonical_slug.toLowerCase() === normalized
    || (playlist.aliases || []).some((alias) => alias.trim().toLowerCase() === normalized));
  if (matches.length === 0) return { state: "not_found", candidates: [] };
  if (matches.length > 1) return { state: "ambiguous", candidates: matches.map((playlist) => playlist.playlist_id) };
  return { state: "resolved", playlist: matches[0], candidates: [matches[0].playlist_id] };
}
