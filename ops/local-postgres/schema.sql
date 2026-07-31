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
  ('schedule_minutes', '5')
ON CONFLICT (key) DO UPDATE SET
  value = CASE EXCLUDED.key
    WHEN 'enabled' THEN CASE
      WHEN lower(trim(scheduler_config.value)) IN ('true', 'false')
        THEN lower(trim(scheduler_config.value))
      ELSE 'false'
    END
    WHEN 'max_concurrent' THEN CASE
      WHEN trim(scheduler_config.value) ~ '^[0-9]+$' THEN CASE
        WHEN scheduler_config.value::numeric BETWEEN 1 AND 10 THEN trim(scheduler_config.value)
        ELSE '2'
      END
      ELSE '2'
    END
    WHEN 'daily_budget_usd' THEN CASE
      WHEN trim(scheduler_config.value) ~ '^[0-9]+$' THEN CASE
        WHEN scheduler_config.value::numeric BETWEEN 1 AND 100000 THEN trim(scheduler_config.value)
        ELSE '50'
      END
      ELSE '50'
    END
    WHEN 'schedule_minutes' THEN '5'
    ELSE scheduler_config.value
  END,
  updated_at = now();

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

INSERT INTO public.cron_health (
  cron_name, schedule, description, category, enabled, last_status
)
VALUES (
  'work-item-scheduler',
  'every 5 min',
  'DB-native Mission Control work-item scheduler (launchd StartInterval job)',
  'scheduled',
  CASE
    WHEN (SELECT lower(trim(value)) FROM public.scheduler_config WHERE key = 'enabled') = 'true' THEN true
    ELSE false
  END,
  'unknown'
)
ON CONFLICT (cron_name) DO UPDATE SET
  schedule = EXCLUDED.schedule,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled;

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
  workflow_version smallint NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'linear',
  current_plan_revision_id uuid,
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loops_workflow_version_check CHECK (workflow_version IN (1, 2)),
  CONSTRAINT loops_mode_check CHECK (mode IN ('linear', 'dag')),
  CONSTRAINT loops_row_version_check CHECK (row_version > 0),
  CONSTRAINT loops_workflow_state_check CHECK (
    (workflow_version = 1 AND mode = 'linear' AND current_plan_revision_id IS NULL)
    OR (workflow_version = 2 AND current_plan_revision_id IS NOT NULL)
  )
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
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS workflow_version smallint NOT NULL DEFAULT 1;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'linear';
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS current_plan_revision_id uuid;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.loops ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loops_workflow_version_check' AND conrelid='public.loops'::regclass) THEN
    ALTER TABLE public.loops ADD CONSTRAINT loops_workflow_version_check CHECK (workflow_version IN (1, 2));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loops_mode_check' AND conrelid='public.loops'::regclass) THEN
    ALTER TABLE public.loops ADD CONSTRAINT loops_mode_check CHECK (mode IN ('linear', 'dag'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loops_row_version_check' AND conrelid='public.loops'::regclass) THEN
    ALTER TABLE public.loops ADD CONSTRAINT loops_row_version_check CHECK (row_version > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loops_workflow_state_check' AND conrelid='public.loops'::regclass) THEN
    ALTER TABLE public.loops ADD CONSTRAINT loops_workflow_state_check CHECK (
      (workflow_version = 1 AND mode = 'linear' AND current_plan_revision_id IS NULL)
      OR (workflow_version = 2 AND current_plan_revision_id IS NOT NULL)
    );
  END IF;
END $$;

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_work_items_task_execution_work_item
  ON public.loop_work_items(work_item_id)
  WHERE relation_type = 'task_execution';

-- Project Loops V2 phase 1 foundation. Runtime V2 remains disabled; all existing
-- and application-created Loops retain workflow_version=1 by default.
CREATE TABLE IF NOT EXISTS public.loop_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid NOT NULL CONSTRAINT loop_plan_revisions_loop_id_fkey REFERENCES public.loops(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  summary text,
  content_hash text,
  plan_snapshot jsonb,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_plan_revisions_id_loop_id_key UNIQUE (id, loop_id),
  CONSTRAINT loop_plan_revisions_revision_number_check CHECK (revision_number > 0),
  CONSTRAINT loop_plan_revisions_status_check CHECK (status IN ('draft', 'pending_approval', 'approved', 'superseded')),
  CONSTRAINT loop_plan_revisions_content_hash_check CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT loop_plan_revisions_plan_snapshot_check CHECK (plan_snapshot IS NULL OR jsonb_typeof(plan_snapshot) = 'object'),
  CONSTRAINT loop_plan_revisions_runtime_snapshot_check CHECK ((content_hash IS NULL) = (plan_snapshot IS NULL))
);
ALTER TABLE public.loop_plan_revisions ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE public.loop_plan_revisions ADD COLUMN IF NOT EXISTS plan_snapshot jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='loop_plan_revisions_id_loop_id_key'
      AND conrelid='public.loop_plan_revisions'::regclass
  ) THEN
    ALTER TABLE public.loop_plan_revisions ADD CONSTRAINT loop_plan_revisions_id_loop_id_key UNIQUE (id, loop_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_plan_revisions_content_hash_check' AND conrelid='public.loop_plan_revisions'::regclass) THEN
    ALTER TABLE public.loop_plan_revisions ADD CONSTRAINT loop_plan_revisions_content_hash_check CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_plan_revisions_plan_snapshot_check' AND conrelid='public.loop_plan_revisions'::regclass) THEN
    ALTER TABLE public.loop_plan_revisions ADD CONSTRAINT loop_plan_revisions_plan_snapshot_check CHECK (plan_snapshot IS NULL OR jsonb_typeof(plan_snapshot)='object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_plan_revisions_runtime_snapshot_check' AND conrelid='public.loop_plan_revisions'::regclass) THEN
    ALTER TABLE public.loop_plan_revisions ADD CONSTRAINT loop_plan_revisions_runtime_snapshot_check CHECK ((content_hash IS NULL) = (plan_snapshot IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_plan_revisions_loop_revision ON public.loop_plan_revisions(loop_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_loop_plan_revisions_loop_status ON public.loop_plan_revisions(loop_id, status, revision_number DESC);

CREATE TABLE IF NOT EXISTS public.loop_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id uuid NOT NULL CONSTRAINT loop_stages_plan_revision_id_fkey REFERENCES public.loop_plan_revisions(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text NOT NULL,
  description text,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_stages_key_check CHECK (btrim(key) <> ''),
  CONSTRAINT loop_stages_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT loop_stages_position_check CHECK (position >= 0),
  CONSTRAINT loop_stages_status_check CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_stages_revision_key ON public.loop_stages(plan_revision_id, key);
CREATE INDEX IF NOT EXISTS idx_loop_stages_revision_position ON public.loop_stages(plan_revision_id, position, id);

CREATE TABLE IF NOT EXISTS public.loop_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL CONSTRAINT loop_tasks_stage_id_fkey REFERENCES public.loop_stages(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text NOT NULL,
  description text,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  assignee_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_tasks_key_check CHECK (btrim(key) <> ''),
  CONSTRAINT loop_tasks_title_check CHECK (btrim(title) <> ''),
  CONSTRAINT loop_tasks_position_check CHECK (position >= 0),
  CONSTRAINT loop_tasks_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT loop_tasks_status_check CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_tasks_stage_key ON public.loop_tasks(stage_id, key);
CREATE INDEX IF NOT EXISTS idx_loop_tasks_stage_position ON public.loop_tasks(stage_id, position, id);
CREATE INDEX IF NOT EXISTS idx_loop_tasks_status ON public.loop_tasks(status, updated_at DESC);

CREATE OR REPLACE FUNCTION public.reject_loop_structure_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $reject_loop_structure_membership_change$
BEGIN
  IF TG_TABLE_NAME = 'loop_stages' THEN
    IF to_jsonb(NEW)->'plan_revision_id' IS DISTINCT FROM to_jsonb(OLD)->'plan_revision_id' THEN
      RAISE EXCEPTION 'Loop stage structural membership is immutable after insert'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'loop_tasks' THEN
    IF to_jsonb(NEW)->'stage_id' IS DISTINCT FROM to_jsonb(OLD)->'stage_id' THEN
      RAISE EXCEPTION 'Loop task structural membership is immutable after insert'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$reject_loop_structure_membership_change$;
REVOKE ALL ON FUNCTION public.reject_loop_structure_membership_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS loop_stages_immutable_membership ON public.loop_stages;
CREATE TRIGGER loop_stages_immutable_membership
BEFORE UPDATE OF plan_revision_id
ON public.loop_stages
FOR EACH ROW EXECUTE FUNCTION public.reject_loop_structure_membership_change();

DROP TRIGGER IF EXISTS loop_tasks_immutable_membership ON public.loop_tasks;
CREATE TRIGGER loop_tasks_immutable_membership
BEFORE UPDATE OF stage_id
ON public.loop_tasks
FOR EACH ROW EXECUTE FUNCTION public.reject_loop_structure_membership_change();

CREATE TABLE IF NOT EXISTS public.loop_task_dependencies (
  task_id uuid NOT NULL CONSTRAINT loop_task_dependencies_task_id_fkey REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL CONSTRAINT loop_task_dependencies_depends_on_task_id_fkey REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  dependency_type text NOT NULL DEFAULT 'hard',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT loop_task_dependencies_not_self_check CHECK (task_id <> depends_on_task_id),
  CONSTRAINT loop_task_dependencies_type_check CHECK (dependency_type IN ('hard', 'soft'))
);
CREATE INDEX IF NOT EXISTS idx_loop_task_dependencies_depends_on ON public.loop_task_dependencies(depends_on_task_id, task_id);

CREATE OR REPLACE FUNCTION public.validate_loop_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $validate_loop_task_dependency$
DECLARE
  task_revision uuid;
  dependency_revision uuid;
  closes_cycle boolean;
BEGIN
  SELECT stage.plan_revision_id INTO task_revision
  FROM public.loop_tasks AS task
  JOIN public.loop_stages AS stage ON stage.id = task.stage_id
  WHERE task.id = NEW.task_id;

  SELECT stage.plan_revision_id INTO dependency_revision
  FROM public.loop_tasks AS task
  JOIN public.loop_stages AS stage ON stage.id = task.stage_id
  WHERE task.id = NEW.depends_on_task_id;

  IF task_revision IS NULL OR dependency_revision IS NULL THEN RETURN NEW; END IF;
  IF task_revision <> dependency_revision THEN
    RAISE EXCEPTION 'Loop task dependency endpoints must belong to the same plan revision'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(task_revision::text, 0));

  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT edge.depends_on_task_id
      FROM public.loop_task_dependencies AS edge
      JOIN reachable ON reachable.task_id = edge.task_id
      WHERE (edge.task_id, edge.depends_on_task_id) <> (OLD.task_id, OLD.depends_on_task_id)
    )
    SELECT EXISTS (SELECT 1 FROM reachable WHERE task_id = NEW.task_id) INTO closes_cycle;
  ELSE
    WITH RECURSIVE reachable(task_id) AS (
      SELECT NEW.depends_on_task_id
      UNION
      SELECT edge.depends_on_task_id
      FROM public.loop_task_dependencies AS edge
      JOIN reachable ON reachable.task_id = edge.task_id
    )
    SELECT EXISTS (SELECT 1 FROM reachable WHERE task_id = NEW.task_id) INTO closes_cycle;
  END IF;

  IF closes_cycle THEN
    RAISE EXCEPTION 'Loop task dependency would create a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$validate_loop_task_dependency$;
REVOKE ALL ON FUNCTION public.validate_loop_task_dependency() FROM PUBLIC;

DROP TRIGGER IF EXISTS loop_task_dependencies_validate_graph ON public.loop_task_dependencies;
CREATE TRIGGER loop_task_dependencies_validate_graph
BEFORE INSERT OR UPDATE OF task_id, depends_on_task_id ON public.loop_task_dependencies
FOR EACH ROW EXECUTE FUNCTION public.validate_loop_task_dependency();

CREATE OR REPLACE FUNCTION public.reject_approved_loop_plan_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $reject_approved_loop_plan_mutation$
DECLARE
  revision_status text;
  revision_id uuid;
  old_revision_id uuid;
  new_revision_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'loop_plan_revisions' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status = 'approved' THEN
        RAISE EXCEPTION 'Approved Loop plan revision is immutable' USING ERRCODE = '23514';
      END IF;
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status = 'approved' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'Approved Loop plan revision is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.status = 'approved' AND (
      NEW.content_hash IS NULL OR NEW.plan_snapshot IS NULL
      OR jsonb_typeof(NEW.plan_snapshot) <> 'object'
      OR NEW.content_hash !~ '^[0-9a-f]{64}$'
    ) THEN
      RAISE EXCEPTION 'Approved Loop plan revision requires an exact snapshot and hash' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'loop_stages' THEN
    revision_id := CASE WHEN TG_OP='DELETE' THEN OLD.plan_revision_id ELSE NEW.plan_revision_id END;
  ELSIF TG_TABLE_NAME = 'loop_tasks' THEN
    SELECT s.plan_revision_id INTO revision_id FROM public.loop_stages s
     WHERE s.id = CASE WHEN TG_OP='DELETE' THEN OLD.stage_id ELSE NEW.stage_id END;
  ELSIF TG_TABLE_NAME = 'loop_task_dependencies' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT s.plan_revision_id INTO old_revision_id
        FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id
       WHERE t.id = OLD.task_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT s.plan_revision_id INTO new_revision_id
        FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id
       WHERE t.id = NEW.task_id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.loop_plan_revisions r
       WHERE r.id IN (old_revision_id, new_revision_id) AND r.status='approved'
    ) THEN
      RAISE EXCEPTION 'Approved Loop plan structure is immutable' USING ERRCODE = '23514';
    END IF;
    revision_id := COALESCE(new_revision_id, old_revision_id);
  END IF;
  SELECT r.status INTO revision_status FROM public.loop_plan_revisions r WHERE r.id=revision_id;
  IF revision_status <> 'approved' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP <> 'UPDATE' OR TG_TABLE_NAME = 'loop_task_dependencies' THEN
    RAISE EXCEPTION 'Approved Loop plan structure is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'loop_stages'
     AND (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN
    RAISE EXCEPTION 'Approved Loop stage specification is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'loop_tasks'
     AND (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN
    RAISE EXCEPTION 'Approved Loop task specification is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$reject_approved_loop_plan_mutation$;
REVOKE ALL ON FUNCTION public.reject_approved_loop_plan_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS loop_plan_revisions_freeze_approved ON public.loop_plan_revisions;
CREATE TRIGGER loop_plan_revisions_freeze_approved BEFORE INSERT OR UPDATE OR DELETE ON public.loop_plan_revisions
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
DROP TRIGGER IF EXISTS loop_stages_freeze_approved ON public.loop_stages;
CREATE TRIGGER loop_stages_freeze_approved BEFORE INSERT OR UPDATE OR DELETE ON public.loop_stages
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
DROP TRIGGER IF EXISTS loop_tasks_freeze_approved ON public.loop_tasks;
CREATE TRIGGER loop_tasks_freeze_approved BEFORE INSERT OR UPDATE OR DELETE ON public.loop_tasks
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
DROP TRIGGER IF EXISTS loop_task_dependencies_freeze_approved ON public.loop_task_dependencies;
CREATE TRIGGER loop_task_dependencies_freeze_approved BEFORE INSERT OR UPDATE OR DELETE ON public.loop_task_dependencies
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();

CREATE TABLE IF NOT EXISTS public.loop_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL CONSTRAINT loop_task_runs_task_id_fkey REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  work_item_id uuid CONSTRAINT loop_task_runs_work_item_id_fkey REFERENCES public.work_items(id) ON DELETE RESTRICT,
  execution_attempt_id uuid,
  run_role text NOT NULL DEFAULT 'implementation',
  quality_cycle integer NOT NULL DEFAULT 1,
  attempt_number integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_task_runs_id_task_id_key UNIQUE (id, task_id),
  CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation')),
  CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle > 0),
  CONSTRAINT loop_task_runs_runtime_identity_check CHECK (work_item_id IS NULL OR execution_attempt_id IS NOT NULL),
  CONSTRAINT loop_task_runs_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT loop_task_runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT loop_task_runs_output_check CHECK (jsonb_typeof(output) = 'object'),
  CONSTRAINT loop_task_runs_timestamps_check CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS work_item_id uuid;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS execution_attempt_id uuid;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS run_role text NOT NULL DEFAULT 'implementation';
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS quality_cycle integer NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='loop_task_runs_id_task_id_key'
      AND conrelid='public.loop_task_runs'::regclass
  ) THEN
    ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_id_task_id_key UNIQUE (id, task_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='loop_task_runs_work_item_id_fkey'
      AND conrelid='public.loop_task_runs'::regclass
  ) THEN
    ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_work_item_id_fkey
      FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='loop_task_runs_run_role_check'
      AND conrelid='public.loop_task_runs'::regclass
  ) THEN
    ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='loop_task_runs_quality_cycle_check'
      AND conrelid='public.loop_task_runs'::regclass
  ) THEN
    ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_task_runs_runtime_identity_check' AND conrelid='public.loop_task_runs'::regclass) THEN
    ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_runtime_identity_check CHECK (work_item_id IS NULL OR execution_attempt_id IS NOT NULL);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_task_runs_task_attempt ON public.loop_task_runs(task_id, attempt_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_task_runs_work_item ON public.loop_task_runs(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loop_task_runs_task_created ON public.loop_task_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.loop_task_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL CONSTRAINT loop_task_reviews_task_id_fkey REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  task_run_id uuid,
  status text NOT NULL DEFAULT 'pending',
  reviewer text,
  feedback text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_task_reviews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
  CONSTRAINT loop_task_reviews_decision_check CHECK ((status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL))
);
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_task_run_id_fkey;
ALTER TABLE public.loop_task_reviews ADD CONSTRAINT loop_task_reviews_task_run_id_fkey
  FOREIGN KEY (task_run_id, task_id) REFERENCES public.loop_task_runs(id, task_id)
  ON DELETE SET NULL (task_run_id);
CREATE INDEX IF NOT EXISTS idx_loop_task_reviews_task_created ON public.loop_task_reviews(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loop_task_reviews_run ON public.loop_task_reviews(task_run_id) WHERE task_run_id IS NOT NULL;

-- Project Loops V2 phase 4: fresh_review_v1 and strongly isolated bounded quality cycles.
-- Keep this idempotent fresh-schema block in parity with migration 034.
CREATE TABLE IF NOT EXISTS public.review_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  canonical_root text NOT NULL UNIQUE CHECK (canonical_root LIKE '/Users/joaco/openclaw/%'),
  git_common_dir text NOT NULL UNIQUE,
  object_format text NOT NULL CHECK (object_format IN ('sha1','sha256')),
  enabled boolean NOT NULL DEFAULT true,
  max_diff_bytes integer NOT NULL DEFAULT 2097152 CHECK (max_diff_bytes BETWEEN 1024 AND 16777216),
  max_package_bytes integer NOT NULL DEFAULT 3145728 CHECK (max_package_bytes BETWEEN 2048 AND 25165824),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.review_repositories FROM PUBLIC;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS server_session_id text;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS artifact_sha text;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS target_run_id uuid;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS target_sha text;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS repository_id uuid REFERENCES public.review_repositories(id) ON DELETE RESTRICT;
ALTER TABLE public.loop_task_runs ADD COLUMN IF NOT EXISTS base_sha text;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_quality_cycle_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_artifact_sha_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_target_sha_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_role_target_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_target_same_task_fkey;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_base_sha_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_repository_required_check;
ALTER TABLE public.loop_task_runs
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation', 'review')),
  ADD CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle BETWEEN 1 AND 3),
  ADD CONSTRAINT loop_task_runs_artifact_sha_check CHECK (artifact_sha IS NULL OR artifact_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_target_sha_check CHECK (target_sha IS NULL OR target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_base_sha_check CHECK (base_sha IS NULL OR base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_role_target_check CHECK ((run_role='implementation' AND target_run_id IS NULL AND target_sha IS NULL) OR (run_role='review' AND target_run_id IS NOT NULL AND target_sha IS NOT NULL)),
  ADD CONSTRAINT loop_task_runs_target_same_task_fkey FOREIGN KEY (target_run_id,task_id) REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_task_runs_task_cycle_role ON public.loop_task_runs(task_id,quality_cycle,run_role);

ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS review_run_id uuid;
ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS quality_cycle integer;
ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS reviewed_sha text;
ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS reviewer_session_id text;
ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS findings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.loop_task_reviews ADD COLUMN IF NOT EXISTS decision_id uuid;
UPDATE public.loop_task_reviews AS decision
SET reviewed_sha=COALESCE((SELECT run.output->>'head_sha' FROM public.loop_task_runs AS run
  WHERE run.id=decision.task_run_id AND run.task_id=decision.task_id
    AND run.output->>'head_sha' ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),repeat('0',40))
WHERE reviewed_sha IS NULL;
ALTER TABLE public.loop_task_reviews ALTER COLUMN reviewed_sha SET NOT NULL;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_quality_cycle_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_reviewed_sha_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_findings_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_review_run_same_task_fkey;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_decision_check;
ALTER TABLE public.loop_task_reviews
  ADD CONSTRAINT loop_task_reviews_quality_cycle_check CHECK (quality_cycle BETWEEN 1 AND 3),
  ADD CONSTRAINT loop_task_reviews_reviewed_sha_check CHECK (reviewed_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_reviews_findings_check CHECK (jsonb_typeof(findings)='array'),
  ADD CONSTRAINT loop_task_reviews_review_run_same_task_fkey FOREIGN KEY (review_run_id,task_id) REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  ADD CONSTRAINT loop_task_reviews_decision_check CHECK (
    (review_run_id IS NULL AND quality_cycle IS NULL
      AND ((status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)))
    OR (review_run_id IS NOT NULL AND quality_cycle IS NOT NULL
      AND ((status='pending' AND decided_at IS NULL AND reviewer_session_id IS NULL AND decision_id IS NULL)
        OR (status<>'pending' AND decided_at IS NOT NULL AND reviewer IS NOT NULL
          AND reviewer_session_id IS NOT NULL AND decision_id IS NOT NULL)))
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_task_reviews_task_cycle ON public.loop_task_reviews(task_id,quality_cycle) WHERE quality_cycle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_task_reviews_review_run ON public.loop_task_reviews(review_run_id) WHERE review_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.reviewer_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_run_id uuid NOT NULL UNIQUE REFERENCES public.loop_task_runs(id) ON DELETE RESTRICT,
  work_item_id uuid NOT NULL UNIQUE REFERENCES public.work_items(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL,
  repository_id uuid NOT NULL REFERENCES public.review_repositories(id) ON DELETE RESTRICT,
  base_sha text NOT NULL CHECK (base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  target_sha text NOT NULL CHECK (target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled','blocked')),
  capability_hash bytea NOT NULL CHECK (octet_length(capability_hash)=32),
  capability_expires_at timestamptz NOT NULL,
  capability_consumed_at timestamptz, capability_revoked_at timestamptz,
  reviewer_session_id text, pid integer CHECK (pid IS NULL OR pid>0),
  dispatched_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_executions_capability_state_check CHECK (capability_consumed_at IS NULL OR capability_revoked_at IS NULL),
  CONSTRAINT reviewer_executions_terminal_check CHECK (
    (status='running' AND finished_at IS NULL AND result IS NULL AND error IS NULL AND capability_consumed_at IS NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND result IS NOT NULL AND error IS NULL AND capability_consumed_at IS NOT NULL AND reviewer_session_id IS NOT NULL)
    OR (status IN ('failed','cancelled','blocked') AND finished_at IS NOT NULL AND error IS NOT NULL AND capability_revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_reviewer_executions_stale ON public.reviewer_executions(heartbeat_at) WHERE status='running';
REVOKE ALL ON public.reviewer_executions FROM PUBLIC;

ALTER TABLE public.loop_tasks DROP CONSTRAINT IF EXISTS loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check CHECK (status IN ('pending','ready','in_progress','review_pending','rework_required','blocked','completed','skipped','cancelled'));
DROP INDEX IF EXISTS public.uq_work_items_loop_fresh_review_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_loop_active ON public.work_items(loop_id)
  WHERE loop_id IS NOT NULL AND source_type='loop' AND status IN ('ready','in_progress');

CREATE OR REPLACE FUNCTION public.validate_loop_quality_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $validate_loop_quality_integrity$
DECLARE target public.loop_task_runs%ROWTYPE;
DECLARE implementation public.loop_task_runs%ROWTYPE;
DECLARE review_run public.loop_task_runs%ROWTYPE;
DECLARE phase4 boolean;
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' THEN
    SELECT NEW.run_role='review' OR NEW.repository_id IS NOT NULL OR NEW.base_sha IS NOT NULL
      OR NEW.artifact_sha IS NOT NULL OR NEW.server_session_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.work_items wi WHERE wi.id=NEW.work_item_id AND wi.payload->>'runtime_contract'='fresh_review_v1')
      INTO phase4;
    IF phase4 AND (NEW.repository_id IS NULL OR NEW.base_sha IS NULL) THEN
      RAISE EXCEPTION 'Phase 4 run requires registered repository and base SHA' USING ERRCODE='23514';
    END IF;
    IF NEW.run_role='implementation' THEN
      IF phase4 AND NEW.status='succeeded' AND (NEW.artifact_sha IS NULL OR NEW.server_session_id IS NULL) THEN RAISE EXCEPTION 'Succeeded Phase 4 implementation run requires artifact SHA and server session' USING ERRCODE='23514'; END IF;
    ELSE
      SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
      IF NOT FOUND OR target.task_id<>NEW.task_id OR target.run_role<>'implementation' OR target.quality_cycle<>NEW.quality_cycle OR target.status<>'succeeded' OR target.artifact_sha IS NULL OR target.artifact_sha<>NEW.target_sha OR target.repository_id<>NEW.repository_id OR target.base_sha<>NEW.base_sha THEN RAISE EXCEPTION 'Review run target integrity mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.status='succeeded' AND (NEW.server_session_id IS NULL OR target.server_session_id IS NULL OR NEW.server_session_id=target.server_session_id) THEN RAISE EXCEPTION 'Review run terminal session integrity mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.review_run_id IS NULL AND NEW.quality_cycle IS NULL THEN RETURN NEW; END IF;
  IF NEW.review_run_id IS NULL OR NEW.quality_cycle IS NULL OR NEW.task_run_id IS NULL THEN RAISE EXCEPTION 'Review decision identity is incomplete' USING ERRCODE='23514'; END IF;
  SELECT * INTO implementation FROM public.loop_task_runs WHERE id=NEW.task_run_id;
  SELECT * INTO review_run FROM public.loop_task_runs WHERE id=NEW.review_run_id;
  IF implementation.id IS NULL OR review_run.id IS NULL OR implementation.task_id<>NEW.task_id OR review_run.task_id<>NEW.task_id OR implementation.run_role<>'implementation' OR review_run.run_role<>'review' OR implementation.quality_cycle<>NEW.quality_cycle OR review_run.quality_cycle<>NEW.quality_cycle OR review_run.target_run_id<>implementation.id OR implementation.status<>'succeeded' OR implementation.artifact_sha IS NULL OR NEW.reviewed_sha IS DISTINCT FROM implementation.artifact_sha OR review_run.target_sha IS DISTINCT FROM implementation.artifact_sha THEN RAISE EXCEPTION 'Review decision run/SHA integrity mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.status='pending' THEN
    IF review_run.status NOT IN ('queued','running') OR NEW.reviewer_session_id IS NOT NULL OR NEW.decision_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN RAISE EXCEPTION 'Pending review decision fields are incoherent' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status IN ('approved','changes_requested') THEN
    IF review_run.status<>'succeeded' OR NEW.reviewer_session_id IS NULL OR review_run.server_session_id IS DISTINCT FROM NEW.reviewer_session_id OR implementation.server_session_id IS NULL OR NEW.reviewer_session_id=implementation.server_session_id OR NEW.decision_id IS NULL OR NEW.decided_at IS NULL OR NEW.reviewer IS NULL THEN RAISE EXCEPTION 'Terminal review decision fields are incoherent' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status='rejected' AND review_run.status NOT IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'Failed review decision is incoherent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $validate_loop_quality_integrity$;
REVOKE ALL ON FUNCTION public.validate_loop_quality_integrity() FROM PUBLIC;
DROP TRIGGER IF EXISTS loop_task_runs_quality_integrity ON public.loop_task_runs;
CREATE TRIGGER loop_task_runs_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();
DROP TRIGGER IF EXISTS loop_task_reviews_quality_integrity ON public.loop_task_reviews;
CREATE TRIGGER loop_task_reviews_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();

CREATE OR REPLACE FUNCTION public.reject_terminal_loop_quality_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $reject_terminal_loop_quality_mutation$
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' AND OLD.status IN ('succeeded','failed','cancelled') THEN
    IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Terminal Loop task run is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='loop_task_reviews' THEN
    IF TG_OP='DELETE' AND OLD.status='pending' THEN RAISE EXCEPTION 'Pending Loop task review cannot be deleted' USING ERRCODE='23514';
    ELSIF OLD.status<>'pending' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task review is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='reviewer_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Terminal reviewer execution is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $reject_terminal_loop_quality_mutation$;
REVOKE ALL ON FUNCTION public.reject_terminal_loop_quality_mutation() FROM PUBLIC;
DROP TRIGGER IF EXISTS loop_task_runs_terminal_immutable ON public.loop_task_runs;
CREATE TRIGGER loop_task_runs_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
DROP TRIGGER IF EXISTS loop_task_reviews_terminal_immutable ON public.loop_task_reviews;
CREATE TRIGGER loop_task_reviews_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
DROP TRIGGER IF EXISTS reviewer_executions_terminal_immutable ON public.reviewer_executions;
CREATE TRIGGER reviewer_executions_terminal_immutable BEFORE UPDATE OR DELETE ON public.reviewer_executions FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();

CREATE TABLE IF NOT EXISTS public.loop_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL CONSTRAINT loop_evidence_task_id_fkey REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  task_run_id uuid,
  kind text NOT NULL,
  uri text,
  content text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_evidence_kind_check CHECK (btrim(kind) <> ''),
  CONSTRAINT loop_evidence_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT loop_evidence_payload_check CHECK (nullif(btrim(uri), '') IS NOT NULL OR nullif(btrim(content), '') IS NOT NULL)
);
ALTER TABLE public.loop_evidence DROP CONSTRAINT IF EXISTS loop_evidence_task_run_id_fkey;
ALTER TABLE public.loop_evidence ADD CONSTRAINT loop_evidence_task_run_id_fkey
  FOREIGN KEY (task_run_id, task_id) REFERENCES public.loop_task_runs(id, task_id)
  ON DELETE SET NULL (task_run_id);
CREATE INDEX IF NOT EXISTS idx_loop_evidence_task_created ON public.loop_evidence(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loop_evidence_run ON public.loop_evidence(task_run_id) WHERE task_run_id IS NOT NULL;

ALTER TABLE public.loops DROP CONSTRAINT IF EXISTS loops_current_plan_revision_id_fkey;
ALTER TABLE public.loops ADD CONSTRAINT loops_current_plan_revision_id_fkey
  FOREIGN KEY (current_plan_revision_id, id) REFERENCES public.loop_plan_revisions(id, loop_id)
  DEFERRABLE INITIALLY DEFERRED;

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

-- Keep the bootstrap data tables empty. The cloud bootstrap owns intel_sources
-- and refuses to touch any non-empty local data set without explicit replacement.

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
    'loops','loop_events','loop_work_items','loop_plan_revisions','loop_stages','loop_tasks',
    'loop_task_dependencies','loop_task_runs','loop_task_reviews','loop_evidence','memories','usage_logs','activity_log',
    'pipeline_runs','intel_runs','intel_sources','intel_items_raw','intel_items_enriched','intel_inbox_reviews','intel_trend_daily',
    'competitor_channels','competitor_video_snapshots','competitor_transcripts',
    'ops_owned_videos','ops_youtube_video_daily','ops_youtube_short_daily','ops_youtube_channel_daily','ops_community_daily',
    'ops_youtube_comments','academy_daily_kpis','ops_daily_snapshots','ops_youtube_video_learning_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE IF EXISTS public.%I DISABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END $$;

COMMIT;

-- Project Loops V2 Phase 5B: dedicated structured visual QA state machine.
-- Additive cloud-parity artifact; local Postgres is the runtime authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Fixed cluster roles separate ordinary runtime SQL from QA authority. Role DDL
-- is idempotent because disposable databases share one PostgreSQL cluster.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_qa_owner') THEN
    CREATE ROLE aipaths_mc_qa_owner NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_app') THEN
    CREATE ROLE aipaths_mc_app LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $roles$;
ALTER ROLE aipaths_mc_qa_owner NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE aipaths_mc_app LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
DO $role_isolation$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))
         OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))) THEN
    RAISE EXCEPTION 'Phase 5B roles must have exactly zero membership edges in either direction' USING ERRCODE='42501';
  END IF;
END $role_isolation$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, aipaths_mc_app;
GRANT USAGE ON SCHEMA public TO aipaths_mc_app,aipaths_mc_qa_owner;

ALTER TABLE public.loop_tasks DROP CONSTRAINT loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check
  CHECK (status IN ('pending','ready','in_progress','review_pending','qa_pending','rework_required','blocked','completed','skipped','cancelled'));

ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_role_target_check;
ALTER TABLE public.loop_task_runs
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation', 'review', 'qa')),
  ADD CONSTRAINT loop_task_runs_role_target_check CHECK (
    (run_role='implementation' AND target_run_id IS NULL AND target_sha IS NULL)
    OR (run_role IN ('review','qa') AND target_run_id IS NOT NULL AND target_sha IS NOT NULL)
  );

CREATE TABLE public.qa_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_run_id uuid NOT NULL UNIQUE,
  task_id uuid NOT NULL,
  work_item_id uuid NOT NULL UNIQUE REFERENCES public.work_items(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL,
  target_run_id uuid NOT NULL,
  target_sha text NOT NULL CHECK (target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','blocked')),
  capability_hash bytea NOT NULL CHECK (octet_length(capability_hash)=32),
  capability_expires_at timestamptz NOT NULL,
  capability_consumed_at timestamptz,
  capability_revoked_at timestamptz,
  qa_session_id text NOT NULL UNIQUE CHECK (qa_session_id ~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$'),
  result jsonb,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  error text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_executions_qa_run_task_fkey FOREIGN KEY (qa_run_id,task_id)
    REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  CONSTRAINT qa_executions_target_run_task_fkey FOREIGN KEY (target_run_id,task_id)
    REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  CONSTRAINT qa_executions_capability_state_check CHECK (capability_consumed_at IS NULL OR capability_revoked_at IS NULL),
  CONSTRAINT qa_executions_result_object_check CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  CONSTRAINT qa_executions_terminal_check CHECK (
    (status='running' AND finished_at IS NULL AND result IS NULL AND result_hash IS NULL AND error IS NULL
      AND capability_consumed_at IS NULL AND capability_revoked_at IS NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND result IS NOT NULL AND result_hash IS NOT NULL
      AND error IS NULL AND capability_consumed_at IS NOT NULL AND capability_revoked_at IS NULL)
    OR (status IN ('failed','blocked') AND finished_at IS NOT NULL AND result IS NULL AND result_hash IS NULL
      AND error IS NOT NULL AND capability_consumed_at IS NULL AND capability_revoked_at IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND result IS NOT NULL AND result_hash IS NOT NULL
      AND error IS NOT NULL AND capability_consumed_at IS NOT NULL AND capability_revoked_at IS NULL)
  )
);
CREATE INDEX idx_qa_executions_stale ON public.qa_executions(heartbeat_at,id) WHERE status='running';
CREATE INDEX idx_qa_executions_task_created ON public.qa_executions(task_id,created_at DESC,id DESC);
REVOKE ALL ON public.qa_executions FROM PUBLIC;
ALTER TABLE public.qa_executions OWNER TO aipaths_mc_qa_owner;
GRANT SELECT ON public.qa_executions TO aipaths_mc_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.qa_executions FROM aipaths_mc_app;

CREATE TABLE public.qa_authority_secrets (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hmac_key bytea NOT NULL CHECK (octet_length(hmac_key)=32),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  rotated_by text NOT NULL
);
INSERT INTO public.qa_authority_secrets(singleton,hmac_key,rotated_by)
VALUES(true,public.gen_random_bytes(32),'migration-random-initialization');
REVOKE ALL ON public.qa_authority_secrets FROM PUBLIC,aipaths_mc_app;
ALTER TABLE public.qa_authority_secrets OWNER TO aipaths_mc_qa_owner;

-- SECURITY INVOKER is intentional: current_user remains the caller, so SET ROLE
-- aipaths_mc_app cannot inherit a superuser session's ability to rotate the key.
CREATE FUNCTION public.install_qa_authority_hmac_key(key_hex text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),false) THEN
    RAISE EXCEPTION 'QA authority HMAC key installation requires current superuser role' USING ERRCODE='42501';
  END IF;
  IF key_hex IS NULL OR key_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'QA authority HMAC key must be exactly 64 lowercase hex characters' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.qa_authority_secrets(singleton,hmac_key,rotated_at,rotated_by)
  VALUES(true,decode(key_hex,'hex'),clock_timestamp(),current_user)
  ON CONFLICT(singleton) DO UPDATE SET hmac_key=excluded.hmac_key,rotated_at=excluded.rotated_at,rotated_by=excluded.rotated_by;
END $body$;
ALTER FUNCTION public.install_qa_authority_hmac_key(text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.install_qa_authority_hmac_key(text) FROM PUBLIC,aipaths_mc_app;

-- Canonical JSON hashing shared by policy/result integrity checks. The bounded QA
-- contracts contain JSON scalars, arrays and objects only.
CREATE OR REPLACE FUNCTION public.qa_jsonb_canonical(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||public.qa_jsonb_canonical(child),',' ORDER BY key)
      FROM jsonb_each(value) entry(key,child)),'')||'}'
    WHEN 'array' THEN '['||coalesce((SELECT string_agg(public.qa_jsonb_canonical(child),',' ORDER BY ordinality)
      FROM jsonb_array_elements(value) WITH ORDINALITY entry(child,ordinality)),'')||']'
    ELSE value::text
  END
$body$;
CREATE OR REPLACE FUNCTION public.qa_jsonb_sha256(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
  SELECT encode(public.digest(convert_to(public.qa_jsonb_canonical(value),'UTF8'),'sha256'),'hex')
$body$;
REVOKE ALL ON FUNCTION public.qa_jsonb_canonical(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qa_jsonb_sha256(jsonb) FROM PUBLIC;

CREATE FUNCTION public.qa_text_is_valid(value text,max_bytes integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE encoded bytea; DECLARE i integer;
BEGIN
  IF value IS NULL OR max_bytes<1 THEN RETURN false; END IF;
  encoded:=convert_to(value,'UTF8');
  FOR i IN 0..octet_length(encoded)-1 LOOP
    IF get_byte(encoded,i)=0 THEN RETURN false; END IF;
  END LOOP;
  RETURN octet_length(encoded) BETWEEN 1 AND max_bytes
    AND get_byte(encoded,0) NOT BETWEEN 0 AND 32 AND get_byte(encoded,0)<>127
    AND get_byte(encoded,octet_length(encoded)-1) NOT BETWEEN 0 AND 32
    AND get_byte(encoded,octet_length(encoded)-1)<>127;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_text_is_valid(text,integer) FROM PUBLIC;

CREATE FUNCTION public.qa_target_url_is_valid(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE encoded bytea; DECLARE i integer; DECLARE remainder text; DECLARE authority text;
DECLARE host text; DECLARE raw_port text; DECLARE labels text[]; DECLARE label text;
DECLARE parts text[]; DECLARE part text;
BEGIN
  IF value IS NULL THEN RETURN false; END IF;
  encoded:=convert_to(value,'UTF8');
  IF octet_length(encoded) NOT BETWEEN 1 AND 2048 THEN RETURN false; END IF;
  FOR i IN 0..octet_length(encoded)-1 LOOP
    IF get_byte(encoded,i)<33 OR get_byte(encoded,i)>126 THEN RETURN false; END IF;
  END LOOP;
  IF value !~ '^https?://[^/?#:]+(?::[0-9]+)?(?:[/?][^#]*)?$' THEN RETURN false; END IF;
  remainder:=substring(value FROM position('://' IN value)+3);
  authority:=substring(remainder FROM '^[^/?#]+');
  IF authority LIKE '%:%' THEN
    IF authority !~ '^[^:]+:[0-9]+$' THEN RETURN false; END IF;
    host:=split_part(authority,':',1); raw_port:=split_part(authority,':',2);
    IF raw_port !~ '^[1-9][0-9]{0,4}$' OR raw_port::integer>65535 THEN RETURN false; END IF;
  ELSE host:=authority; END IF;
  IF host IS NULL OR host='' OR octet_length(host)>253 OR host<>lower(host) THEN RETURN false; END IF;
  IF host ~ '^[0-9.]+$' THEN
    parts:=string_to_array(host,'.');
    IF array_length(parts,1) IS DISTINCT FROM 4 THEN RETURN false; END IF;
    FOREACH part IN ARRAY parts LOOP
      IF part !~ '^(?:0|[1-9][0-9]{0,2})$' OR part::integer>255 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  labels:=string_to_array(host,'.');
  FOREACH label IN ARRAY labels LOOP
    IF label !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_target_url_is_valid(text) FROM PUBLIC;

-- Exact canonical persisted-policy validation. A present malformed policy must
-- never acquire the same semantics as an absent or canonical required=false policy.
CREATE FUNCTION public.qa_policy_is_valid(policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(policy) key)
      IS DISTINCT FROM ARRAY['flows','required','target_url','viewports']
    OR jsonb_typeof(policy->'required') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(policy->'viewports') IS DISTINCT FROM 'array'
    OR jsonb_typeof(policy->'flows') IS DISTINCT FROM 'array'
    OR octet_length(convert_to(public.qa_jsonb_canonical(policy),'UTF8'))>65536
    OR jsonb_array_length(policy->'viewports')>8 OR jsonb_array_length(policy->'flows')>20 THEN RETURN false;
  END IF;
  IF policy->'required'='false'::jsonb THEN
    RETURN policy->'target_url' IS NOT DISTINCT FROM 'null'::jsonb
      AND jsonb_array_length(policy->'viewports')=0 AND jsonb_array_length(policy->'flows')=0;
  END IF;
  IF policy->'required' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(policy->'target_url') IS DISTINCT FROM 'string'
    OR NOT public.qa_target_url_is_valid(policy->>'target_url')
    OR jsonb_array_length(policy->'viewports')=0 THEN RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
          IS DISTINCT FROM ARRAY['height','name','width']
        OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
        OR NOT public.qa_text_is_valid(item->>'name',80)
        OR jsonb_typeof(item->'width') IS DISTINCT FROM 'number' OR item->>'width' !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(item->'height') IS DISTINCT FROM 'number' OR item->>'height' !~ '^(0|[1-9][0-9]*)$'
        OR (item->>'width')::integer NOT BETWEEN 320 AND 2560 OR (item->>'height')::integer NOT BETWEEN 320 AND 2560)
    OR (SELECT count(*) FROM jsonb_array_elements(policy->'viewports')) IS DISTINCT FROM
       (SELECT count(DISTINCT lower(item->>'name')) FROM jsonb_array_elements(policy->'viewports') item)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'flows') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item#>>'{}',500))
    OR (SELECT count(*) FROM jsonb_array_elements_text(policy->'flows')) IS DISTINCT FROM
       (SELECT count(DISTINCT flow) FROM jsonb_array_elements_text(policy->'flows') flow) THEN RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_policy_is_valid(jsonb) FROM PUBLIC;

-- Defense-in-depth result validation mirrors the complete bounded TypeScript contract.
CREATE FUNCTION public.qa_result_is_valid(value jsonb, expected_sha text, policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE verdict text;
DECLARE expected_viewports integer;
DECLARE expected_flows integer;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) key)
      IS DISTINCT FROM ARRAY['error','evidence','findings','flow_checks','tested_sha','verdict','viewport_checks']
    OR jsonb_typeof(value->'verdict') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'tested_sha') IS DISTINCT FROM 'string'
    OR value->>'tested_sha' IS DISTINCT FROM expected_sha
    OR jsonb_typeof(value->'viewport_checks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'flow_checks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'evidence') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'findings') IS DISTINCT FROM 'array'
    OR octet_length(convert_to(public.qa_jsonb_canonical(value),'UTF8'))>262144
    OR NOT public.qa_policy_is_valid(policy)
    OR policy->'required' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;
  END IF;
  verdict := value->>'verdict';
  IF verdict IS NULL OR verdict NOT IN ('pass','changes','infrastructure_failure') THEN RETURN false; END IF;
  IF value->'error' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'error') IS DISTINCT FROM 'string'
    OR NOT public.qa_text_is_valid(value->>'error',2048)) THEN RETURN false; END IF;
  IF jsonb_array_length(value->'evidence')>64 OR jsonb_array_length(value->'findings')>50 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(value->'evidence') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
        IS DISTINCT FROM ARRAY['bytes','flow','kind','media_type','sha256','storage_ref','viewport']
      OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string' OR item->>'kind' NOT IN ('screenshot','video','trace','log')
      OR jsonb_typeof(item->'storage_ref') IS DISTINCT FROM 'string'
      OR NOT public.qa_text_is_valid(item->>'storage_ref',1024)
      OR item->>'storage_ref' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      OR item->>'storage_ref' LIKE '%//%' OR item->>'storage_ref' ~ '(^|/)[.][.]?(/|$)'
      OR jsonb_typeof(item->'sha256') IS DISTINCT FROM 'string' OR item->>'sha256' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(item->'bytes') IS DISTINCT FROM 'number' OR item->>'bytes' !~ '^(0|[1-9][0-9]*)$'
      OR (item->>'bytes')::numeric>104857600
      OR jsonb_typeof(item->'media_type') IS DISTINCT FROM 'string'
      OR item->>'media_type' NOT IN ('image/png','image/jpeg','image/webp','video/webm','video/mp4','application/json','application/zip','text/plain')
      OR jsonb_typeof(item->'viewport') NOT IN ('null','string') OR jsonb_typeof(item->'flow') NOT IN ('null','string')
      OR (jsonb_typeof(item->'viewport')='string' AND (NOT public.qa_text_is_valid(item->>'viewport',80)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') p WHERE p->>'name' IS NOT DISTINCT FROM item->>'viewport')))
      OR (jsonb_typeof(item->'flow')='string' AND (NOT public.qa_text_is_valid(item->>'flow',500)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'flows') p(flow) WHERE p.flow IS NOT DISTINCT FROM item->>'flow')))) THEN RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(value->'findings') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['evidence','recommendation','title']
      OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'title',500)
      OR jsonb_typeof(item->'evidence') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'evidence',2048)
      OR jsonb_typeof(item->'recommendation') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'recommendation',2048)) THEN RETURN false;
  END IF;
  IF verdict='infrastructure_failure' THEN
    RETURN jsonb_array_length(value->'viewport_checks')=0 AND jsonb_array_length(value->'flow_checks')=0
      AND jsonb_array_length(value->'evidence')=0 AND jsonb_array_length(value->'findings')=0
      AND jsonb_typeof(value->'error')='string' AND public.qa_text_is_valid(value->>'error',2048);
  END IF;
  expected_viewports := jsonb_array_length(policy->'viewports'); expected_flows := jsonb_array_length(policy->'flows');
  IF jsonb_array_length(value->'viewport_checks') IS DISTINCT FROM expected_viewports
    OR jsonb_array_length(value->'flow_checks') IS DISTINCT FROM expected_flows
    OR (SELECT count(DISTINCT item->>'viewport') FROM jsonb_array_elements(value->'viewport_checks') item) IS DISTINCT FROM expected_viewports::bigint
    OR (SELECT count(DISTINCT item->>'flow') FROM jsonb_array_elements(value->'flow_checks') item) IS DISTINCT FROM expected_flows::bigint
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['details','status','viewport']
      OR jsonb_typeof(item->'viewport') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') p WHERE p->>'name' IS NOT DISTINCT FROM item->>'viewport')
      OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string' OR item->>'status' NOT IN ('pass','fail')
      OR jsonb_typeof(item->'details') NOT IN ('null','string')
      OR (jsonb_typeof(item->'details')='string' AND NOT public.qa_text_is_valid(item->>'details',2048)))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['details','flow','status']
      OR jsonb_typeof(item->'flow') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'flows') p(flow) WHERE p.flow IS NOT DISTINCT FROM item->>'flow')
      OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string' OR item->>'status' NOT IN ('pass','fail')
      OR jsonb_typeof(item->'details') NOT IN ('null','string')
      OR (jsonb_typeof(item->'details')='string' AND NOT public.qa_text_is_valid(item->>'details',2048))) THEN RETURN false;
  END IF;
  IF value->'error' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  IF verdict='pass' THEN
    RETURN jsonb_array_length(value->'findings')=0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE item->>'status' IS DISTINCT FROM 'pass')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE item->>'status' IS DISTINCT FROM 'pass');
  END IF;
  RETURN jsonb_array_length(value->'findings')>0 AND (
    EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE item->>'status'='fail')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE item->>'status'='fail'));
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_result_is_valid(jsonb,text,jsonb) FROM PUBLIC;

