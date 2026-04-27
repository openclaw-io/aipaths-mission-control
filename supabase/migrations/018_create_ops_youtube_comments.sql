-- Migration 018: Add canonical YouTube comments storage for strategist snapshots
--
-- Purpose:
-- - move live YouTube comments out of Academy internal analytics
-- - keep Mission Control as the canonical internal home for strategist runtime data
-- - support daily snapshots and comment-based reporting without cross-project reads

CREATE TABLE IF NOT EXISTS ops_youtube_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES ops_owned_videos(academy_video_id) ON DELETE CASCADE,
  comment_id text NOT NULL UNIQUE,
  author_name text,
  author_channel_id text,
  text text NOT NULL,
  like_count integer NOT NULL DEFAULT 0,
  reply_count integer NOT NULL DEFAULT 0,
  is_hearted boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_video
  ON ops_youtube_comments(academy_video_id);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_published
  ON ops_youtube_comments(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_scraped
  ON ops_youtube_comments(scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_author
  ON ops_youtube_comments(author_channel_id);

COMMENT ON TABLE ops_youtube_comments IS 'Canonical YouTube comment storage for owned long-form videos. Absorbs the current Academy youtube_comments dataset.';

ALTER TABLE ops_youtube_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops_youtube_comments authenticated read" ON ops_youtube_comments;
CREATE POLICY "ops_youtube_comments authenticated read"
  ON ops_youtube_comments FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ops_youtube_comments service all" ON ops_youtube_comments;
CREATE POLICY "ops_youtube_comments service all"
  ON ops_youtube_comments FOR ALL TO service_role USING (true) WITH CHECK (true);
