import type { YouTubePlaylist } from "@/lib/youtube/playlists";

export function YouTubePlaylistCatalog({ playlists }: { playlists: YouTubePlaylist[] }) {
  return (
    <main className="min-h-screen bg-[#0b0b11] p-8 text-gray-100">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-red-400">AIPaths · read-only</p>
          <h1 className="text-3xl font-bold text-white">YouTube Playlist Catalog</h1>
          <p className="mt-2 max-w-3xl text-sm text-gray-400">
            Canonical Mission Control view of active playlists and evidenced memberships. Editorial and live YouTube changes are managed through the audited import workflow.
          </p>
        </header>

        {playlists.length === 0 ? (
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-8 text-gray-400">
            No active playlists have been imported. The catalog does not infer or guess missing entries.
          </section>
        ) : (
          <div className="space-y-5">
            {playlists.map((playlist) => (
              <article key={playlist.playlist_id} className="rounded-xl border border-white/10 bg-[#14141d] p-6 shadow-lg shadow-black/10">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="mb-2 flex flex-wrap gap-2 text-xs">
                      <span className="rounded bg-red-500/15 px-2 py-1 font-medium text-red-300">{playlist.kind}</span>
                      {playlist.featured && <span className="rounded bg-amber-500/15 px-2 py-1 font-medium text-amber-300">Home #{playlist.home_order}</span>}
                      <span className="rounded bg-emerald-500/15 px-2 py-1 font-medium text-emerald-300">{playlist.status}</span>
                    </div>
                    <h2 className="text-xl font-semibold text-white">{playlist.title}</h2>
                    <p className="mt-1 font-mono text-xs text-gray-500">{playlist.canonical_slug} · {playlist.playlist_id}</p>
                  </div>
                  <a className="rounded-lg border border-red-400/30 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10" href={playlist.url} target="_blank" rel="noreferrer">
                    Open on YouTube ↗
                  </a>
                </div>

                <dl className="mt-5 grid gap-4 md:grid-cols-2">
                  <div><dt className="text-xs uppercase tracking-wide text-gray-500">Purpose</dt><dd className="mt-1 text-sm text-gray-200">{playlist.purpose || "Not evidenced"}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-gray-500">Audience</dt><dd className="mt-1 text-sm text-gray-200">{playlist.audience || "Not evidenced"}</dd></div>
                  {playlist.description && <div className="md:col-span-2"><dt className="text-xs uppercase tracking-wide text-gray-500">Description</dt><dd className="mt-1 text-sm text-gray-300">{playlist.description}</dd></div>}
                </dl>

                <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold uppercase tracking-wide text-gray-500">Uses</span>
                  {playlist.use_cases.length ? playlist.use_cases.map((useCase) => <span key={useCase} className="rounded-full bg-blue-500/10 px-2 py-1 text-blue-300">{useCase}</span>) : <span className="text-gray-500">Not evidenced</span>}
                  {playlist.tags.map((tag) => <span key={tag} className="rounded-full bg-white/5 px-2 py-1 text-gray-400">#{tag}</span>)}
                </div>

                <section className="mt-6 border-t border-white/10 pt-4">
                  <h3 className="text-sm font-semibold text-gray-200">Memberships ({playlist.videos?.length || 0})</h3>
                  {playlist.videos?.length ? (
                    <ol className="mt-3 grid gap-2 md:grid-cols-2">
                      {playlist.videos.map((video) => (
                        <li key={video.video_id} className="rounded-lg bg-black/20 p-3 text-sm text-gray-300">
                          <a className="hover:text-red-300" href={`https://www.youtube.com/watch?v=${video.video_id}`} target="_blank" rel="noreferrer">
                            {video.position}. {video.title || `[untitled: ${video.video_id}]`}
                          </a>
                          <div className="mt-1 font-mono text-[11px] text-gray-600">{video.video_id} · {video.membership_role || "role not evidenced"}</div>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="mt-2 text-sm text-gray-500">No evidenced memberships imported.</p>}
                </section>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
