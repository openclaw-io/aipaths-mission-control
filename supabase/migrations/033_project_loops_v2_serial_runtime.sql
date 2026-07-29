-- Project Loops V2 phase 3: immutable approved snapshots and serial work-item runtime.
-- Manual migration only. Existing V2 foundation rows remain legacy-compatible (nullable snapshots/attempt IDs).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.loop_plan_revisions
  ADD COLUMN content_hash text,
  ADD COLUMN plan_snapshot jsonb,
  ADD CONSTRAINT loop_plan_revisions_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT loop_plan_revisions_plan_snapshot_check
    CHECK (plan_snapshot IS NULL OR jsonb_typeof(plan_snapshot) = 'object'),
  ADD CONSTRAINT loop_plan_revisions_runtime_snapshot_check
    CHECK ((content_hash IS NULL) = (plan_snapshot IS NULL));

ALTER TABLE public.loop_task_runs
  ADD COLUMN work_item_id uuid,
  ADD COLUMN execution_attempt_id uuid,
  ADD COLUMN run_role text NOT NULL DEFAULT 'implementation',
  ADD COLUMN quality_cycle integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT loop_task_runs_work_item_id_fkey
    FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE RESTRICT,
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation')),
  ADD CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle > 0),
  ADD CONSTRAINT loop_task_runs_runtime_identity_check
    CHECK (work_item_id IS NULL OR execution_attempt_id IS NOT NULL);

CREATE UNIQUE INDEX uq_loop_task_runs_work_item
  ON public.loop_task_runs(work_item_id)
  WHERE work_item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_loop_work_items_task_execution_work_item
  ON public.loop_work_items(work_item_id)
  WHERE relation_type = 'task_execution';

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
    SELECT s.plan_revision_id INTO revision_id
      FROM public.loop_stages s WHERE s.id = CASE WHEN TG_OP='DELETE' THEN OLD.stage_id ELSE NEW.stage_id END;
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

CREATE TRIGGER loop_plan_revisions_freeze_approved
BEFORE INSERT OR UPDATE OR DELETE ON public.loop_plan_revisions
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
CREATE TRIGGER loop_stages_freeze_approved
BEFORE INSERT OR UPDATE OR DELETE ON public.loop_stages
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
CREATE TRIGGER loop_tasks_freeze_approved
BEFORE INSERT OR UPDATE OR DELETE ON public.loop_tasks
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();
CREATE TRIGGER loop_task_dependencies_freeze_approved
BEFORE INSERT OR UPDATE OR DELETE ON public.loop_task_dependencies
FOR EACH ROW EXECUTE FUNCTION public.reject_approved_loop_plan_mutation();

COMMIT;
