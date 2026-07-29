-- Phase 4 preflight (local Postgres only). Phase 3 execution must drain first.
-- Historical V2 reviews are accepted only when reviewed_sha can be backfilled
-- exactly from their server-owned implementation run output.
BEGIN;
SET TRANSACTION READ ONLY;
DO $$
BEGIN
  IF to_regclass('public.loop_task_runs') IS NULL OR to_regclass('public.loop_task_reviews') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 foundation is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_task_runs' AND column_name='server_session_id') THEN
    RAISE EXCEPTION 'Phase 4 already appears installed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loops WHERE workflow_version=2 AND status NOT IN ('completed','cancelled')) THEN
    RAISE EXCEPTION 'Phase 3 V2 work must drain before Phase 4 forward migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_runs r JOIN public.loop_tasks t ON t.id=r.task_id
    JOIN public.loop_stages s ON s.id=t.stage_id JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id
    JOIN public.loops l ON l.id=p.loop_id
    WHERE l.workflow_version=2 AND r.status IN ('queued','running')
  ) THEN RAISE EXCEPTION 'Active V2 runs must drain before Phase 4'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_runs
    WHERE quality_cycle NOT BETWEEN 1 AND 3
  ) THEN RAISE EXCEPTION 'Global loop_task_runs quality_cycle outside Phase 4 range 1..3'; END IF;
  IF EXISTS (SELECT 1 FROM public.loops WHERE workflow_version=2 AND status='in_review') THEN
    RAISE EXCEPTION 'V2 in_review Loop lacks fresh-review history and cannot be migrated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_reviews decision
    JOIN public.loop_tasks task ON task.id=decision.task_id
    JOIN public.loop_stages stage ON stage.id=task.stage_id
    JOIN public.loop_plan_revisions revision ON revision.id=stage.plan_revision_id
    JOIN public.loops loop ON loop.id=revision.loop_id
    LEFT JOIN public.loop_task_runs run ON run.id=decision.task_run_id AND run.task_id=decision.task_id
    WHERE loop.workflow_version=2 AND (
      run.id IS NULL OR run.run_role<>'implementation'
      OR run.output->>'head_sha' IS NULL
      OR run.output->>'head_sha' !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
    )
  ) THEN RAISE EXCEPTION 'Historical V2 review lacks an exact backfillable implementation SHA'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_runs
    GROUP BY task_id,quality_cycle,run_role HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'Global technical retries are incompatible with Phase 4 minimum uniqueness'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.work_items WHERE loop_id IS NOT NULL AND source_type='loop'
      AND status IN ('ready','in_progress') GROUP BY loop_id HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'Multiple active Loop work items violate Phase 4 serial execution'; END IF;
END $$;
COMMIT;