-- Replace Phase 4's two-role trigger with explicit implementation/review/qa branches.
DROP TRIGGER loop_task_runs_quality_integrity ON public.loop_task_runs;
DROP TRIGGER loop_task_reviews_quality_integrity ON public.loop_task_reviews;
CREATE OR REPLACE FUNCTION public.validate_loop_quality_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
DECLARE target public.loop_task_runs%ROWTYPE;
DECLARE implementation public.loop_task_runs%ROWTYPE;
DECLARE review_run public.loop_task_runs%ROWTYPE;
DECLARE qa_work public.work_items%ROWTYPE;
DECLARE reviewer_session text;
DECLARE phase4 boolean;
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' THEN
    SELECT NEW.run_role IN ('review','qa') OR NEW.repository_id IS NOT NULL OR NEW.base_sha IS NOT NULL
      OR NEW.artifact_sha IS NOT NULL OR NEW.server_session_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.work_items wi WHERE wi.id=NEW.work_item_id
        AND wi.payload->>'runtime_contract' IN ('fresh_review_v1','visual_qa_v1')) INTO phase4;
    IF phase4 AND (NEW.repository_id IS NULL OR NEW.base_sha IS NULL) THEN RAISE EXCEPTION 'Phase 4+ run requires registered repository and base SHA' USING ERRCODE='23514'; END IF;
    IF NEW.run_role='implementation' THEN
      IF NEW.target_run_id IS NOT NULL OR NEW.target_sha IS NOT NULL THEN RAISE EXCEPTION 'Implementation run cannot have target identity' USING ERRCODE='23514'; END IF;
      IF phase4 AND NEW.status='succeeded' AND (NEW.artifact_sha IS NULL OR NEW.server_session_id IS NULL) THEN RAISE EXCEPTION 'Succeeded Phase 4 implementation run requires artifact SHA and server session' USING ERRCODE='23514'; END IF;
    ELSIF NEW.run_role='review' THEN
      SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
      IF NOT FOUND OR target.task_id<>NEW.task_id OR target.run_role<>'implementation' OR target.quality_cycle<>NEW.quality_cycle OR target.status<>'succeeded' OR target.artifact_sha IS NULL OR target.artifact_sha<>NEW.target_sha OR target.repository_id<>NEW.repository_id OR target.base_sha<>NEW.base_sha THEN RAISE EXCEPTION 'Review run target integrity mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.status='succeeded' AND (NEW.server_session_id IS NULL OR target.server_session_id IS NULL OR NEW.server_session_id=target.server_session_id) THEN RAISE EXCEPTION 'Review run terminal session integrity mismatch' USING ERRCODE='23514'; END IF;
    ELSIF NEW.run_role='qa' THEN
      SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
      SELECT * INTO qa_work FROM public.work_items WHERE id=NEW.work_item_id;
      SELECT d.reviewer_session_id INTO reviewer_session FROM public.loop_task_reviews d
        WHERE d.task_id=NEW.task_id AND d.task_run_id=NEW.target_run_id AND d.quality_cycle=NEW.quality_cycle
          AND d.status='approved' AND d.reviewed_sha=NEW.target_sha;
      IF NOT FOUND OR target.task_id IS DISTINCT FROM NEW.task_id OR target.run_role IS DISTINCT FROM 'implementation'
        OR target.quality_cycle IS DISTINCT FROM NEW.quality_cycle OR target.status IS DISTINCT FROM 'succeeded'
        OR target.artifact_sha IS NULL OR target.artifact_sha IS DISTINCT FROM NEW.target_sha
        OR target.repository_id IS DISTINCT FROM NEW.repository_id OR target.base_sha IS DISTINCT FROM NEW.base_sha
        OR reviewer_session IS NULL OR qa_work.id IS NULL
        OR (NEW.status='queued' AND qa_work.status IS DISTINCT FROM 'ready')
        OR (NEW.status='running' AND (qa_work.status IS NULL OR qa_work.status NOT IN ('ready','in_progress')))
        OR (NEW.status='succeeded' AND (qa_work.status IS NULL OR qa_work.status NOT IN ('in_progress','done')))
        OR (NEW.status IN ('failed','cancelled') AND (qa_work.status IS NULL OR qa_work.status NOT IN ('in_progress','failed','canceled')))
        OR qa_work.source_type IS DISTINCT FROM 'loop'
        OR qa_work.source_id IS DISTINCT FROM NEW.task_id::text
        OR qa_work.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1'
        OR qa_work.payload->>'run_role' IS DISTINCT FROM 'qa'
        OR qa_work.payload->>'loop_task_id' IS DISTINCT FROM NEW.task_id::text
        OR qa_work.payload->>'execution_attempt_id' IS DISTINCT FROM NEW.execution_attempt_id::text
        OR qa_work.payload->>'quality_cycle' IS DISTINCT FROM NEW.quality_cycle::text
        OR qa_work.payload->>'target_run_id' IS DISTINCT FROM NEW.target_run_id::text
        OR qa_work.payload->>'target_sha' IS DISTINCT FROM NEW.target_sha
        OR qa_work.payload->'qa_policy' IS DISTINCT FROM (SELECT metadata->'qa_policy' FROM public.loop_tasks WHERE id=NEW.task_id)
        OR NOT public.qa_policy_is_valid(qa_work.payload->'qa_policy')
        OR qa_work.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
        OR qa_work.payload->>'policy_hash' IS DISTINCT FROM public.qa_jsonb_sha256(qa_work.payload->'qa_policy') THEN
        RAISE EXCEPTION 'QA run work/target/policy integrity mismatch' USING ERRCODE='23514';
      END IF;
      IF (NEW.status='succeeded' OR (NEW.status='failed' AND NEW.server_session_id IS NOT NULL)) AND NEW.finished_at IS NOT NULL
        AND (NEW.server_session_id IS NULL OR NEW.server_session_id !~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$' OR target.server_session_id IS NULL
        OR NEW.server_session_id IN (target.server_session_id,reviewer_session)) THEN
        RAISE EXCEPTION 'QA run terminal session integrity mismatch' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Unknown Loop run role' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.review_run_id IS NULL AND NEW.quality_cycle IS NULL THEN RETURN NEW; END IF;
  IF NEW.review_run_id IS NULL OR NEW.quality_cycle IS NULL OR NEW.task_run_id IS NULL THEN RAISE EXCEPTION 'Review decision identity is incomplete' USING ERRCODE='23514'; END IF;
  SELECT * INTO implementation FROM public.loop_task_runs WHERE id=NEW.task_run_id;
  SELECT * INTO review_run FROM public.loop_task_runs WHERE id=NEW.review_run_id;
  IF implementation.id IS NULL OR review_run.id IS NULL OR implementation.task_id<>NEW.task_id OR review_run.task_id<>NEW.task_id OR implementation.run_role<>'implementation' OR review_run.run_role<>'review' OR implementation.quality_cycle<>NEW.quality_cycle OR review_run.quality_cycle<>NEW.quality_cycle OR review_run.target_run_id<>implementation.id OR implementation.status<>'succeeded' OR implementation.artifact_sha IS NULL OR NEW.reviewed_sha IS DISTINCT FROM implementation.artifact_sha OR review_run.target_sha IS DISTINCT FROM implementation.artifact_sha THEN RAISE EXCEPTION 'Review decision run/SHA integrity mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.status='pending' THEN
    IF review_run.status NOT IN ('queued','running') OR NEW.reviewer_session_id IS NOT NULL OR NEW.decision_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN RAISE EXCEPTION 'Pending review decision fields are incoherent' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status IN ('approved','changes_requested') THEN
    IF review_run.status<>'succeeded' OR NEW.reviewer_session_id IS NULL OR review_run.server_session_id IS DISTINCT FROM NEW.reviewer_session_id OR implementation.server_session_id IS NULL OR NEW.reviewer_session_id=implementation.server_session_id OR NEW.decision_id IS NULL OR NEW.decided_at IS NULL OR NEW.reviewer IS NULL THEN RAISE EXCEPTION 'Terminal review decision fields are incoherent' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status='rejected' AND review_run.status NOT IN ('failed','cancelled') THEN RAISE EXCEPTION 'Failed review decision is incoherent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER loop_task_runs_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();
