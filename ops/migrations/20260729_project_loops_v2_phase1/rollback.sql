-- Reversible rollback for migration 032 while the V2 runtime remains disabled.
-- Refuses to discard V2 rows or non-default Loop V2 state.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The guard and destructive DDL share one lock window: no writer can add V2
-- state after it has been counted but before it is dropped.
LOCK TABLE
  public.loops,
  public.loop_plan_revisions,
  public.loop_stages,
  public.loop_tasks,
  public.loop_task_dependencies,
  public.loop_task_runs,
  public.loop_task_reviews,
  public.loop_evidence
IN ACCESS EXCLUSIVE MODE;

DO $phase1_rollback_guard$
DECLARE
  relation_name text;
  populated bigint;
BEGIN
  IF to_regclass('public.loops') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 rollback: public.loops is absent';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'loop_evidence',
    'loop_task_reviews',
    'loop_task_runs',
    'loop_task_dependencies',
    'loop_tasks',
    'loop_stages',
    'loop_plan_revisions'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'Project Loops V2 phase 1 rollback: public.% is absent; catalog is partial', relation_name;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', relation_name) INTO populated;
    IF populated <> 0 THEN
      RAISE EXCEPTION 'Project Loops V2 phase 1 rollback: public.% contains % rows; refusing destructive rollback', relation_name, populated;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='loops'
      AND column_name IN ('workflow_version', 'mode', 'current_plan_revision_id', 'row_version')
    GROUP BY table_schema, table_name HAVING count(*)=4
  ) THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 rollback: Loop columns are partial or absent';
  END IF;

  SELECT count(*) INTO populated
  FROM public.loops
  WHERE workflow_version <> 1
     OR mode <> 'linear'
     OR current_plan_revision_id IS NOT NULL
     OR row_version <> 1;
  IF populated <> 0 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 rollback: % Loops have non-default V2 state; refusing destructive rollback', populated;
  END IF;
END $phase1_rollback_guard$;

ALTER TABLE public.loops DROP CONSTRAINT loops_current_plan_revision_id_fkey;
DROP TABLE public.loop_evidence;
DROP TABLE public.loop_task_reviews;
DROP TABLE public.loop_task_runs;
DROP TABLE public.loop_task_dependencies;
DROP TABLE public.loop_tasks;
DROP TABLE public.loop_stages;
DROP TABLE public.loop_plan_revisions;
DROP FUNCTION public.validate_loop_task_dependency();
DROP FUNCTION public.reject_loop_structure_membership_change();

ALTER TABLE public.loops
  DROP COLUMN current_plan_revision_id,
  DROP COLUMN workflow_version,
  DROP COLUMN mode,
  DROP COLUMN row_version;

COMMIT;
