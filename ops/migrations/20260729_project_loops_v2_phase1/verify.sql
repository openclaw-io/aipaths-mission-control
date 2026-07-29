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
    AND c.contype='f' AND c.confdeltype='a'
    AND c.condeferrable AND c.condeferred
    AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (current_plan_revision_id, id)%REFERENCES loop_plan_revisions(id, loop_id)%DEFERRABLE INITIALLY DEFERRED%';
  IF fk_count <> 1 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: current revision FK is not same-Loop, deletion-restricting, and safely deferred';
  END IF;

  SELECT count(*) INTO violations
  FROM pg_constraint c
  WHERE (
      (
        (c.conname='loop_task_reviews_task_run_id_fkey'
          AND c.conrelid='public.loop_task_reviews'::regclass)
        OR (c.conname='loop_evidence_task_run_id_fkey'
          AND c.conrelid='public.loop_evidence'::regclass)
      )
      AND c.contype='f'
      AND c.confrelid='public.loop_task_runs'::regclass
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (task_run_id, task_id)%REFERENCES loop_task_runs(id, task_id)%ON DELETE SET NULL (task_run_id)%'
    )
    OR (c.conname='loops_workflow_state_check'
      AND c.conrelid='public.loops'::regclass AND c.contype='c');
  IF violations <> 3 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: workflow state or task-run ownership constraints are incomplete';
  END IF;

  SELECT count(*) INTO violations
  FROM pg_trigger
  WHERE tgrelid='public.loop_task_dependencies'::regclass
    AND tgname='loop_task_dependencies_validate_graph' AND NOT tgisinternal AND tgenabled <> 'D'
    AND tgfoid=to_regprocedure('public.validate_loop_task_dependency()');
  IF violations <> 1 OR to_regprocedure('public.validate_loop_task_dependency()') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: transactional dependency graph validation is absent';
  END IF;

  SELECT count(*) INTO violations
  FROM pg_trigger trigger_definition
  JOIN (VALUES
    ('public.loop_stages'::regclass, 'loop_stages_immutable_membership', 'plan_revision_id'),
    ('public.loop_tasks'::regclass, 'loop_tasks_immutable_membership', 'stage_id')
  ) AS expected(relation_id, trigger_name, column_name)
    ON expected.relation_id=trigger_definition.tgrelid
   AND expected.trigger_name=trigger_definition.tgname
  JOIN pg_attribute column_definition
    ON column_definition.attrelid=expected.relation_id
   AND column_definition.attname=expected.column_name
  WHERE NOT trigger_definition.tgisinternal
    AND trigger_definition.tgenabled <> 'D'
    AND trigger_definition.tgtype=19
    AND trigger_definition.tgattr::text=column_definition.attnum::text
    AND trigger_definition.tgfoid=to_regprocedure('public.reject_loop_structure_membership_change()');
  IF violations <> 2 OR to_regprocedure('public.reject_loop_structure_membership_change()') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: immutable stage/task structural membership is absent';
  END IF;

  SELECT count(*) INTO violations
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname = ANY(ARRAY[
      'loop_plan_revisions','loop_stages','loop_tasks','loop_task_dependencies',
      'loop_task_runs','loop_task_reviews','loop_evidence'
    ])
    AND c.relrowsecurity
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
    AND NOT has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE');
  IF violations <> 7 THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: RLS or fail-closed table grants are incomplete';
  END IF;

  SELECT
    count(*) FILTER (WHERE
      (p.polcmd='r' AND p.polroles=ARRAY['authenticated'::regrole::oid])
      OR (p.polcmd='*' AND p.polroles=ARRAY['service_role'::regrole::oid])
    ),
    count(*)
  INTO violations, fk_count
  FROM pg_policy p
  WHERE p.polrelid IN (
    'public.loop_plan_revisions'::regclass, 'public.loop_stages'::regclass,
    'public.loop_tasks'::regclass, 'public.loop_task_dependencies'::regclass,
    'public.loop_task_runs'::regclass, 'public.loop_task_reviews'::regclass,
    'public.loop_evidence'::regclass
  );
  IF violations <> 14 OR fk_count <> 14
     OR has_function_privilege('authenticated', 'public.validate_loop_task_dependency()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.validate_loop_task_dependency()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reject_loop_structure_membership_change()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reject_loop_structure_membership_change()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Project Loops V2 phase 1 verification: graph policies or function revokes are incomplete';
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
