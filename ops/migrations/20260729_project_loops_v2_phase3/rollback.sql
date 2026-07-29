-- Guarded rollback for migration 033. Refuses to discard snapshot/runtime data.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.loop_plan_revisions,public.loop_task_runs,public.loop_work_items IN ACCESS EXCLUSIVE MODE;

DO $phase3_rollback_guard$
DECLARE populated bigint;
BEGIN
  SELECT count(*) INTO populated FROM public.loop_task_runs
   WHERE work_item_id IS NOT NULL OR execution_attempt_id IS NOT NULL
      OR run_role <> 'implementation' OR quality_cycle <> 1;
  IF populated <> 0 THEN RAISE EXCEPTION 'Project Loops V2 phase 3 rollback: % runtime runs are populated', populated; END IF;
  SELECT count(*) INTO populated FROM public.loop_plan_revisions
   WHERE content_hash IS NOT NULL OR plan_snapshot IS NOT NULL;
  IF populated <> 0 THEN RAISE EXCEPTION 'Project Loops V2 phase 3 rollback: % revision snapshots are populated', populated; END IF;
  SELECT count(*) INTO populated FROM public.loop_work_items WHERE relation_type='task_execution';
  IF populated <> 0 THEN RAISE EXCEPTION 'Project Loops V2 phase 3 rollback: % task mappings are populated', populated; END IF;
END $phase3_rollback_guard$;

DROP TRIGGER loop_plan_revisions_freeze_approved ON public.loop_plan_revisions;
DROP TRIGGER loop_stages_freeze_approved ON public.loop_stages;
DROP TRIGGER loop_tasks_freeze_approved ON public.loop_tasks;
DROP TRIGGER loop_task_dependencies_freeze_approved ON public.loop_task_dependencies;
DROP FUNCTION public.reject_approved_loop_plan_mutation();
DROP INDEX public.uq_loop_work_items_task_execution_work_item;
DROP INDEX public.uq_loop_task_runs_work_item;
ALTER TABLE public.loop_task_runs
  DROP CONSTRAINT loop_task_runs_work_item_id_fkey,
  DROP CONSTRAINT loop_task_runs_run_role_check,
  DROP CONSTRAINT loop_task_runs_quality_cycle_check,
  DROP CONSTRAINT loop_task_runs_runtime_identity_check,
  DROP COLUMN work_item_id,
  DROP COLUMN execution_attempt_id,
  DROP COLUMN run_role,
  DROP COLUMN quality_cycle;
ALTER TABLE public.loop_plan_revisions
  DROP CONSTRAINT loop_plan_revisions_content_hash_check,
  DROP CONSTRAINT loop_plan_revisions_plan_snapshot_check,
  DROP CONSTRAINT loop_plan_revisions_runtime_snapshot_check,
  DROP COLUMN content_hash,
  DROP COLUMN plan_snapshot;
COMMIT;
