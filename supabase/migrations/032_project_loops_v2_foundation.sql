-- Project Loops V2 phase 1 foundation.
-- Additive only: existing Loops remain workflow_version=1 and no V2 runtime is enabled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.loops
  ADD COLUMN workflow_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN mode text NOT NULL DEFAULT 'linear',
  ADD COLUMN current_plan_revision_id uuid,
  ADD COLUMN row_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT loops_workflow_version_check CHECK (workflow_version IN (1, 2)),
  ADD CONSTRAINT loops_mode_check CHECK (mode IN ('linear', 'dag')),
  ADD CONSTRAINT loops_row_version_check CHECK (row_version > 0);

CREATE TABLE public.loop_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loop_id uuid NOT NULL
    CONSTRAINT loop_plan_revisions_loop_id_fkey
    REFERENCES public.loops(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  summary text,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_plan_revisions_revision_number_check CHECK (revision_number > 0),
  CONSTRAINT loop_plan_revisions_status_check
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'superseded'))
);
CREATE UNIQUE INDEX uq_loop_plan_revisions_loop_revision
  ON public.loop_plan_revisions(loop_id, revision_number);
CREATE INDEX idx_loop_plan_revisions_loop_status
  ON public.loop_plan_revisions(loop_id, status, revision_number DESC);

CREATE TABLE public.loop_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id uuid NOT NULL
    CONSTRAINT loop_stages_plan_revision_id_fkey
    REFERENCES public.loop_plan_revisions(id) ON DELETE CASCADE,
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
  CONSTRAINT loop_stages_status_check
    CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled'))
);
CREATE UNIQUE INDEX uq_loop_stages_revision_key
  ON public.loop_stages(plan_revision_id, key);
CREATE INDEX idx_loop_stages_revision_position
  ON public.loop_stages(plan_revision_id, position, id);

CREATE TABLE public.loop_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL
    CONSTRAINT loop_tasks_stage_id_fkey
    REFERENCES public.loop_stages(id) ON DELETE CASCADE,
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
  CONSTRAINT loop_tasks_status_check
    CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'completed', 'skipped', 'cancelled'))
);
CREATE UNIQUE INDEX uq_loop_tasks_stage_key
  ON public.loop_tasks(stage_id, key);
CREATE INDEX idx_loop_tasks_stage_position
  ON public.loop_tasks(stage_id, position, id);
CREATE INDEX idx_loop_tasks_status
  ON public.loop_tasks(status, updated_at DESC);

CREATE TABLE public.loop_task_dependencies (
  task_id uuid NOT NULL
    CONSTRAINT loop_task_dependencies_task_id_fkey
    REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL
    CONSTRAINT loop_task_dependencies_depends_on_task_id_fkey
    REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  dependency_type text NOT NULL DEFAULT 'hard',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT loop_task_dependencies_not_self_check CHECK (task_id <> depends_on_task_id),
  CONSTRAINT loop_task_dependencies_type_check CHECK (dependency_type IN ('hard', 'soft'))
);
CREATE INDEX idx_loop_task_dependencies_depends_on
  ON public.loop_task_dependencies(depends_on_task_id, task_id);

CREATE TABLE public.loop_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    CONSTRAINT loop_task_runs_task_id_fkey
    REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_task_runs_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT loop_task_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT loop_task_runs_output_check CHECK (jsonb_typeof(output) = 'object'),
  CONSTRAINT loop_task_runs_timestamps_check
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE UNIQUE INDEX uq_loop_task_runs_task_attempt
  ON public.loop_task_runs(task_id, attempt_number);
CREATE INDEX idx_loop_task_runs_task_created
  ON public.loop_task_runs(task_id, created_at DESC);

CREATE TABLE public.loop_task_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    CONSTRAINT loop_task_reviews_task_id_fkey
    REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  task_run_id uuid
    CONSTRAINT loop_task_reviews_task_run_id_fkey
    REFERENCES public.loop_task_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewer text,
  feedback text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_task_reviews_status_check
    CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
  CONSTRAINT loop_task_reviews_decision_check
    CHECK ((status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL))
);
CREATE INDEX idx_loop_task_reviews_task_created
  ON public.loop_task_reviews(task_id, created_at DESC);
CREATE INDEX idx_loop_task_reviews_run
  ON public.loop_task_reviews(task_run_id) WHERE task_run_id IS NOT NULL;

CREATE TABLE public.loop_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    CONSTRAINT loop_evidence_task_id_fkey
    REFERENCES public.loop_tasks(id) ON DELETE CASCADE,
  task_run_id uuid
    CONSTRAINT loop_evidence_task_run_id_fkey
    REFERENCES public.loop_task_runs(id) ON DELETE SET NULL,
  kind text NOT NULL,
  uri text,
  content text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_evidence_kind_check CHECK (btrim(kind) <> ''),
  CONSTRAINT loop_evidence_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT loop_evidence_payload_check
    CHECK (nullif(btrim(uri), '') IS NOT NULL OR nullif(btrim(content), '') IS NOT NULL)
);
CREATE INDEX idx_loop_evidence_task_created
  ON public.loop_evidence(task_id, created_at DESC);
CREATE INDEX idx_loop_evidence_run
  ON public.loop_evidence(task_run_id) WHERE task_run_id IS NOT NULL;

-- Added last because loops and plan revisions intentionally form a nullable cycle.
-- Deferral lets a transaction select a new revision before inserting its row; SET
-- NULL makes revision removal safe without deleting the Loop.
ALTER TABLE public.loops
  ADD CONSTRAINT loops_current_plan_revision_id_fkey
  FOREIGN KEY (current_plan_revision_id)
  REFERENCES public.loop_plan_revisions(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
