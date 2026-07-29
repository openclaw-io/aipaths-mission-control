-- Read-only, drift-loud verification for migration 033.
BEGIN;
SET LOCAL TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '5s';

DO $phase3_verify$
DECLARE violations bigint;
BEGIN
  SELECT count(*) INTO violations FROM information_schema.columns
   WHERE table_schema='public' AND (
     (table_name='loop_plan_revisions' AND column_name IN ('content_hash','plan_snapshot') AND is_nullable='YES')
     OR (table_name='loop_task_runs' AND column_name IN ('work_item_id','execution_attempt_id') AND is_nullable='YES')
     OR (table_name='loop_task_runs' AND column_name='run_role' AND is_nullable='NO' AND column_default LIKE '%implementation%')
     OR (table_name='loop_task_runs' AND column_name='quality_cycle' AND is_nullable='NO' AND column_default LIKE '%1%')
   );
  IF violations <> 6 THEN RAISE EXCEPTION 'Project Loops V2 phase 3: exact runtime columns drifted (%)', violations; END IF;

  SELECT count(*) INTO violations FROM pg_constraint WHERE
    (conrelid='public.loop_plan_revisions'::regclass AND conname IN (
      'loop_plan_revisions_content_hash_check','loop_plan_revisions_plan_snapshot_check','loop_plan_revisions_runtime_snapshot_check'))
    OR (conrelid='public.loop_task_runs'::regclass AND conname IN (
      'loop_task_runs_work_item_id_fkey','loop_task_runs_run_role_check','loop_task_runs_quality_cycle_check','loop_task_runs_runtime_identity_check'));
  IF violations <> 7 THEN RAISE EXCEPTION 'Project Loops V2 phase 3: exact constraints drifted (%)', violations; END IF;

  IF to_regclass('public.uq_loop_task_runs_work_item') IS NULL
    OR to_regclass('public.uq_loop_work_items_task_execution_work_item') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 phase 3: unique runtime mapping indexes absent';
  END IF;
  SELECT count(*) INTO violations FROM pg_trigger WHERE tgrelid IN (
    'public.loop_plan_revisions'::regclass,'public.loop_stages'::regclass,
    'public.loop_tasks'::regclass,'public.loop_task_dependencies'::regclass)
    AND tgname IN ('loop_plan_revisions_freeze_approved','loop_stages_freeze_approved',
      'loop_tasks_freeze_approved','loop_task_dependencies_freeze_approved') AND NOT tgisinternal;
  IF violations <> 4 THEN RAISE EXCEPTION 'Project Loops V2 phase 3: approved-plan freeze triggers drifted (%)', violations; END IF;

  SELECT count(*) INTO violations FROM public.loop_task_runs
   WHERE run_role <> 'implementation' OR quality_cycle <> 1
      OR (work_item_id IS NOT NULL AND execution_attempt_id IS NULL);
  IF violations <> 0 THEN RAISE EXCEPTION 'Project Loops V2 phase 3: invalid runtime rows (%)', violations; END IF;
  SELECT count(*) INTO violations FROM public.loop_plan_revisions
   WHERE (content_hash IS NULL) <> (plan_snapshot IS NULL);
  IF violations <> 0 THEN RAISE EXCEPTION 'Project Loops V2 phase 3: partial revision snapshots (%)', violations; END IF;
END $phase3_verify$;
COMMIT;
