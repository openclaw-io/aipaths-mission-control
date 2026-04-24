-- Migration 016: Create strategist internal analytics destination schema
-- Run in Supabase SQL Editor
--
-- Purpose:
-- - establish Mission Control as the canonical internal home for strategist/intelligence data
-- - keep Academy as the product/web source of truth
-- - create canonical tables + curated snapshot layer for agents
--
-- This migration intentionally:
-- - creates destination tables only
-- - does NOT yet backfill data
-- - does NOT yet cut over strategist scripts/readers
-- - does NOT touch `agent_memory` / `cron_health`
-- - does NOT create optional comment or weekly snapshot tables yet

-- =====================================================
-- 1. Pipeline / provenance
-- =====================================================

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_type text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'error', 'partial')),
  source_system text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_read integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  error_summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_type_started
  ON pipeline_runs(run_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status_started
  ON pipeline_runs(status, started_at DESC);

COMMENT ON TABLE pipeline_runs IS 'Generic provenance/run log for strategist analytics syncs, backfills, and snapshot builders.';

-- =====================================================
-- 2. External intelligence canonical layer
-- =====================================================

CREATE TABLE IF NOT EXISTS intel_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('industry', 'trend', 'competitor')),
  source_type text NOT NULL,
  base_url text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intel_sources IS 'Registry of external intelligence sources such as Hacker News, Reddit, Product Hunt, RSS news, and Google Trends.';

CREATE TABLE IF NOT EXISTS intel_items_raw (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES intel_sources(id) ON DELETE RESTRICT,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  lane text NOT NULL CHECK (lane IN ('industry', 'trend', 'competitor')),
  captured_on date,
  external_id text,
  url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  author text,
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  engagement_score numeric NOT NULL DEFAULT 0,
  engagement_count integer NOT NULL DEFAULT 0,
  source_context text,
  content_text text,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text,
  language text,
  fetch_status text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, canonical_url)
);

CREATE INDEX IF NOT EXISTS idx_intel_items_raw_lane_seen
  ON intel_items_raw(lane, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_intel_items_raw_captured_on
  ON intel_items_raw(captured_on DESC);

CREATE INDEX IF NOT EXISTS idx_intel_items_raw_engagement
  ON intel_items_raw(engagement_score DESC, engagement_count DESC);

COMMENT ON TABLE intel_items_raw IS 'Canonical raw-ish storage for external/internal intelligence items. Absorbs the current Academy external_signals dataset.';

CREATE TABLE IF NOT EXISTS intel_trend_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL,
  keyword text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  country text NOT NULL DEFAULT 'AR',
  source_key text NOT NULL DEFAULT 'google_trends',
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, keyword, country, source_key)
);

CREATE INDEX IF NOT EXISTS idx_intel_trend_daily_keyword_date
  ON intel_trend_daily(keyword, date DESC);

CREATE INDEX IF NOT EXISTS idx_intel_trend_daily_date
  ON intel_trend_daily(date DESC);

COMMENT ON TABLE intel_trend_daily IS 'Canonical daily trend snapshot table. Absorbs the current Academy trend_snapshots dataset.';

-- Seed baseline sources used by the current strategist pipeline
INSERT INTO intel_sources (source_key, name, lane, source_type, base_url, enabled)
VALUES
  ('hackernews', 'Hacker News', 'trend', 'api', 'https://news.ycombinator.com', true),
  ('reddit', 'Reddit', 'trend', 'api', 'https://www.reddit.com', true),
  ('producthunt', 'Product Hunt', 'trend', 'api', 'https://www.producthunt.com', true),
  ('news', 'AI News RSS', 'industry', 'rss', null, true),
  ('google_trends', 'Google Trends', 'trend', 'api', null, true)
ON CONFLICT (source_key) DO UPDATE
SET
  name = EXCLUDED.name,
  lane = EXCLUDED.lane,
  source_type = EXCLUDED.source_type,
  base_url = EXCLUDED.base_url,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- =====================================================
-- 3. Owned YouTube / community operational layer
-- =====================================================

