-- Read-only post-migration verification for Project Loops V2 phase 1.
BEGIN;
SET LOCAL TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $phase1_verify$
DECLARE
  missing text[] := ARRAY[]::text[];
  violations bigint;
  fk_count bigint;
BEGIN
  IF to_regclass('public.loops') IS NULL THEN missing := array_append(missing, 'loops'); END IF;
  IF to_regclass('public.loop_plan_revisions') IS NULL THEN missing := array_append(missing, 'loop_plan_revisions'); END IF;
  IF to_regclass('public.loop_stages') IS NULL THEN missing := array_append(missing, 'loop_stages'); END IF;
  IF to_regclass('public.loop_tasks') IS NULL THEN missing := array_append(missing, 'loop_tasks'); END IF;
  IF to_regclass('public.loop_task_dependencies') IS NULL THEN missing := array_append(missing, 'loop_task_dependencies'); END IF;
  IF to_regclass('public.loop_task_runs') IS NULL THEN missing := array_append(missing, 'loop_task_runs'); END IF;
  IF to_regclass('public.loop_task_reviews') IS NULL THEN missing := array_append(missing, 'loop_task_reviews'); END IF;
  IF to_regclass('public.loop_evidence') IS NULL THEN missing := array_append(missing, 'loop_evidence'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: missing relations: %', array_to_string(missing, ', ');
  END IF;

  SELECT count(*) INTO violations
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='loops'
    AND ((column_name='workflow_version' AND (is_nullable<>'NO' OR column_default NOT LIKE '%1%'))
      OR (column_name='mode' AND (is_nullable<>'NO' OR column_default NOT LIKE '%linear%'))
      OR (column_name='current_plan_revision_id' AND is_nullable<>'YES')
      OR (column_name='row_version' AND (is_nullable<>'NO' OR column_default NOT LIKE '%1%')));
  IF violations <> 0 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: % Loop column contracts are invalid', violations;
  END IF;
  SELECT count(*) INTO violations
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='loops'
    AND column_name IN ('workflow_version','mode','current_plan_revision_id','row_version');
  IF violations <> 4 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: expected 4 Loop foundation columns, found %', violations;
  END IF;

  SELECT count(*) INTO fk_count
  FROM pg_constraint c
  WHERE c.conname='loops_current_plan_revision_id_fkey'
    AND c.conrelid='public.loops'::regclass
    AND c.confrelid='public.loop_plan_revisions'::regclass
    AND c.contype='f' AND c.confdeltype='n'
    AND c.condeferrable AND c.condeferred;
  IF fk_count <> 1 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: nullable current revision FK is not safely deferred';
  END IF;

  SELECT count(*) INTO violations
  FROM public.loops
  WHERE workflow_version <> 1 OR mode <> 'linear'
     OR current_plan_revision_id IS NOT NULL OR row_version <> 1;
  IF violations <> 0 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: % existing Loops were activated or changed from additive defaults', violations;
  END IF;

  SELECT
    (SELECT count(*) FROM public.loop_plan_revisions)
    + (SELECT count(*) FROM public.loop_stages)
    + (SELECT count(*) FROM public.loop_tasks)
    + (SELECT count(*) FROM public.loop_task_dependencies)
    + (SELECT count(*) FROM public.loop_task_runs)
    + (SELECT count(*) FROM public.loop_task_reviews)
    + (SELECT count(*) FROM public.loop_evidence)
  INTO violations;
  IF violations <> 0 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: normalized tables contain % rows although runtime V2 is disabled', violations;
  END IF;
END $phase1_verify$;

SELECT
  count(*) AS loop_count,
  count(*) FILTER (WHERE workflow_version=1 AND mode='linear' AND current_plan_revision_id IS NULL) AS untouched_v1_count
FROM public.loops;
COMMIT;
