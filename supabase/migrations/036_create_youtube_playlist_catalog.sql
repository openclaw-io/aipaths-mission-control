-- Canonical, read-mostly YouTube playlist catalog.
-- Additive and safe to re-run; this migration never writes to YouTube.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtextextended('mission-control:youtube-playlist-import', 0));

CREATE TABLE IF NOT EXISTS public.youtube_playlists (
  playlist_id text PRIMARY KEY,
  canonical_slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  url text NOT NULL,
  kind text NOT NULL,
  purpose text,
  audience text,
  status text NOT NULL DEFAULT 'draft',
  featured boolean NOT NULL DEFAULT false,
  home_order integer,
  aliases text[] NOT NULL DEFAULT '{}'::text[],
  use_cases text[] NOT NULL DEFAULT '{}'::text[],
  tags text[] NOT NULL DEFAULT '{}'::text[],
  source text NOT NULL DEFAULT 'manual',
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  live_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_observed_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT youtube_playlists_id_check CHECK (playlist_id ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT youtube_playlists_slug_check CHECK (canonical_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT youtube_playlists_kind_check CHECK (kind IN ('hub','official_series','archive','shorts')),
  CONSTRAINT youtube_playlists_status_check CHECK (status IN ('active','archived','draft')),
  CONSTRAINT youtube_playlists_home_order_check CHECK (home_order IS NULL OR home_order > 0),
  CONSTRAINT youtube_playlists_feature_order_check CHECK (NOT featured OR home_order IS NOT NULL),
  CONSTRAINT youtube_playlists_metadata_check CHECK (jsonb_typeof(source_metadata)='object' AND jsonb_typeof(live_metadata)='object')
);

CREATE TABLE IF NOT EXISTS public.youtube_playlist_videos (
  playlist_id text NOT NULL REFERENCES public.youtube_playlists(playlist_id) ON DELETE CASCADE,
  video_id text NOT NULL,
  title text,
  position integer NOT NULL,
  membership_reason text,
  membership_role text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, video_id),
  CONSTRAINT youtube_playlist_videos_id_check CHECK (video_id ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT youtube_playlist_videos_position_check CHECK (position > 0),
  CONSTRAINT youtube_playlist_videos_metadata_check CHECK (jsonb_typeof(source_metadata)='object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_playlist_videos_position
  ON public.youtube_playlist_videos(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_status_home
  ON public.youtube_playlists(status, featured DESC, home_order, canonical_slug);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_use_cases
  ON public.youtube_playlists USING gin(use_cases);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_tags
  ON public.youtube_playlists USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_aliases
  ON public.youtube_playlists USING gin(aliases);
CREATE INDEX IF NOT EXISTS idx_youtube_playlist_videos_order
  ON public.youtube_playlist_videos(playlist_id, position, video_id);

ALTER TABLE public.youtube_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_playlist_videos ENABLE ROW LEVEL SECURITY;
DO $policies$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    DROP POLICY IF EXISTS "youtube_playlists authenticated read" ON public.youtube_playlists;
    EXECUTE 'CREATE POLICY "youtube_playlists authenticated read" ON public.youtube_playlists FOR SELECT TO authenticated USING (true)';
    DROP POLICY IF EXISTS "youtube_playlist_videos authenticated read" ON public.youtube_playlist_videos;
    EXECUTE 'CREATE POLICY "youtube_playlist_videos authenticated read" ON public.youtube_playlist_videos FOR SELECT TO authenticated USING (true)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    DROP POLICY IF EXISTS "youtube_playlists service all" ON public.youtube_playlists;
    EXECUTE 'CREATE POLICY "youtube_playlists service all" ON public.youtube_playlists FOR ALL TO service_role USING (true) WITH CHECK (true)';
    DROP POLICY IF EXISTS "youtube_playlist_videos service all" ON public.youtube_playlist_videos;
    EXECUTE 'CREATE POLICY "youtube_playlist_videos service all" ON public.youtube_playlist_videos FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $policies$;

COMMIT;