CREATE TRIGGER loop_task_reviews_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();

CREATE FUNCTION public.validate_qa_execution_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE qa_run public.loop_task_runs%ROWTYPE;
DECLARE target public.loop_task_runs%ROWTYPE;
DECLARE work public.work_items%ROWTYPE;
DECLARE reviewer_session text;
BEGIN
  SELECT * INTO qa_run FROM public.loop_task_runs WHERE id=NEW.qa_run_id;
  SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
  SELECT * INTO work FROM public.work_items WHERE id=NEW.work_item_id;
  SELECT d.reviewer_session_id INTO reviewer_session FROM public.loop_task_reviews d
    WHERE d.task_id=NEW.task_id AND d.task_run_id=NEW.target_run_id AND d.quality_cycle=qa_run.quality_cycle
      AND d.status='approved' AND d.reviewed_sha=NEW.target_sha;
  IF qa_run.id IS NULL OR target.id IS NULL OR work.id IS NULL
    OR qa_run.run_role IS DISTINCT FROM 'qa' OR qa_run.task_id IS DISTINCT FROM NEW.task_id
    OR qa_run.work_item_id IS DISTINCT FROM NEW.work_item_id OR qa_run.execution_attempt_id IS DISTINCT FROM NEW.execution_attempt_id
    OR qa_run.target_run_id IS DISTINCT FROM NEW.target_run_id OR qa_run.target_sha IS DISTINCT FROM NEW.target_sha
    OR target.task_id IS DISTINCT FROM NEW.task_id OR target.quality_cycle IS DISTINCT FROM qa_run.quality_cycle
    OR target.run_role IS DISTINCT FROM 'implementation' OR target.status IS DISTINCT FROM 'succeeded'
    OR target.artifact_sha IS DISTINCT FROM NEW.target_sha
    OR work.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1' OR work.payload->>'run_role' IS DISTINCT FROM 'qa'
    OR work.payload->>'execution_attempt_id' IS DISTINCT FROM NEW.execution_attempt_id::text
    OR work.payload->>'target_run_id' IS DISTINCT FROM NEW.target_run_id::text
    OR work.payload->>'target_sha' IS DISTINCT FROM NEW.target_sha OR work.payload->>'policy_hash' IS DISTINCT FROM NEW.policy_hash
    OR work.payload->>'quality_cycle' IS DISTINCT FROM qa_run.quality_cycle::text
    OR work.payload->'qa_policy' IS DISTINCT FROM (SELECT metadata->'qa_policy' FROM public.loop_tasks WHERE id=NEW.task_id)
    OR NOT public.qa_policy_is_valid(work.payload->'qa_policy')
    OR work.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
    OR NEW.policy_hash IS DISTINCT FROM public.qa_jsonb_sha256(work.payload->'qa_policy')
    OR work.payload->>'plan_revision_id' IS DISTINCT FROM (SELECT s.plan_revision_id::text FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id WHERE t.id=NEW.task_id)
    OR work.payload->>'plan_hash' IS DISTINCT FROM (SELECT p.content_hash FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id WHERE t.id=NEW.task_id AND p.status='approved')
    OR coalesce((SELECT l.current_plan_revision_id IS DISTINCT FROM s.plan_revision_id FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id JOIN public.loops l ON l.id=p.loop_id WHERE t.id=NEW.task_id),true)
    OR reviewer_session IS NULL THEN
    RAISE EXCEPTION 'QA execution binding integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.qa_session_id IS NULL OR NEW.qa_session_id IS NOT DISTINCT FROM target.server_session_id
    OR NEW.qa_session_id IS NOT DISTINCT FROM reviewer_session
    OR EXISTS (SELECT 1 FROM public.loop_task_runs r WHERE r.run_role IN ('implementation','review')
      AND r.server_session_id IS NOT DISTINCT FROM NEW.qa_session_id) THEN
    RAISE EXCEPTION 'QA execution session integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.result IS NOT NULL AND (NOT public.qa_result_is_valid(NEW.result,NEW.target_sha,work.payload->'qa_policy')
    OR NEW.result_hash IS DISTINCT FROM public.qa_jsonb_sha256(NEW.result)) THEN
    RAISE EXCEPTION 'QA execution result/SHA/hash integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='succeeded' AND (qa_run.status IS DISTINCT FROM 'succeeded'
    OR jsonb_typeof(NEW.result->'verdict') IS DISTINCT FROM 'string'
    OR NEW.result->>'verdict' NOT IN ('pass','changes')
    OR NEW.qa_session_id IS DISTINCT FROM qa_run.server_session_id) THEN
    RAISE EXCEPTION 'QA execution terminal session integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='failed' AND NEW.capability_consumed_at IS NOT NULL
    AND (qa_run.status IS DISTINCT FROM 'failed' OR NEW.result->>'verdict' IS DISTINCT FROM 'infrastructure_failure'
      OR NEW.error IS DISTINCT FROM NEW.result->>'error' OR NEW.qa_session_id IS DISTINCT FROM qa_run.server_session_id) THEN
    RAISE EXCEPTION 'QA infrastructure failure integrity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION public.validate_qa_execution_integrity() FROM PUBLIC;
