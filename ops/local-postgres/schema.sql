-- Mission Control local Postgres schema baseline
-- Phase 1 local-only bootstrap. Intentionally avoids Supabase Cloud/RLS assumptions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Local utility state / runtime config
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.system_cursors (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.scheduler_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.scheduler_config (key, value) VALUES
  ('enabled', 'true'),
  ('max_concurrent', '2'),
  ('daily_budget_usd', '50'),
  ('schedule_minutes', '10')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.execution_window_config (
  id text PRIMARY KEY DEFAULT 'global',
  timezone text NOT NULL DEFAULT 'Europe/London',
  base_schedule jsonb NOT NULL DEFAULT '{
    "monday":[{"start":"00:00","end":"23:59"}],
    "tuesday":[{"start":"00:00","end":"23:59"}],
    "wednesday":[{"start":"00:00","end":"23:59"}],
    "thursday":[{"start":"00:00","end":"23:59"}],
    "friday":[{"start":"00:00","end":"23:59"}],
    "saturday":[{"start":"00:00","end":"23:59"}],
    "sunday":[{"start":"00:00","end":"23:59"}]
  }'::jsonb,
  override_mode text NOT NULL DEFAULT 'auto',
  override_until timestamptz,
  override_reason text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.execution_window_config (id)
VALUES ('global')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'unknown',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Cron/runtime health
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cron_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name text NOT NULL UNIQUE,
  schedule text,
  description text,
  category text NOT NULL DEFAULT 'scheduled',
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_status text NOT NULL DEFAULT 'unknown',
  last_duration_ms integer,
  last_error text,
  rows_affected integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_health ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'scheduled';
ALTER TABLE public.cron_health ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.cron_health ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cron_health ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.cron_health ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_cron_health_name ON public.cron_health(cron_name);
CREATE INDEX IF NOT EXISTS idx_cron_health_enabled_category ON public.cron_health(enabled, category);

CREATE TABLE IF NOT EXISTS public.cron_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name text NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  error text,
  rows_affected integer NOT NULL DEFAULT 0,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_logs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_cron_logs_name_started ON public.cron_logs(cron_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_logs_status_started ON public.cron_logs(status, started_at DESC);

-- -----------------------------------------------------------------------------
-- Work Queue
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid,
  parent_id uuid,
  kind text NOT NULL DEFAULT 'task',
  source_type text,
  source_id text,
  title text NOT NULL,
  instruction text,
  status text NOT NULL DEFAULT 'ready',
  priority text NOT NULL DEFAULT 'medium',
  owner_agent text,
  target_agent_id text,
  requested_by text,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS loop_id uuid;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS parent_id uuid;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS instruction text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS owner_agent text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS target_agent_id text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.work_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_parent_id_fkey' AND conrelid = 'public.work_items'::regclass) THEN
    ALTER TABLE public.work_items ADD CONSTRAINT work_items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.work_items(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_items_status_created ON public.work_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_status_scheduled ON public.work_items(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_work_items_owner_status ON public.work_items(owner_agent, status);
CREATE INDEX IF NOT EXISTS idx_work_items_target_status ON public.work_items(target_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_source ON public.work_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_work_items_loop ON public.work_items(loop_id);
CREATE INDEX IF NOT EXISTS idx_work_items_payload_gin ON public.work_items USING gin(payload);
CREATE INDEX IF NOT EXISTS idx_work_items_payload_pipeline_type ON public.work_items((payload ->> 'pipeline_type'));
CREATE INDEX IF NOT EXISTS idx_work_items_payload_relation_type ON public.work_items((payload ->> 'relation_type'));
CREATE INDEX IF NOT EXISTS idx_work_items_payload_dedupe_key ON public.work_items((payload ->> 'dedupe_key'));

CREATE TABLE IF NOT EXISTS public.work_item_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  depends_on_work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id, depends_on_work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_work_item_dependencies_work_item ON public.work_item_dependencies(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_item_dependencies_depends_on ON public.work_item_dependencies(depends_on_work_item_id);

CREATE TABLE IF NOT EXISTS public.event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL DEFAULT 'work',
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_log ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'work';
ALTER TABLE public.event_log ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE public.event_log ADD COLUMN IF NOT EXISTS entity_id uuid;
ALTER TABLE public.event_log ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE public.event_log ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_event_log_domain_created ON public.event_log(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_entity ON public.event_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_event_created ON public.event_log(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.recurring_work_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  instruction text NOT NULL,
  owner_agent text NOT NULL,
  target_agent_id text,
  requested_by text NOT NULL DEFAULT 'system',
  priority text NOT NULL DEFAULT 'medium',
  cadence_unit text NOT NULL DEFAULT 'days',
  cadence_interval integer NOT NULL DEFAULT 1,
  time_of_day text NOT NULL DEFAULT '02:30',
  timezone text NOT NULL DEFAULT 'Europe/London',
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  horizon_days integer NOT NULL DEFAULT 28,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_materialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_work_rules_enabled ON public.recurring_work_rules(enabled, start_date);

CREATE TABLE IF NOT EXISTS public.recurring_work_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.recurring_work_rules(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  work_item_id uuid REFERENCES public.work_items(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'materialized',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS idx_recurring_work_occurrences_rule_scheduled ON public.recurring_work_occurrences(rule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_recurring_work_occurrences_work_item ON public.recurring_work_occurrences(work_item_id);

-- -----------------------------------------------------------------------------
-- Content pipeline
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pipeline_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid,
  pipeline_type text NOT NULL,
  title text NOT NULL,
  slug text,
  status text NOT NULL DEFAULT 'draft',
  priority text DEFAULT 'medium',
  owner_agent text,
  target_agent_id text,
  requested_by text,
  source_type text,
  source_id text,
  scheduled_for timestamptz,
  published_at timestamptz,
  current_url text,
  content_path text,
  content_format text,
  content_body text,
  asset_role text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS target_agent_id text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS loop_id uuid;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS current_url text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS content_path text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS content_format text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS content_body text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS asset_role text;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.pipeline_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_pipeline_items_type_status_created ON public.pipeline_items(pipeline_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_owner_status ON public.pipeline_items(owner_agent, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_scheduled ON public.pipeline_items(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_source ON public.pipeline_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_loop ON public.pipeline_items(loop_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_metadata_gin ON public.pipeline_items USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_intel_enriched ON public.pipeline_items((metadata -> 'intel' ->> 'enriched_item_id'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_items_intel_inbox_destination_unique
  ON public.pipeline_items (
    ((metadata ->> 'intel_source_type')),
    ((metadata ->> 'intel_enriched_item_id')),
    ((metadata ->> 'intel_destination_key'))
  )
  WHERE (metadata ->> 'intel_source_type') = 'intel_inbox'
    AND metadata ? 'intel_enriched_item_id'
    AND metadata ? 'intel_destination_key';

CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_item_id uuid REFERENCES public.pipeline_items(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor text,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_item_created ON public.pipeline_events(pipeline_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_type_created ON public.pipeline_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pipeline_work_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_item_id uuid NOT NULL REFERENCES public.pipeline_items(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_item_id, work_item_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_work_map_pipeline ON public.pipeline_work_map(pipeline_item_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_work_map_work ON public.pipeline_work_map(work_item_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_work_map_relation ON public.pipeline_work_map(relation_type);

-- -----------------------------------------------------------------------------
-- Loops
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE,
  name text NOT NULL,
  description text,
  summary text,
  type text NOT NULL DEFAULT 'ops',
  status text NOT NULL DEFAULT 'planning',
  priority text NOT NULL DEFAULT 'medium',
  owner_agent text,
  target_outcome text,
  acceptance_criteria text[] NOT NULL DEFAULT '{}'::text[],
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deferred_until timestamptz,
  archived_at timestamptz,
  last_approved_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'ops';
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS target_outcome text;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS acceptance_criteria text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS plan jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS clarification_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS approval_scope jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS deferred_until timestamptz;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS last_approved_at timestamptz;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS last_started_at timestamptz;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS last_completed_at timestamptz;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_loop_id_fkey' AND conrelid = 'public.work_items'::regclass) THEN
    ALTER TABLE public.work_items ADD CONSTRAINT work_items_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_items_loop_id_fkey' AND conrelid = 'public.pipeline_items'::regclass) THEN
    ALTER TABLE public.pipeline_items ADD CONSTRAINT pipeline_items_loop_id_fkey FOREIGN KEY (loop_id) REFERENCES public.loops(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_loops_status_updated ON public.loops(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_loops_owner_status ON public.loops(owner_agent, status);
CREATE INDEX IF NOT EXISTS idx_loops_deferred_until ON public.loops(deferred_until);
CREATE INDEX IF NOT EXISTS idx_loops_metadata_gin ON public.loops USING gin(metadata);

CREATE TABLE IF NOT EXISTS public.loop_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid NOT NULL REFERENCES public.loops(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loop_events_loop_created ON public.loop_events(loop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loop_events_type_created ON public.loop_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.loop_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid NOT NULL REFERENCES public.loops(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loop_id, work_item_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_loop_work_items_loop ON public.loop_work_items(loop_id);
CREATE INDEX IF NOT EXISTS idx_loop_work_items_work ON public.loop_work_items(work_item_id);
CREATE INDEX IF NOT EXISTS idx_loop_work_items_relation ON public.loop_work_items(relation_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_work_items_primary_execution
  ON public.loop_work_items(loop_id)
  WHERE relation_type = 'primary_execution';

-- -----------------------------------------------------------------------------
-- Memories / activity / usage
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  type text NOT NULL DEFAULT 'journal',
  title text,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  date date NOT NULL DEFAULT current_date,
  embedding jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS embedding jsonb;
ALTER TABLE public.memories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_memories_agent ON public.memories(agent);
CREATE INDEX IF NOT EXISTS idx_memories_type ON public.memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_date ON public.memories(date DESC);
CREATE INDEX IF NOT EXISTS idx_memories_content_fts ON public.memories USING gin(to_tsvector('simple', content));
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_journal_unique ON public.memories(agent, date, type) WHERE type = 'journal';

DROP FUNCTION IF EXISTS public.match_memories(double precision[], double precision, integer, text, text);
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding double precision[],
  match_threshold double precision DEFAULT 0.7,
  match_count integer DEFAULT 10,
  filter_agent text DEFAULT NULL,
  filter_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  agent text,
  type text,
  title text,
  content text,
  tags text[],
  date date,
  similarity double precision,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.agent,
    m.type,
    m.title,
    m.content,
    m.tags,
    m.date,
    NULL::double precision AS similarity,
    m.created_at
  FROM public.memories m
  WHERE (filter_agent IS NULL OR m.agent = filter_agent)
    AND (filter_type IS NULL OR m.type = filter_type)
  ORDER BY m.date DESC, m.created_at DESC
  LIMIT match_count;
$$;

CREATE TABLE IF NOT EXISTS public.usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  date date NOT NULL DEFAULT current_date,
  model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  task_id uuid,
  session_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.usage_logs DROP CONSTRAINT IF EXISTS usage_logs_task_id_fkey;
ALTER TABLE public.usage_logs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_usage_agent_date ON public.usage_logs(agent, date);
CREATE INDEX IF NOT EXISTS idx_usage_date ON public.usage_logs(date);
CREATE INDEX IF NOT EXISTS idx_usage_task_id ON public.usage_logs(task_id);

CREATE TABLE IF NOT EXISTS public.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  detail text,
  task_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_log DROP CONSTRAINT IF EXISTS activity_log_task_id_fkey;
ALTER TABLE public.activity_log ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_activity_created ON public.activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON public.activity_log(agent);
CREATE INDEX IF NOT EXISTS idx_activity_task_id ON public.activity_log(task_id);

-- -----------------------------------------------------------------------------
-- Strategist / Intel / YouTube ops tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_type text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  source_system text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_read integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  error_summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_type_started ON public.pipeline_runs(run_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status_started ON public.pipeline_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.intel_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_type text NOT NULL DEFAULT 'intel',
  status text NOT NULL DEFAULT 'running',
  source_system text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_read integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  error_summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_intel_runs_status_started ON public.intel_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.intel_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  lane text NOT NULL,
  source_type text NOT NULL,
  base_url text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intel_sources_lane_enabled ON public.intel_sources(lane, enabled);

INSERT INTO public.intel_sources (source_key, name, lane, source_type, base_url, enabled)
VALUES
  ('hackernews', 'Hacker News', 'trend', 'api', 'https://news.ycombinator.com', true),
  ('reddit', 'Reddit', 'trend', 'api', 'https://www.reddit.com', true),
  ('producthunt', 'Product Hunt', 'trend', 'api', 'https://www.producthunt.com', true),
  ('news', 'AI News RSS', 'industry', 'rss', null, true),
  ('google_trends', 'Google Trends', 'trend', 'api', null, true)
ON CONFLICT (source_key) DO UPDATE SET
  name = EXCLUDED.name,
  lane = EXCLUDED.lane,
  source_type = EXCLUDED.source_type,
  base_url = EXCLUDED.base_url,
  enabled = EXCLUDED.enabled,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.intel_items_raw (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint REFERENCES public.intel_sources(id) ON DELETE RESTRICT,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  lane text NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_intel_items_raw_lane_seen ON public.intel_items_raw(lane, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_items_raw_captured_on ON public.intel_items_raw(captured_on DESC);
CREATE INDEX IF NOT EXISTS idx_intel_items_raw_engagement ON public.intel_items_raw(engagement_score DESC, engagement_count DESC);
CREATE INDEX IF NOT EXISTS idx_intel_items_raw_external ON public.intel_items_raw(external_id);

CREATE TABLE IF NOT EXISTS public.intel_items_enriched (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raw_item_id bigint REFERENCES public.intel_items_raw(id) ON DELETE CASCADE,
  lane text NOT NULL,
  summary_short text,
  summary_display text,
  why_it_matters text,
  primary_topic text,
  suggested_owner text,
  suggested_destination text,
  overall_score numeric,
  promote_title text,
  promote_type text,
  promote_owner text,
  promote_status_default text,
  format_doc_score numeric,
  format_video_score numeric,
  format_email_campaign_score numeric,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intel_items_enriched_created ON public.intel_items_enriched(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_items_enriched_lane_created ON public.intel_items_enriched(lane, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_items_enriched_owner ON public.intel_items_enriched(promote_owner);
CREATE INDEX IF NOT EXISTS idx_intel_items_enriched_raw ON public.intel_items_enriched(raw_item_id);
CREATE INDEX IF NOT EXISTS idx_intel_items_enriched_metadata_gin ON public.intel_items_enriched USING gin(metadata_json);

CREATE TABLE IF NOT EXISTS public.intel_inbox_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enriched_item_id bigint NOT NULL REFERENCES public.intel_items_enriched(id) ON DELETE CASCADE,
  reviewer text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  selected_pipeline_type text,
  selected_owner_agent text,
  selected_collaborators text[] NOT NULL DEFAULT '{}'::text[],
  decision_reasoning text,
  notes text,
  created_pipeline_item_id uuid REFERENCES public.pipeline_items(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(enriched_item_id, reviewer)
);
CREATE INDEX IF NOT EXISTS idx_intel_inbox_reviews_enriched ON public.intel_inbox_reviews(enriched_item_id);
CREATE INDEX IF NOT EXISTS idx_intel_inbox_reviews_status_updated ON public.intel_inbox_reviews(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_inbox_reviews_pipeline_item ON public.intel_inbox_reviews(created_pipeline_item_id);

CREATE TABLE IF NOT EXISTS public.intel_trend_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL,
  keyword text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  country text NOT NULL DEFAULT 'AR',
  source_key text NOT NULL DEFAULT 'google_trends',
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, keyword, country, source_key)
);
CREATE INDEX IF NOT EXISTS idx_intel_trend_daily_keyword_date ON public.intel_trend_daily(keyword, date DESC);
CREATE INDEX IF NOT EXISTS idx_intel_trend_daily_date ON public.intel_trend_daily(date DESC);

CREATE TABLE IF NOT EXISTS public.competitor_channels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint REFERENCES public.intel_sources(id) ON DELETE SET NULL,
  channel_id text UNIQUE,
  name text NOT NULL,
  handle text,
  url text,
  enabled boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitor_channels_enabled ON public.competitor_channels(enabled);

CREATE TABLE IF NOT EXISTS public.competitor_video_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competitor_channel_id bigint REFERENCES public.competitor_channels(id) ON DELETE SET NULL,
  video_id text NOT NULL,
  title text,
  url text,
  published_at timestamptz,
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitor_video_snapshots_channel_video ON public.competitor_video_snapshots(competitor_channel_id, video_id);
CREATE INDEX IF NOT EXISTS idx_competitor_video_snapshots_snapshot ON public.competitor_video_snapshots(snapshot_at DESC);

CREATE TABLE IF NOT EXISTS public.competitor_transcripts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id text NOT NULL,
  transcript_text text,
  summary_short text,
  fetch_status text NOT NULL DEFAULT 'pending',
  summary_status text NOT NULL DEFAULT 'pending',
  fetched_at timestamptz,
  summarized_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitor_transcripts_video ON public.competitor_transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_competitor_transcripts_status ON public.competitor_transcripts(fetch_status, summary_status);

CREATE TABLE IF NOT EXISTS public.ops_owned_videos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academy_video_id text NOT NULL UNIQUE,
  platform text NOT NULL DEFAULT 'youtube',
  platform_video_id text NOT NULL,
  title text NOT NULL,
  published_at timestamptz,
  video_kind text NOT NULL DEFAULT 'longform',
  is_published boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_owned_videos_kind_published ON public.ops_owned_videos(video_kind, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_owned_videos_platform_id ON public.ops_owned_videos(platform_video_id);

CREATE TABLE IF NOT EXISTS public.ops_youtube_video_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES public.ops_owned_videos(academy_video_id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_ops_youtube_video_daily_date ON public.ops_youtube_video_daily(date DESC);

CREATE TABLE IF NOT EXISTS public.ops_youtube_short_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES public.ops_owned_videos(academy_video_id) ON DELETE RESTRICT,
  date date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_video_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ops_youtube_short_daily_date ON public.ops_youtube_short_daily(date DESC);

CREATE TABLE IF NOT EXISTS public.ops_youtube_channel_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL UNIQUE,
  subscribers integer NOT NULL DEFAULT 0,
  total_views integer NOT NULL DEFAULT 0,
  watch_time_minutes numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  videos_published integer NOT NULL DEFAULT 0,
  net_subscribers integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ops_community_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  date date NOT NULL,
  channel_id text NOT NULL,
  channel_name text,
  message_count integer NOT NULL DEFAULT 0,
  unique_authors integer NOT NULL DEFAULT 0,
  notable_messages_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_community_daily_date ON public.ops_community_daily(date DESC);

CREATE TABLE IF NOT EXISTS public.ops_youtube_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES public.ops_owned_videos(academy_video_id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_video ON public.ops_youtube_comments(academy_video_id);
CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_published ON public.ops_youtube_comments(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_scraped ON public.ops_youtube_comments(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_youtube_comments_author ON public.ops_youtube_comments(author_channel_id);

CREATE TABLE IF NOT EXISTS public.academy_daily_kpis (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS public.ops_daily_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date date NOT NULL UNIQUE,
  build_run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_ops_daily_snapshots_date ON public.ops_daily_snapshots(date DESC);

CREATE TABLE IF NOT EXISTS public.ops_youtube_video_learning_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint REFERENCES public.pipeline_runs(id) ON DELETE SET NULL,
  academy_video_id text NOT NULL REFERENCES public.ops_owned_videos(academy_video_id) ON DELETE CASCADE,
  window_key text NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_ops_youtube_learning_window ON public.ops_youtube_video_learning_snapshots(window_key, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_youtube_learning_video ON public.ops_youtube_video_learning_snapshots(academy_video_id);

-- Keep local Postgres simple: no RLS policies are required for the local-only app.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'system_cursors','scheduler_config','execution_window_config','services',
    'cron_health','cron_logs','work_items','work_item_dependencies','event_log',
    'recurring_work_rules','recurring_work_occurrences','pipeline_items','pipeline_events','pipeline_work_map',
    'loops','loop_events','loop_work_items','memories','usage_logs','activity_log',
    'pipeline_runs','intel_runs','intel_sources','intel_items_raw','intel_items_enriched','intel_inbox_reviews','intel_trend_daily',
    'competitor_channels','competitor_video_snapshots','competitor_transcripts',
    'ops_owned_videos','ops_youtube_video_daily','ops_youtube_short_daily','ops_youtube_channel_daily','ops_community_daily',
    'ops_youtube_comments','academy_daily_kpis','ops_daily_snapshots','ops_youtube_video_learning_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE IF EXISTS public.%I DISABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END $$;

COMMIT;
