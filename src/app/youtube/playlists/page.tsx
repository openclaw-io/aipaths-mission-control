import { YouTubePlaylistCatalog } from "@/components/youtube/YouTubePlaylistCatalog";
import { listYouTubePlaylists } from "@/lib/youtube/playlists";

export const dynamic = "force-dynamic";

export default async function YouTubePlaylistsPage() {
  const playlists = await listYouTubePlaylists({
    useCases: [],
    tags: [],
    status: "active",
    includeVideos: true,
    resolve: null,
  });
  return <YouTubePlaylistCatalog playlists={playlists} />;
}