CREATE TRIGGER qa_executions_integrity BEFORE INSERT OR UPDATE ON public.qa_executions FOR EACH ROW EXECUTE FUNCTION public.validate_qa_execution_integrity();

-- visual_qa_v1 work can move only inside the dedicated atomic transition function.
-- Claim/pass authority carries the raw capability only in this transaction-scoped,
-- immediately deleted proof row. Reconcile is intentionally bounded to fail-safe blocking.
-- Database-owner/superuser trigger alteration or disabling is outside this boundary.
CREATE TABLE public.qa_work_item_transition_authorities (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  work_item_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  transition text NOT NULL CHECK (transition IN ('claim','complete','reconcile')),
  capability_proof text CHECK (capability_proof IS NULL OR capability_proof ~ '^[A-Za-z0-9_-]{43}$'),
  PRIMARY KEY (backend_pid,transaction_id,work_item_id)
);
REVOKE ALL ON public.qa_work_item_transition_authorities FROM PUBLIC,aipaths_mc_app;
ALTER TABLE public.qa_work_item_transition_authorities OWNER TO aipaths_mc_qa_owner;

CREATE FUNCTION public.guard_visual_qa_work_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE transition text;
BEGIN
  IF TG_OP='INSERT' OR OLD.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1' THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'visual_qa_v1 work cannot be deleted' USING ERRCODE='23514'; END IF;
  SELECT a.transition INTO transition FROM public.qa_work_item_transition_authorities a
    JOIN public.qa_executions qe ON qe.id=a.execution_id AND qe.work_item_id=a.work_item_id
    WHERE a.backend_pid=pg_backend_pid() AND a.transaction_id=txid_current() AND a.work_item_id=NEW.id
      AND a.execution_id::text IS NOT DISTINCT FROM NEW.payload->>'qa_execution_id'
      AND qe.status='running' AND qe.capability_consumed_at IS NULL AND qe.capability_revoked_at IS NULL
      AND ((a.transition IN ('claim','complete') AND a.capability_proof IS NOT NULL
          AND public.digest(convert_to(a.capability_proof,'UTF8'),'sha256') IS NOT DISTINCT FROM qe.capability_hash)
        OR (a.transition='reconcile' AND (a.capability_proof IS NULL OR (
          public.digest(convert_to(a.capability_proof,'UTF8'),'sha256') IS NOT DISTINCT FROM qe.capability_hash))));
  IF transition IS NULL THEN
    RAISE EXCEPTION 'visual_qa_v1 work requires dedicated transition authority with valid capability' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','started_at','completed_at','updated_at','payload'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','started_at','completed_at','updated_at','payload'])
    OR (NEW.payload - ARRAY['dispatch_state','qa_execution_id','dispatch_completed_at'])
      IS DISTINCT FROM (OLD.payload - ARRAY['dispatch_state','qa_execution_id','dispatch_completed_at']) THEN
    RAISE EXCEPTION 'visual_qa_v1 work identity is immutable' USING ERRCODE='23514';
  END IF;
  IF (transition='claim' AND NOT (OLD.status='ready' AND NEW.status='in_progress'))
    OR (transition='complete' AND NOT (OLD.status='in_progress' AND NEW.status='done'))
    OR (transition='reconcile' AND NOT (OLD.status='in_progress' AND NEW.status='failed')) THEN
    RAISE EXCEPTION 'visual_qa_v1 work transition is invalid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.loop_task_runs qr JOIN public.qa_executions qe ON qe.qa_run_id=qr.id AND qe.work_item_id=NEW.id
    WHERE qr.work_item_id=NEW.id AND qe.id::text IS NOT DISTINCT FROM NEW.payload->>'qa_execution_id' AND qe.status='running'
      AND qe.capability_consumed_at IS NULL AND qe.capability_revoked_at IS NULL
      AND ((transition='claim' AND qr.status='running' AND OLD.payload->>'dispatch_state' IS NOT DISTINCT FROM 'ready'
            AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'in_progress')
        OR (transition='complete' AND qr.status='succeeded' AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'completed')
        OR (transition='reconcile' AND qr.status='failed' AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'failed'))
  ) THEN RAISE EXCEPTION 'visual_qa_v1 work transition authority mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION public.guard_visual_qa_work_item() FROM PUBLIC;