CREATE TABLE IF NOT EXISTS ops_owned_videos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academy_video_id text NOT NULL UNIQUE,
  platform text NOT NULL DEFAULT 'youtube',
  platform_video_id text NOT NULL,
  title text NOT NULL,
  published_at timestamptz,
  video_kind text NOT NULL CHECK (video_kind IN ('longform', 'short')),
  is_published boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_owned_videos_kind_published
  ON ops_owned_videos(video_kind, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_owned_videos_platform_id
  ON ops_owned_videos(platform_video_id);

COMMENT ON TABLE ops_owned_videos IS 'Minimal local mirror of Academy-owned videos for internal joins. Avoids cross-project foreign keys.';

CREATE TABLE IF NOT EXISTS ops_youtube_video_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES ops_owned_videos(academy_video_id) ON DELETE RESTRICT,
  date date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments_count integer NOT NULL DEFAULT 0,
  subscribers_gained integer NOT NULL DEFAULT 0,
  watch_time_minutes numeric NOT NULL DEFAULT 0,
  avg_view_duration_seconds numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_video_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_video_daily_date
  ON ops_youtube_video_daily(date DESC);

COMMENT ON TABLE ops_youtube_video_daily IS 'Canonical daily long-form YouTube video snapshots. Absorbs the current Academy youtube_metrics dataset.';

CREATE TABLE IF NOT EXISTS ops_youtube_short_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES ops_owned_videos(academy_video_id) ON DELETE RESTRICT,
  date date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_video_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ops_youtube_short_daily_date
  ON ops_youtube_short_daily(date DESC);

COMMENT ON TABLE ops_youtube_short_daily IS 'Canonical daily YouTube Shorts snapshots. Added because current daily_digest depends on youtube_shorts_metrics.';

CREATE TABLE IF NOT EXISTS ops_youtube_channel_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL UNIQUE,
  subscribers integer NOT NULL DEFAULT 0,
  total_views integer NOT NULL DEFAULT 0,
  watch_time_minutes numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  videos_published integer NOT NULL DEFAULT 0,
  net_subscribers integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops_youtube_channel_daily IS 'Canonical daily channel-level YouTube snapshots. Absorbs the current Academy channel_metrics dataset.';

CREATE TABLE IF NOT EXISTS ops_community_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL,
  channel_id text NOT NULL,
  channel_name text,
  message_count integer NOT NULL DEFAULT 0,
  unique_authors integer NOT NULL DEFAULT 0,
  notable_messages_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_community_daily_date
  ON ops_community_daily(date DESC);

COMMENT ON TABLE ops_community_daily IS 'Canonical daily Discord community aggregates. Absorbs the current Academy community_activity dataset.';

-- =====================================================
-- 4. Imported product rollups from Academy
-- =====================================================

CREATE TABLE IF NOT EXISTS academy_daily_kpis (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL UNIQUE,
  total_users integer NOT NULL DEFAULT 0,
  new_users_today integer NOT NULL DEFAULT 0,
  total_subscribers integer NOT NULL DEFAULT 0,
  new_subscribers_today integer NOT NULL DEFAULT 0,
  waitlist_total integer NOT NULL DEFAULT 0,
  waitlist_new_today integer NOT NULL DEFAULT 0,
  orders_count_today integer NOT NULL DEFAULT 0,
  revenue_usd_today numeric NOT NULL DEFAULT 0,
  total_sessions integer NOT NULL DEFAULT 0,
  youtube_sessions integer NOT NULL DEFAULT 0,
  lead_magnet_downloads_today integer NOT NULL DEFAULT 0,
  funnel_json jsonb,
  source_notes_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE academy_daily_kpis IS 'Daily imported Academy product rollups needed for strategist snapshots. Keeps Academy as product owner while allowing unified internal reporting.';

-- =====================================================
-- 5. Curated read-model layer
-- =====================================================

CREATE TABLE IF NOT EXISTS ops_daily_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date date NOT NULL UNIQUE,
  build_run_id bigint REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  snapshot_version text NOT NULL DEFAULT 'v2',
  youtube_json jsonb,
  channel_json jsonb,
  shorts_json jsonb,
  trends_json jsonb,
  community_json jsonb,
  academy_json jsonb,
  signals_json jsonb,
  waitlist_json jsonb,
  notes text,
  lineage_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_daily_snapshots_date
  ON ops_daily_snapshots(date DESC);

COMMENT ON TABLE ops_daily_snapshots IS 'Curated daily strategist snapshot layer. Replaces daily_digest and stores structured JSONB with lineage instead of stringified JSON.';

-- =====================================================
-- 6. Row Level Security
-- =====================================================

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_items_raw ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_trend_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_owned_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_youtube_video_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_youtube_short_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_youtube_channel_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_community_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE academy_daily_kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_daily_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pipeline_runs authenticated read" ON pipeline_runs;
CREATE POLICY "pipeline_runs authenticated read"
  ON pipeline_runs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pipeline_runs service all" ON pipeline_runs;
CREATE POLICY "pipeline_runs service all"
  ON pipeline_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "intel_sources authenticated read" ON intel_sources;
CREATE POLICY "intel_sources authenticated read"
  ON intel_sources FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "intel_sources service all" ON intel_sources;
CREATE POLICY "intel_sources service all"
  ON intel_sources FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "intel_items_raw authenticated read" ON intel_items_raw;
CREATE POLICY "intel_items_raw authenticated read"
  ON intel_items_raw FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "intel_items_raw service all" ON intel_items_raw;
CREATE POLICY "intel_items_raw service all"
  ON intel_items_raw FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "intel_trend_daily authenticated read" ON intel_trend_daily;
CREATE POLICY "intel_trend_daily authenticated read"
  ON intel_trend_daily FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "intel_trend_daily service all" ON intel_trend_daily;
CREATE POLICY "intel_trend_daily service all"
  ON intel_trend_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_owned_videos authenticated read" ON ops_owned_videos;
CREATE POLICY "ops_owned_videos authenticated read"
  ON ops_owned_videos FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_owned_videos service all" ON ops_owned_videos;
CREATE POLICY "ops_owned_videos service all"
  ON ops_owned_videos FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_youtube_video_daily authenticated read" ON ops_youtube_video_daily;
CREATE POLICY "ops_youtube_video_daily authenticated read"
  ON ops_youtube_video_daily FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_youtube_video_daily service all" ON ops_youtube_video_daily;
CREATE POLICY "ops_youtube_video_daily service all"
  ON ops_youtube_video_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_youtube_short_daily authenticated read" ON ops_youtube_short_daily;
CREATE POLICY "ops_youtube_short_daily authenticated read"
  ON ops_youtube_short_daily FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_youtube_short_daily service all" ON ops_youtube_short_daily;
CREATE POLICY "ops_youtube_short_daily service all"
  ON ops_youtube_short_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_youtube_channel_daily authenticated read" ON ops_youtube_channel_daily;
CREATE POLICY "ops_youtube_channel_daily authenticated read"
  ON ops_youtube_channel_daily FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_youtube_channel_daily service all" ON ops_youtube_channel_daily;
CREATE POLICY "ops_youtube_channel_daily service all"
  ON ops_youtube_channel_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_community_daily authenticated read" ON ops_community_daily;
CREATE POLICY "ops_community_daily authenticated read"
  ON ops_community_daily FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_community_daily service all" ON ops_community_daily;
CREATE POLICY "ops_community_daily service all"
  ON ops_community_daily FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "academy_daily_kpis authenticated read" ON academy_daily_kpis;
CREATE POLICY "academy_daily_kpis authenticated read"
  ON academy_daily_kpis FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "academy_daily_kpis service all" ON academy_daily_kpis;
CREATE POLICY "academy_daily_kpis service all"
  ON academy_daily_kpis FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ops_daily_snapshots authenticated read" ON ops_daily_snapshots;
CREATE POLICY "ops_daily_snapshots authenticated read"
  ON ops_daily_snapshots FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ops_daily_snapshots service all" ON ops_daily_snapshots;
CREATE POLICY "ops_daily_snapshots service all"
  ON ops_daily_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
