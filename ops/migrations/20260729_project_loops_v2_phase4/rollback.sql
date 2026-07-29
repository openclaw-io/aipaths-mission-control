BEGIN;
SET LOCAL lock_timeout='5s';
-- Locks precede the guard so no Phase 4 row can race the decision.
LOCK TABLE public.work_items, public.loop_task_runs, public.loop_task_reviews, public.loop_tasks,
  public.reviewer_executions, public.review_repositories IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_task_runs' AND column_name='server_session_id') THEN
    RAISE EXCEPTION 'Phase 4 rollback refused: expected Phase 4 schema is absent';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_items WHERE payload->>'runtime_contract'='fresh_review_v1')
     OR EXISTS (SELECT 1 FROM public.loop_task_runs WHERE run_role='review' OR server_session_id IS NOT NULL OR artifact_sha IS NOT NULL OR target_run_id IS NOT NULL OR target_sha IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.loop_task_reviews WHERE review_run_id IS NOT NULL OR quality_cycle IS NOT NULL OR reviewer_session_id IS NOT NULL OR decision_id IS NOT NULL OR findings<>'[]'::jsonb)
     OR EXISTS (SELECT 1 FROM public.loop_tasks WHERE status IN ('review_pending','rework_required'))
     OR EXISTS (SELECT 1 FROM public.reviewer_executions) THEN
    RAISE EXCEPTION 'Phase 4 rollback refused: Phase 4 rows/findings/statuses exist';
  END IF;
  IF to_regclass('public.uq_work_items_loop_active') IS NULL
     OR to_regclass('public.uq_loop_task_runs_task_cycle_role') IS NULL
     OR to_regclass('public.uq_loop_task_reviews_review_run') IS NULL THEN
    RAISE EXCEPTION 'Phase 4 rollback refused: expected Phase 4 indexes are inconsistent';
  END IF;
END $$;
DROP TRIGGER IF EXISTS loop_task_runs_quality_integrity ON public.loop_task_runs;
DROP TRIGGER IF EXISTS loop_task_reviews_quality_integrity ON public.loop_task_reviews;
DROP FUNCTION IF EXISTS public.validate_loop_quality_integrity();
DROP TRIGGER IF EXISTS loop_task_runs_terminal_immutable ON public.loop_task_runs;
DROP TRIGGER IF EXISTS loop_task_reviews_terminal_immutable ON public.loop_task_reviews;
DROP TRIGGER IF EXISTS reviewer_executions_terminal_immutable ON public.reviewer_executions;
DROP FUNCTION IF EXISTS public.reject_terminal_loop_quality_mutation();
DROP INDEX IF EXISTS public.uq_work_items_loop_active;
DROP INDEX IF EXISTS public.uq_loop_task_runs_task_cycle_role;
DROP INDEX IF EXISTS public.uq_loop_task_reviews_review_run;
DROP INDEX IF EXISTS public.uq_loop_task_reviews_task_cycle;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_review_run_same_task_fkey;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_quality_cycle_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_reviewed_sha_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_findings_check;
ALTER TABLE public.loop_task_reviews DROP CONSTRAINT IF EXISTS loop_task_reviews_decision_check;
ALTER TABLE public.loop_task_reviews DROP COLUMN IF EXISTS review_run_id, DROP COLUMN IF EXISTS quality_cycle, DROP COLUMN IF EXISTS reviewed_sha, DROP COLUMN IF EXISTS reviewer_session_id, DROP COLUMN IF EXISTS findings, DROP COLUMN IF EXISTS decision_id;
ALTER TABLE public.loop_task_reviews ADD CONSTRAINT loop_task_reviews_decision_check CHECK ((status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL));
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_target_same_task_fkey;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_role_target_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_artifact_sha_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_target_sha_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT IF EXISTS loop_task_runs_quality_cycle_check;
DROP TABLE IF EXISTS public.reviewer_executions;
ALTER TABLE public.loop_task_runs DROP COLUMN IF EXISTS server_session_id, DROP COLUMN IF EXISTS artifact_sha, DROP COLUMN IF EXISTS target_run_id, DROP COLUMN IF EXISTS target_sha, DROP COLUMN IF EXISTS repository_id, DROP COLUMN IF EXISTS base_sha;
DROP TABLE IF EXISTS public.review_repositories;
ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation'));
ALTER TABLE public.loop_task_runs ADD CONSTRAINT loop_task_runs_quality_cycle_check CHECK (quality_cycle > 0);
ALTER TABLE public.loop_tasks DROP CONSTRAINT IF EXISTS loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check CHECK (status IN ('pending','ready','in_progress','blocked','completed','skipped','cancelled'));
COMMIT;
