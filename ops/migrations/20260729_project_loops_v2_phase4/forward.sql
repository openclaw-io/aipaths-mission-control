-- Project Loops V2 phase 4: strongly isolated fresh reviewer and bounded quality cycles.
-- Cloud parity artifact only; production rollout is local Postgres.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE public.review_repositories (
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

ALTER TABLE public.loop_task_runs
  ADD COLUMN server_session_id text,
  ADD COLUMN artifact_sha text,
  ADD COLUMN target_run_id uuid,
  ADD COLUMN target_sha text,
  ADD COLUMN repository_id uuid REFERENCES public.review_repositories(id) ON DELETE RESTRICT,
  ADD COLUMN base_sha text;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_quality_cycle_check;
ALTER TABLE public.loop_task_runs
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation', 'review')),
  ADD CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle BETWEEN 1 AND 3),
  ADD CONSTRAINT loop_task_runs_artifact_sha_check CHECK (artifact_sha IS NULL OR artifact_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_target_sha_check CHECK (target_sha IS NULL OR target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_base_sha_check CHECK (base_sha IS NULL OR base_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_runs_role_target_check CHECK (
    (run_role='implementation' AND target_run_id IS NULL AND target_sha IS NULL)
    OR (run_role='review' AND target_run_id IS NOT NULL AND target_sha IS NOT NULL)
  ),
  ADD CONSTRAINT loop_task_runs_target_same_task_fkey
    FOREIGN KEY (target_run_id,task_id) REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX uq_loop_task_runs_task_cycle_role ON public.loop_task_runs(task_id,quality_cycle,run_role);

ALTER TABLE public.loop_task_reviews
  ADD COLUMN review_run_id uuid,
  ADD COLUMN quality_cycle integer,
  ADD COLUMN reviewed_sha text,
  ADD COLUMN reviewer_session_id text,
  ADD COLUMN findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN decision_id uuid;
-- Phase 3 reviews predate artifact columns. Their exact implementation SHA is
-- recoverable from the server-owned run output after preflight has validated it.
UPDATE public.loop_task_reviews AS decision
SET reviewed_sha = run.output->>'head_sha'
FROM public.loop_task_runs AS run
JOIN public.loop_tasks AS task ON task.id=run.task_id
JOIN public.loop_stages AS stage ON stage.id=task.stage_id
JOIN public.loop_plan_revisions AS revision ON revision.id=stage.plan_revision_id
JOIN public.loops AS loop ON loop.id=revision.loop_id
WHERE decision.task_run_id=run.id AND decision.task_id=run.task_id
  AND loop.workflow_version=2;
-- Legacy V1 reviews have no fresh-review identity. A reserved valid-format
-- marker keeps the new column total while the compatibility branch below
-- continues to enforce the original Phase 2 decision semantics.
UPDATE public.loop_task_reviews AS decision
SET reviewed_sha=COALESCE((
  SELECT run.output->>'head_sha' FROM public.loop_task_runs AS run
  WHERE run.id=decision.task_run_id AND run.task_id=decision.task_id
    AND run.output->>'head_sha' ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
),repeat('0',40))
WHERE reviewed_sha IS NULL;
ALTER TABLE public.loop_task_reviews ALTER COLUMN reviewed_sha SET NOT NULL;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT loop_task_reviews_decision_check;
ALTER TABLE public.loop_task_reviews
  ADD CONSTRAINT loop_task_reviews_quality_cycle_check CHECK (quality_cycle BETWEEN 1 AND 3),
  ADD CONSTRAINT loop_task_reviews_reviewed_sha_check CHECK (reviewed_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT loop_task_reviews_findings_check CHECK (jsonb_typeof(findings)='array'),
  ADD CONSTRAINT loop_task_reviews_review_run_same_task_fkey
    FOREIGN KEY (review_run_id,task_id) REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  ADD CONSTRAINT loop_task_reviews_decision_check CHECK (
    (review_run_id IS NULL AND quality_cycle IS NULL
      AND ((status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)))
    OR (review_run_id IS NOT NULL AND quality_cycle IS NOT NULL
      AND ((status='pending' AND decided_at IS NULL AND reviewer_session_id IS NULL AND decision_id IS NULL)
        OR (status<>'pending' AND decided_at IS NOT NULL AND reviewer IS NOT NULL
          AND reviewer_session_id IS NOT NULL AND decision_id IS NOT NULL)))
  );
CREATE UNIQUE INDEX uq_loop_task_reviews_task_cycle ON public.loop_task_reviews(task_id,quality_cycle) WHERE quality_cycle IS NOT NULL;
CREATE UNIQUE INDEX uq_loop_task_reviews_review_run ON public.loop_task_reviews(review_run_id) WHERE review_run_id IS NOT NULL;

CREATE TABLE public.reviewer_executions (
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
  capability_consumed_at timestamptz,
  capability_revoked_at timestamptz,
  reviewer_session_id text,
  pid integer CHECK (pid IS NULL OR pid > 0),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviewer_executions_capability_state_check CHECK (capability_consumed_at IS NULL OR capability_revoked_at IS NULL),
  CONSTRAINT reviewer_executions_terminal_check CHECK (
    (status='running' AND finished_at IS NULL AND result IS NULL AND error IS NULL AND capability_consumed_at IS NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND result IS NOT NULL AND error IS NULL AND capability_consumed_at IS NOT NULL AND reviewer_session_id IS NOT NULL)
    OR (status IN ('failed','cancelled','blocked') AND finished_at IS NOT NULL AND error IS NOT NULL AND capability_revoked_at IS NOT NULL)
  )
);
CREATE INDEX idx_reviewer_executions_stale ON public.reviewer_executions(heartbeat_at) WHERE status='running';
REVOKE ALL ON public.reviewer_executions FROM PUBLIC;

ALTER TABLE public.loop_tasks DROP CONSTRAINT loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check
  CHECK (status IN ('pending','ready','in_progress','review_pending','rework_required','blocked','completed','skipped','cancelled'));
CREATE UNIQUE INDEX uq_work_items_loop_active ON public.work_items(loop_id)
  WHERE loop_id IS NOT NULL AND source_type='loop' AND status IN ('ready','in_progress');

CREATE FUNCTION public.validate_loop_quality_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
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
    IF phase4 AND (NEW.repository_id IS NULL OR NEW.base_sha IS NULL) THEN RAISE EXCEPTION 'Phase 4 run requires registered repository and base SHA' USING ERRCODE='23514'; END IF;
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
END $body$;
REVOKE ALL ON FUNCTION public.validate_loop_quality_integrity() FROM PUBLIC;
CREATE TRIGGER loop_task_runs_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();
CREATE TRIGGER loop_task_reviews_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();

CREATE FUNCTION public.reject_terminal_loop_quality_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' AND OLD.status IN ('succeeded','failed','cancelled') AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task run is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='loop_task_reviews' THEN
    IF TG_OP='DELETE' AND OLD.status='pending' THEN RAISE EXCEPTION 'Pending Loop task review cannot be deleted' USING ERRCODE='23514';
    ELSIF OLD.status<>'pending' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task review is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='reviewer_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal reviewer execution is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION public.reject_terminal_loop_quality_mutation() FROM PUBLIC;
CREATE TRIGGER loop_task_runs_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
CREATE TRIGGER loop_task_reviews_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
CREATE TRIGGER reviewer_executions_terminal_immutable BEFORE UPDATE OR DELETE ON public.reviewer_executions FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
COMMIT;
