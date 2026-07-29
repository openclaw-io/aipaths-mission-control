BEGIN;
SET TRANSACTION READ ONLY;
DO $$
DECLARE missing text;
DECLARE active_index text;
BEGIN
  SELECT string_agg(name,', ') INTO missing FROM (VALUES
    ('review_repositories', to_regclass('public.review_repositories') IS NOT NULL),
    ('loop_task_runs.server_session_id', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_task_runs' AND column_name='server_session_id')),
    ('loop_task_runs.artifact_sha', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_task_runs' AND column_name='artifact_sha')),
    ('loop_task_reviews.review_run_id', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_task_reviews' AND column_name='review_run_id')),
    ('uq_work_items_loop_active', to_regclass('public.uq_work_items_loop_active') IS NOT NULL),
    ('uq_loop_task_runs_task_cycle_role', to_regclass('public.uq_loop_task_runs_task_cycle_role') IS NOT NULL),
    ('validate_loop_quality_integrity', to_regprocedure('public.validate_loop_quality_integrity()') IS NOT NULL),
    ('reject_terminal_loop_quality_mutation', to_regprocedure('public.reject_terminal_loop_quality_mutation()') IS NOT NULL)
  ) AS checks(name,present) WHERE NOT present;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Phase 4 verification missing: %',missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.review_repositories WHERE enabled) THEN
    RAISE EXCEPTION 'Phase 4 enablement requires at least one explicitly enabled review repository';
  END IF;
  SELECT pg_get_indexdef('public.uq_work_items_loop_active'::regclass) INTO active_index;
  IF active_index NOT LIKE '%source_type = ''loop''%' OR active_index LIKE '%payload%' THEN
    RAISE EXCEPTION 'Phase 4 active uniqueness predicate is not robust';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_task_runs_run_role_check' AND pg_get_constraintdef(oid) LIKE '%review%') THEN RAISE EXCEPTION 'review run role constraint missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_tasks_status_check' AND pg_get_constraintdef(oid) LIKE '%review_pending%' AND pg_get_constraintdef(oid) LIKE '%rework_required%') THEN RAISE EXCEPTION 'phase 4 task statuses missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_runs rr LEFT JOIN public.loop_task_runs impl ON impl.id=rr.target_run_id
    WHERE rr.run_role='review' AND (impl.id IS NULL OR impl.task_id<>rr.task_id OR impl.run_role<>'implementation'
      OR impl.quality_cycle<>rr.quality_cycle OR impl.status<>'succeeded' OR impl.artifact_sha<>rr.target_sha
      OR (rr.status='succeeded' AND (rr.server_session_id IS NULL OR impl.server_session_id IS NULL OR rr.server_session_id=impl.server_session_id)))
  ) THEN RAISE EXCEPTION 'Phase 4 review run integrity verification failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_task_reviews d
    JOIN public.loop_task_runs impl ON impl.id=d.task_run_id
    JOIN public.loop_task_runs rr ON rr.id=d.review_run_id
    WHERE d.review_run_id IS NOT NULL AND (impl.task_id<>d.task_id OR rr.task_id<>d.task_id OR impl.run_role<>'implementation'
      OR rr.run_role<>'review' OR impl.quality_cycle<>d.quality_cycle OR rr.quality_cycle<>d.quality_cycle
      OR rr.target_run_id<>impl.id OR d.reviewed_sha<>impl.artifact_sha OR rr.target_sha<>impl.artifact_sha
      OR (d.status='pending' AND (rr.status NOT IN ('queued','running') OR d.reviewer_session_id IS NOT NULL
        OR d.decision_id IS NOT NULL OR d.decided_at IS NOT NULL))
      OR (d.status IN ('approved','changes_requested') AND (rr.status<>'succeeded'
        OR d.reviewer_session_id IS DISTINCT FROM rr.server_session_id
        OR d.reviewer_session_id=impl.server_session_id OR d.decision_id IS NULL))
      OR (d.status='rejected' AND rr.status NOT IN ('failed','cancelled')))
  ) THEN RAISE EXCEPTION 'Phase 4 review decision integrity verification failed'; END IF;
END $$;
COMMIT;