CREATE TRIGGER visual_qa_work_items_guard BEFORE UPDATE OR DELETE ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.guard_visual_qa_work_item();
ALTER FUNCTION public.validate_qa_execution_integrity() OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.guard_visual_qa_work_item() OWNER TO aipaths_mc_qa_owner;

-- Least-privilege authority-owner access used only through fixed SECURITY DEFINER entry points.
GRANT SELECT ON public.work_items,public.loop_task_runs,public.loop_task_reviews,public.loop_tasks,
  public.loop_stages,public.loop_plan_revisions,public.loops TO aipaths_mc_qa_owner;
GRANT UPDATE ON public.work_items,public.loop_task_runs,public.loop_tasks,public.loops TO aipaths_mc_qa_owner;

CREATE FUNCTION public.transition_visual_qa_work_item(work_id uuid, p_execution_id uuid, transition_name text,
  transition_at timestamptz, raw_capability text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE changed integer;
DECLARE execution public.qa_executions%ROWTYPE;
DECLARE run_status text;
BEGIN
  IF transition_name IS NULL OR transition_name NOT IN ('claim','complete','reconcile') OR transition_at IS NULL THEN
    RAISE EXCEPTION 'invalid visual QA transition request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO execution FROM public.qa_executions qe
    WHERE qe.id=p_execution_id AND qe.work_item_id=work_id FOR UPDATE;
  SELECT status INTO run_status FROM public.loop_task_runs WHERE id=execution.qa_run_id AND work_item_id=work_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running'
    OR execution.capability_consumed_at IS NOT NULL OR execution.capability_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'visual QA transition execution authority mismatch' USING ERRCODE='23514';
  END IF;
  IF (transition_name IN ('claim','complete') OR (transition_name='reconcile' AND raw_capability IS NOT NULL))
    AND (raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
      OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
      OR execution.capability_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'invalid or expired visual QA raw capability' USING ERRCODE='28000';
  END IF;
  IF (transition_name='claim' AND run_status IS DISTINCT FROM 'running')
    OR (transition_name='complete' AND run_status IS DISTINCT FROM 'succeeded')
    OR (transition_name='reconcile' AND run_status IS DISTINCT FROM 'failed') THEN
    RAISE EXCEPTION 'visual QA transition run authority mismatch' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.qa_work_item_transition_authorities
    (backend_pid,transaction_id,work_item_id,execution_id,transition,capability_proof)
    VALUES(pg_backend_pid(),txid_current(),work_id,p_execution_id,transition_name,
      CASE WHEN raw_capability IS NOT NULL THEN raw_capability ELSE NULL END);
  UPDATE public.work_items SET
    status=CASE transition_name WHEN 'claim' THEN 'in_progress' WHEN 'complete' THEN 'done' ELSE 'failed' END,
    started_at=CASE WHEN transition_name='claim' THEN coalesce(started_at,transition_at) ELSE started_at END,
    completed_at=CASE WHEN transition_name='claim' THEN completed_at ELSE transition_at END,
    updated_at=transition_at,
    payload=payload||CASE transition_name
      WHEN 'claim' THEN jsonb_build_object('dispatch_state','in_progress','qa_execution_id',p_execution_id::text)
      WHEN 'complete' THEN jsonb_build_object('dispatch_state','completed','dispatch_completed_at',transition_at::text)
      ELSE jsonb_build_object('dispatch_state','failed','dispatch_completed_at',transition_at::text) END
    WHERE id=work_id AND ((transition_name='claim' AND status='ready') OR (transition_name IN ('complete','reconcile') AND status='in_progress'));
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM public.qa_work_item_transition_authorities a WHERE a.backend_pid=pg_backend_pid()
    AND a.transaction_id=txid_current() AND a.work_item_id=work_id;
  RETURN changed=1;
END $body$;
REVOKE ALL ON FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) FROM PUBLIC;
ALTER FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) FROM aipaths_mc_app;

