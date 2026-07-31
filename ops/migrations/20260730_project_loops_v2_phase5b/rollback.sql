BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
LOCK TABLE public.work_items,public.loop_events,public.loop_task_runs,public.loop_task_reviews,public.loop_tasks,
  public.qa_executions,public.qa_authority_secrets,public.qa_work_item_transition_authorities IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF to_regclass('public.qa_executions') IS NULL THEN
    RAISE EXCEPTION 'Phase 5B rollback refused: expected schema is absent';
  END IF;
  IF EXISTS (SELECT 1 FROM public.qa_executions)
    OR EXISTS (SELECT 1 FROM public.qa_work_item_transition_authorities)
    OR EXISTS (SELECT 1 FROM public.loop_task_runs WHERE run_role='qa')
    OR EXISTS (SELECT 1 FROM public.work_items WHERE payload->>'runtime_contract'='visual_qa_v1' OR payload->>'run_role'='qa')
    OR EXISTS (SELECT 1 FROM public.loop_tasks WHERE status='qa_pending')
    OR EXISTS (SELECT 1 FROM public.loop_events WHERE event_type LIKE '%qa%' OR payload ? 'qa_run_id' OR payload ? 'qa_execution_id') THEN
    RAISE EXCEPTION 'Phase 5B rollback refused: QA rows/work/status/events exist';
  END IF;
END $guard$;

-- Remove externally callable authority entry points before their private helpers/tables.
DROP FUNCTION public.claim_visual_qa_execution(jsonb,text,text);
DROP FUNCTION public.heartbeat_visual_qa_execution(uuid,text);
DROP FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz);
DROP FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz);
DROP TRIGGER IF EXISTS visual_qa_work_items_guard ON public.work_items;
DROP FUNCTION IF EXISTS public.guard_visual_qa_work_item();
DROP FUNCTION IF EXISTS public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text);
DROP TABLE public.qa_work_item_transition_authorities;
DROP TRIGGER IF EXISTS qa_executions_terminal_immutable ON public.qa_executions;
DROP TRIGGER IF EXISTS qa_executions_integrity ON public.qa_executions;
DROP FUNCTION IF EXISTS public.validate_qa_execution_integrity();
DROP TABLE public.qa_executions;
DROP FUNCTION public.install_qa_authority_hmac_key(text);
DROP TABLE public.qa_authority_secrets;

ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_role_target_check;
ALTER TABLE public.loop_task_runs
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation', 'review')),
  ADD CONSTRAINT loop_task_runs_role_target_check CHECK (
    (run_role='implementation' AND target_run_id IS NULL AND target_sha IS NULL)
    OR (run_role='review' AND target_run_id IS NOT NULL AND target_sha IS NOT NULL)
  );
ALTER TABLE public.loop_tasks DROP CONSTRAINT loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check
  CHECK (status IN ('pending','ready','in_progress','review_pending','rework_required','blocked','completed','skipped','cancelled'));

-- Restore the exact Phase 4 quality-integrity function and triggers.
DROP TRIGGER IF EXISTS loop_task_runs_quality_integrity ON public.loop_task_runs;
DROP TRIGGER IF EXISTS loop_task_reviews_quality_integrity ON public.loop_task_reviews;
CREATE OR REPLACE FUNCTION public.validate_loop_quality_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $phase4_quality$
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
END $phase4_quality$;
REVOKE ALL ON FUNCTION public.validate_loop_quality_integrity() FROM PUBLIC;
CREATE TRIGGER loop_task_runs_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();
CREATE TRIGGER loop_task_reviews_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();

-- Restore the exact Phase 4 terminal-immutability function and triggers.
DROP TRIGGER IF EXISTS loop_task_runs_terminal_immutable ON public.loop_task_runs;
DROP TRIGGER IF EXISTS loop_task_reviews_terminal_immutable ON public.loop_task_reviews;
DROP TRIGGER IF EXISTS reviewer_executions_terminal_immutable ON public.reviewer_executions;
CREATE OR REPLACE FUNCTION public.reject_terminal_loop_quality_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $phase4_terminal$
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' AND OLD.status IN ('succeeded','failed','cancelled') AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task run is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='loop_task_reviews' THEN
    IF TG_OP='DELETE' AND OLD.status='pending' THEN RAISE EXCEPTION 'Pending Loop task review cannot be deleted' USING ERRCODE='23514';
    ELSIF OLD.status<>'pending' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task review is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='reviewer_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal reviewer execution is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $phase4_terminal$;
REVOKE ALL ON FUNCTION public.reject_terminal_loop_quality_mutation() FROM PUBLIC;
CREATE TRIGGER loop_task_runs_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
CREATE TRIGGER loop_task_reviews_terminal_immutable BEFORE UPDATE OR DELETE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
CREATE TRIGGER reviewer_executions_terminal_immutable BEFORE UPDATE OR DELETE ON public.reviewer_executions FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();
DROP FUNCTION public.qa_result_is_valid(jsonb,text,jsonb);
DROP FUNCTION public.qa_policy_is_valid(jsonb);
DROP FUNCTION public.qa_target_url_is_valid(text);
DROP FUNCTION public.qa_text_is_valid(text,integer);
DROP FUNCTION public.qa_jsonb_sha256(jsonb);
DROP FUNCTION public.qa_jsonb_canonical(jsonb);

-- Reverse grants installed for the dedicated runtime role. Cluster roles remain
-- intentionally present because the same roles can be in use by other databases.
DO $default_privileges$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLES FROM aipaths_mc_app',current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE USAGE,SELECT,UPDATE ON SEQUENCES FROM aipaths_mc_app',current_user);
END $default_privileges$;
REVOKE SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM aipaths_mc_app;
REVOKE USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public FROM aipaths_mc_app;
-- Retain safe schema resolution for the fixed roles and never restore the
-- insecure historical PUBLIC/app ability to create search-path objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, aipaths_mc_app;
COMMIT;
