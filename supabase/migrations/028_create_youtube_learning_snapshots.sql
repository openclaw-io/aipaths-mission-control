-- Migration 028: Create canonical YouTube Statistics learning snapshot table
-- Run in Supabase SQL Editor
--
-- Purpose:
-- - keep automated YouTube Statistics metrics out of pipeline_items.metadata
-- - support /statistics with a canonical per-video/per-window read model
-- - preserve pipeline_items.metadata.youtube_learning_v1 for manual qualitative review only

CREATE TABLE IF NOT EXISTS ops_youtube_video_learning_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES ops_owned_videos(academy_video_id) ON DELETE CASCADE,
  window_key text NOT NULL CHECK (window_key IN ('7d', '28d', 'lifetime', 'launch_day', 'first_7d', 'first_28d')),
  window_start_date date,
  window_end_date date,

  views integer,
  impressions integer,
  yt_ctr numeric,
  avg_view_duration_seconds numeric,
  avg_percent_viewed numeric,
  retention_30s numeric,
  retention_50pct numeric,
  retention_75pct numeric,
  watch_time_minutes numeric,
  subscribers_gained integer,
  traffic_source_top text,

  launch_day_impressions integer,
  launch_day_yt_ctr numeric,
  first_7d_impressions integer,
  first_7d_yt_ctr numeric,
  first_7d_reach_days_covered integer,

  source_freshness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (academy_video_id, window_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_learning_window
  ON ops_youtube_video_learning_snapshots(window_key, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_learning_video
  ON ops_youtube_video_learning_snapshots(academy_video_id);

ALTER TABLE ops_youtube_video_learning_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops_youtube_learning authenticated read" ON ops_youtube_video_learning_snapshots;
CREATE POLICY "ops_youtube_learning authenticated read"
  ON ops_youtube_video_learning_snapshots FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ops_youtube_learning service all" ON ops_youtube_video_learning_snapshots;
CREATE POLICY "ops_youtube_learning service all"
  ON ops_youtube_video_learning_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ops_youtube_video_learning_snapshots IS
  'Dashboard-ready YouTube long-form performance snapshots by analysis window. Computed from YouTube MCP, Reporting API reach cache, and Mission Control owned video metadata.';