-- A claim is accepted only when the exact versioned envelope was signed by the
-- server-held key and every envelope field still matches locked database state.
CREATE FUNCTION public.claim_visual_qa_execution(envelope jsonb,signature text,raw_capability text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE key_material bytea; DECLARE row_data record; DECLARE claim_time timestamptz; DECLARE expires_time timestamptz;
DECLARE changed integer; DECLARE execution_id uuid; DECLARE work_id uuid; DECLARE run_id uuid;
BEGIN
  IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(envelope) key) IS DISTINCT FROM
      ARRAY['base_sha','capability_expires_at','capability_hash','claimed_at','execution_attempt_id','execution_id',
        'implementer_session_id','loop_id','plan_hash','plan_revision_id','policy_hash','qa_run_id','qa_session_id',
        'quality_cycle','repository_id','reviewer_session_id','target_run_id','target_sha','task_id','version','work_item_id']
    OR envelope->>'version' IS DISTINCT FROM 'qa_claim_v1'
    OR jsonb_typeof(envelope->'quality_cycle') IS DISTINCT FROM 'number'
    OR envelope->>'quality_cycle' !~ '^[1-3]$'
    OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR envelope->>'capability_hash' !~ '^[0-9a-f]{64}$'
    OR encode(public.digest(convert_to(raw_capability,'UTF8'),'sha256'),'hex') IS DISTINCT FROM envelope->>'capability_hash'
    OR EXISTS (SELECT 1 FROM jsonb_each(envelope) e WHERE e.key<>'quality_cycle' AND jsonb_typeof(e.value) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'invalid signed visual QA claim envelope' USING ERRCODE='22023';
  END IF;
  SELECT hmac_key INTO key_material FROM public.qa_authority_secrets WHERE singleton=true;
  IF key_material IS NULL OR encode(public.hmac(convert_to(public.qa_jsonb_canonical(envelope),'UTF8'),key_material,'sha256'),'hex')
      IS DISTINCT FROM signature THEN
    RAISE EXCEPTION 'invalid visual QA claim signature' USING ERRCODE='28000';
  END IF;
  claim_time:=(envelope->>'claimed_at')::timestamptz; expires_time:=(envelope->>'capability_expires_at')::timestamptz;
  IF envelope->>'claimed_at' IS DISTINCT FROM to_char(claim_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR envelope->>'capability_expires_at' IS DISTINCT FROM to_char(expires_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR expires_time IS DISTINCT FROM claim_time+interval '30 minutes'
    OR claim_time NOT BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'invalid visual QA claim timestamp binding' USING ERRCODE='22023';
  END IF;
  execution_id:=(envelope->>'execution_id')::uuid; work_id:=(envelope->>'work_item_id')::uuid; run_id:=(envelope->>'qa_run_id')::uuid;
  SELECT r.id qa_run_id,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,r.quality_cycle,
    r.repository_id,r.base_sha,r.status run_status,wi.status work_status,wi.payload,t.status task_status,t.metadata,
    p.id plan_revision_id,p.content_hash plan_hash,p.status revision_status,l.id loop_id,l.status loop_status,l.current_plan_revision_id,
    impl.status implementation_status,impl.run_role implementation_role,impl.artifact_sha implementation_sha,
    impl.server_session_id implementer_session_id,d.reviewer_session_id,d.reviewed_sha
    INTO row_data FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id
    JOIN public.loop_tasks t ON t.id=r.task_id JOIN public.loop_stages s ON s.id=t.stage_id
    JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id JOIN public.loops l ON l.id=p.loop_id
    JOIN public.loop_task_runs impl ON impl.id=r.target_run_id AND impl.task_id=r.task_id
    JOIN public.loop_task_reviews d ON d.task_id=r.task_id AND d.task_run_id=impl.id AND d.quality_cycle=r.quality_cycle
      AND d.status='approved' AND d.reviewed_sha=r.target_sha
    WHERE r.id=run_id AND wi.id=work_id FOR UPDATE OF r,wi,t,l;
  IF row_data.qa_run_id IS NULL OR row_data.run_status IS DISTINCT FROM 'queued' OR row_data.work_status IS DISTINCT FROM 'ready'
    OR row_data.task_status IS DISTINCT FROM 'qa_pending' OR row_data.loop_status IS DISTINCT FROM 'in_progress'
    OR row_data.revision_status IS DISTINCT FROM 'approved' OR row_data.current_plan_revision_id IS DISTINCT FROM row_data.plan_revision_id
    OR row_data.implementation_role IS DISTINCT FROM 'implementation' OR row_data.implementation_status IS DISTINCT FROM 'succeeded'
    OR row_data.implementation_sha IS DISTINCT FROM row_data.target_sha OR row_data.reviewed_sha IS DISTINCT FROM row_data.target_sha
    OR row_data.implementer_session_id IS NULL OR row_data.reviewer_session_id IS NULL
    OR row_data.implementer_session_id IS NOT DISTINCT FROM row_data.reviewer_session_id
    OR envelope->>'task_id' IS DISTINCT FROM row_data.task_id::text
    OR envelope->>'work_item_id' IS DISTINCT FROM row_data.work_item_id::text
    OR envelope->>'execution_attempt_id' IS DISTINCT FROM row_data.execution_attempt_id::text
    OR envelope->>'target_run_id' IS DISTINCT FROM row_data.target_run_id::text
    OR envelope->>'target_sha' IS DISTINCT FROM row_data.target_sha
    OR envelope->>'quality_cycle' IS DISTINCT FROM row_data.quality_cycle::text
    OR envelope->>'repository_id' IS DISTINCT FROM row_data.repository_id::text
    OR envelope->>'base_sha' IS DISTINCT FROM row_data.base_sha
    OR envelope->>'plan_revision_id' IS DISTINCT FROM row_data.plan_revision_id::text
    OR envelope->>'plan_hash' IS DISTINCT FROM row_data.plan_hash
    OR envelope->>'loop_id' IS DISTINCT FROM row_data.loop_id::text
    OR envelope->>'implementer_session_id' IS DISTINCT FROM row_data.implementer_session_id
    OR envelope->>'reviewer_session_id' IS DISTINCT FROM row_data.reviewer_session_id
    OR envelope->>'policy_hash' IS DISTINCT FROM row_data.payload->>'policy_hash'
    OR row_data.payload->>'execution_attempt_id' IS DISTINCT FROM row_data.execution_attempt_id::text
    OR row_data.payload->>'target_run_id' IS DISTINCT FROM row_data.target_run_id::text
    OR row_data.payload->>'target_sha' IS DISTINCT FROM row_data.target_sha
    OR row_data.payload->'qa_policy' IS DISTINCT FROM row_data.metadata->'qa_policy'
    OR NOT public.qa_policy_is_valid(row_data.payload->'qa_policy')
    OR row_data.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
    OR envelope->>'policy_hash' IS DISTINCT FROM public.qa_jsonb_sha256(row_data.payload->'qa_policy') THEN
    RAISE EXCEPTION 'signed visual QA claim binding mismatch' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.qa_executions(id,qa_run_id,task_id,work_item_id,execution_attempt_id,target_run_id,target_sha,
    policy_hash,status,capability_hash,capability_expires_at,qa_session_id,claimed_at,heartbeat_at,created_at,updated_at)
  VALUES(execution_id,row_data.qa_run_id,row_data.task_id,row_data.work_item_id,row_data.execution_attempt_id,row_data.target_run_id,
    row_data.target_sha,envelope->>'policy_hash','running',decode(envelope->>'capability_hash','hex'),expires_time,
    envelope->>'qa_session_id',claim_time,claim_time,claim_time,claim_time);
  UPDATE public.loop_task_runs SET status='running',started_at=coalesce(started_at,claim_time),updated_at=claim_time
    WHERE id=run_id AND status='queued';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR NOT public.transition_visual_qa_work_item(work_id,execution_id,'claim',claim_time,raw_capability) THEN
    RAISE EXCEPTION 'visual QA claim concurrent conflict' USING ERRCODE='40001';
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
  RAISE EXCEPTION 'invalid signed visual QA claim envelope' USING ERRCODE='22023';
END $body$;
ALTER FUNCTION public.claim_visual_qa_execution(jsonb,text,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.claim_visual_qa_execution(jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_visual_qa_execution(jsonb,text,text) TO aipaths_mc_app;

CREATE FUNCTION public.heartbeat_visual_qa_execution(p_execution_id uuid,raw_capability text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE beat timestamptz; DECLARE run_data record;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,
    wi.status work_status,wi.payload INTO run_data FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id
    WHERE r.id=execution.qa_run_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR execution.capability_expires_at<=clock_timestamp()
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
    OR run_data.run_status IS DISTINCT FROM 'running' OR run_data.work_status IS DISTINCT FROM 'in_progress'
    OR run_data.task_id IS DISTINCT FROM execution.task_id OR run_data.work_item_id IS DISTINCT FROM execution.work_item_id
    OR run_data.execution_attempt_id IS DISTINCT FROM execution.execution_attempt_id
    OR run_data.target_run_id IS DISTINCT FROM execution.target_run_id OR run_data.target_sha IS DISTINCT FROM execution.target_sha
    OR run_data.payload->>'policy_hash' IS DISTINCT FROM execution.policy_hash THEN
    RAISE EXCEPTION 'invalid or expired visual QA heartbeat capability/binding' USING ERRCODE='28000';
  END IF;
  beat:=clock_timestamp();
  UPDATE public.qa_executions SET heartbeat_at=beat,updated_at=beat WHERE id=p_execution_id;
  RETURN beat;
END $body$;
ALTER FUNCTION public.heartbeat_visual_qa_execution(uuid,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.heartbeat_visual_qa_execution(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_visual_qa_execution(uuid,text) TO aipaths_mc_app;

CREATE FUNCTION public.complete_visual_qa_execution(p_execution_id uuid,p_attempt_id uuid,p_target_sha text,p_policy_hash text,
  p_session_id text,raw_capability text,p_result jsonb,p_result_hash text,p_finished_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE run_data record; DECLARE terminal_status text; DECLARE result_error text;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,r.server_session_id,wi.status work_status,wi.payload INTO run_data
    FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id WHERE r.id=execution.qa_run_id;
  terminal_status:=CASE WHEN p_result->>'verdict'='infrastructure_failure' THEN 'failed' ELSE 'succeeded' END;
  result_error:=CASE WHEN p_result->'error'='null'::jsonb THEN NULL ELSE p_result->>'error' END;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR p_finished_at IS NULL
    OR execution.capability_expires_at<=clock_timestamp() OR p_finished_at>execution.capability_expires_at
    OR p_finished_at<execution.claimed_at OR p_finished_at>clock_timestamp()+interval '1 minute'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
    OR p_attempt_id IS DISTINCT FROM execution.execution_attempt_id OR p_target_sha IS DISTINCT FROM execution.target_sha
    OR p_policy_hash IS DISTINCT FROM execution.policy_hash OR p_session_id IS DISTINCT FROM execution.qa_session_id
    OR run_data.payload->>'execution_attempt_id' IS DISTINCT FROM execution.execution_attempt_id::text
    OR run_data.payload->>'target_sha' IS DISTINCT FROM execution.target_sha
    OR run_data.payload->>'policy_hash' IS DISTINCT FROM execution.policy_hash
    OR NOT public.qa_result_is_valid(p_result,execution.target_sha,run_data.payload->'qa_policy')
    OR p_result_hash IS DISTINCT FROM public.qa_jsonb_sha256(p_result)
    OR run_data.run_status IS DISTINCT FROM terminal_status OR run_data.server_session_id IS DISTINCT FROM execution.qa_session_id
    OR run_data.work_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'visual QA completion capability/immutable binding mismatch' USING ERRCODE='28000';
  END IF;
  IF NOT public.transition_visual_qa_work_item(execution.work_item_id,p_execution_id,
      CASE WHEN terminal_status='failed' THEN 'reconcile' ELSE 'complete' END,p_finished_at,raw_capability) THEN
    RAISE EXCEPTION 'visual QA completion work transition conflict' USING ERRCODE='40001';
  END IF;
  UPDATE public.qa_executions SET status=terminal_status,error=result_error,capability_consumed_at=p_finished_at,
    finished_at=p_finished_at,result=p_result,result_hash=p_result_hash,heartbeat_at=p_finished_at,updated_at=p_finished_at
    WHERE id=p_execution_id AND status='running';
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) TO aipaths_mc_app;

CREATE FUNCTION public.reconcile_visual_qa_execution(p_execution_id uuid,p_reason text,p_finished_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE run_data record;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,wi.status work_status INTO run_data FROM public.loop_task_runs r
    JOIN public.work_items wi ON wi.id=r.work_item_id WHERE r.id=execution.qa_run_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR execution.heartbeat_at>=clock_timestamp()-interval '10 minutes'
    OR p_reason IS DISTINCT FROM 'qa_execution_stale_timeout' OR p_finished_at IS NULL
    OR run_data.run_status IS DISTINCT FROM 'failed' OR run_data.work_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'visual QA reconcile is not a stale running-to-failed transition' USING ERRCODE='23514';
  END IF;
  IF NOT public.transition_visual_qa_work_item(execution.work_item_id,p_execution_id,'reconcile',p_finished_at,NULL) THEN
    RAISE EXCEPTION 'visual QA reconcile work transition conflict' USING ERRCODE='40001';
  END IF;
  UPDATE public.qa_executions SET status='failed',error=p_reason,finished_at=p_finished_at,
    capability_revoked_at=p_finished_at,heartbeat_at=p_finished_at,updated_at=p_finished_at WHERE id=p_execution_id AND status='running';
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) TO aipaths_mc_app;

CREATE OR REPLACE FUNCTION public.reject_terminal_loop_quality_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' AND OLD.status IN ('succeeded','failed','cancelled') AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task run is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='loop_task_reviews' THEN
    IF TG_OP='DELETE' AND OLD.status='pending' THEN RAISE EXCEPTION 'Pending Loop task review cannot be deleted' USING ERRCODE='23514';
    ELSIF OLD.status<>'pending' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task review is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='reviewer_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal reviewer execution is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='qa_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal QA execution is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
CREATE TRIGGER qa_executions_terminal_immutable BEFORE UPDATE OR DELETE ON public.qa_executions FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();

-- -----------------------------------------------------------------------------
-- Canonical YouTube playlist catalog (read-only application surface)
-- -----------------------------------------------------------------------------
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_youtube_playlist_videos_position ON public.youtube_playlist_videos(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_status_home ON public.youtube_playlists(status, featured DESC, home_order, canonical_slug);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_use_cases ON public.youtube_playlists USING gin(use_cases);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_tags ON public.youtube_playlists USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_youtube_playlists_aliases ON public.youtube_playlists USING gin(aliases);
CREATE INDEX IF NOT EXISTS idx_youtube_playlist_videos_order ON public.youtube_playlist_videos(playlist_id, position, video_id);

-- Ordinary application SQL keeps existing Mission Control behavior but cannot
-- read key material or write/re-key/truncate QA authority rows. QA mutations are
-- exposed only through the exact entry points above.
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aipaths_mc_app;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO aipaths_mc_app;
DO $default_privileges$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO aipaths_mc_app',current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO aipaths_mc_app',current_user);
END $default_privileges$;
REVOKE ALL ON public.qa_authority_secrets,public.qa_work_item_transition_authorities FROM aipaths_mc_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.qa_executions FROM aipaths_mc_app;
GRANT SELECT ON public.qa_executions TO aipaths_mc_app;

ALTER FUNCTION public.qa_jsonb_canonical(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_jsonb_sha256(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_text_is_valid(text,integer) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_target_url_is_valid(text) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_policy_is_valid(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_result_is_valid(jsonb,text,jsonb) OWNER TO aipaths_mc_qa_owner;
GRANT EXECUTE ON FUNCTION public.qa_jsonb_canonical(jsonb),public.qa_jsonb_sha256(jsonb),
  public.qa_text_is_valid(text,integer),public.qa_target_url_is_valid(text),public.qa_policy_is_valid(jsonb),
  public.qa_result_is_valid(jsonb,text,jsonb) TO aipaths_mc_app;
COMMIT;
