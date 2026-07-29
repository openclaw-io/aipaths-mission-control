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
  ADD CONSTRAINT loops_row_version_check CHECK (row_version > 0),
  ADD CONSTRAINT loops_workflow_state_check CHECK (
    (workflow_version = 1 AND mode = 'linear' AND current_plan_revision_id IS NULL)
    OR (workflow_version = 2 AND current_plan_revision_id IS NOT NULL)
  );

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
  CONSTRAINT loop_plan_revisions_id_loop_id_key UNIQUE (id, loop_id),
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

-- Structural ownership is write-once. Dependency validation can therefore rely
-- on task -> stage -> revision membership never changing after an edge passes
-- validation. No advisory lock is needed here: a move is rejected before it can
-- read or mutate graph state, including while an edge insert is in flight.
CREATE FUNCTION public.reject_loop_structure_membership_change()
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
REVOKE ALL ON FUNCTION public.reject_loop_structure_membership_change() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER loop_stages_immutable_membership
BEFORE UPDATE OF plan_revision_id
ON public.loop_stages
FOR EACH ROW EXECUTE FUNCTION public.reject_loop_structure_membership_change();

CREATE TRIGGER loop_tasks_immutable_membership
BEFORE UPDATE OF stage_id
ON public.loop_tasks
FOR EACH ROW EXECUTE FUNCTION public.reject_loop_structure_membership_change();

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

CREATE FUNCTION public.validate_loop_task_dependency()
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

  -- Missing endpoints are rejected by the ordinary FKs. Once both exist, an
  -- edge is only meaningful inside one immutable plan revision.
  IF task_revision IS NULL OR dependency_revision IS NULL THEN
    RETURN NEW;
  END IF;
  IF task_revision <> dependency_revision THEN
    RAISE EXCEPTION 'Loop task dependency endpoints must belong to the same plan revision'
      USING ERRCODE = '23514';
  END IF;

  -- Serialize graph mutations per revision. This closes the concurrent
  -- A->B/B->A write-skew hole while allowing unrelated revisions in parallel.
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
    RAISE EXCEPTION 'Loop task dependency would create a cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$validate_loop_task_dependency$;
REVOKE ALL ON FUNCTION public.validate_loop_task_dependency() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER loop_task_dependencies_validate_graph
BEFORE INSERT OR UPDATE OF task_id, depends_on_task_id
ON public.loop_task_dependencies
FOR EACH ROW EXECUTE FUNCTION public.validate_loop_task_dependency();

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
  CONSTRAINT loop_task_runs_id_task_id_key UNIQUE (id, task_id),
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
  task_run_id uuid,
  status text NOT NULL DEFAULT 'pending',
  reviewer text,
  feedback text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_task_reviews_status_check
    CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
  CONSTRAINT loop_task_reviews_decision_check
    CHECK ((status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL)),
  CONSTRAINT loop_task_reviews_task_run_id_fkey
    FOREIGN KEY (task_run_id, task_id)
    REFERENCES public.loop_task_runs(id, task_id)
    ON DELETE SET NULL (task_run_id)
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
  task_run_id uuid,
  kind text NOT NULL,
  uri text,
  content text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_evidence_kind_check CHECK (btrim(kind) <> ''),
  CONSTRAINT loop_evidence_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT loop_evidence_payload_check
    CHECK (nullif(btrim(uri), '') IS NOT NULL OR nullif(btrim(content), '') IS NOT NULL),
  CONSTRAINT loop_evidence_task_run_id_fkey
    FOREIGN KEY (task_run_id, task_id)
    REFERENCES public.loop_task_runs(id, task_id)
    ON DELETE SET NULL (task_run_id)
);
CREATE INDEX idx_loop_evidence_task_created
  ON public.loop_evidence(task_id, created_at DESC);
CREATE INDEX idx_loop_evidence_run
  ON public.loop_evidence(task_run_id) WHERE task_run_id IS NOT NULL;

-- Added last because loops and plan revisions intentionally form a nullable cycle.
-- Deferral lets a transaction select a new revision before inserting its row.
-- Deleting a selected V2 revision is restricted: SET NULL would contradict the
-- workflow-state check that requires every V2 Loop to select a current revision.
ALTER TABLE public.loops
  ADD CONSTRAINT loops_current_plan_revision_id_fkey
  FOREIGN KEY (current_plan_revision_id, id)
  REFERENCES public.loop_plan_revisions(id, loop_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Cloud access follows the repo's read-for-authenticated/write-for-service
-- convention. Explicit revokes make a future default-privilege change fail
-- closed instead of silently exposing mutable V2 graph state.
ALTER TABLE public.loop_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_task_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.loop_plan_revisions, public.loop_stages, public.loop_tasks,
  public.loop_task_dependencies, public.loop_task_runs,
  public.loop_task_reviews, public.loop_evidence
FROM anon, authenticated;
GRANT SELECT ON TABLE
  public.loop_plan_revisions, public.loop_stages, public.loop_tasks,
  public.loop_task_dependencies, public.loop_task_runs,
  public.loop_task_reviews, public.loop_evidence
TO authenticated;
GRANT ALL PRIVILEGES ON TABLE
  public.loop_plan_revisions, public.loop_stages, public.loop_tasks,
  public.loop_task_dependencies, public.loop_task_runs,
  public.loop_task_reviews, public.loop_evidence
TO service_role;

CREATE POLICY "loop_plan_revisions authenticated read" ON public.loop_plan_revisions FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_plan_revisions service all" ON public.loop_plan_revisions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_stages authenticated read" ON public.loop_stages FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_stages service all" ON public.loop_stages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_tasks authenticated read" ON public.loop_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_tasks service all" ON public.loop_tasks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_task_dependencies authenticated read" ON public.loop_task_dependencies FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_task_dependencies service all" ON public.loop_task_dependencies FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_task_runs authenticated read" ON public.loop_task_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_task_runs service all" ON public.loop_task_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_task_reviews authenticated read" ON public.loop_task_reviews FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_task_reviews service all" ON public.loop_task_reviews FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "loop_evidence authenticated read" ON public.loop_evidence FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_evidence service all" ON public.loop_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
