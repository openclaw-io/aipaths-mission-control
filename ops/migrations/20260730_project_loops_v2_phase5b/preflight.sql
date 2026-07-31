-- Phase 5B preflight. Read-only and safe for local Postgres only.
BEGIN;
SET TRANSACTION READ ONLY;
DO $$
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) THEN
    RAISE EXCEPTION 'Phase 5B migration executor must be a PostgreSQL superuser';
  END IF;
  IF to_regclass('public.reviewer_executions') IS NULL OR to_regclass('public.loop_task_runs') IS NULL THEN
    RAISE EXCEPTION 'Project Loops V2 Phase 4 is missing';
  END IF;
  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN RAISE EXCEPTION 'pgcrypto digest(bytea,text) is required'; END IF;
  IF to_regprocedure('public.hmac(bytea,bytea,text)') IS NULL THEN RAISE EXCEPTION 'pgcrypto hmac(bytea,bytea,text) is required'; END IF;
  IF to_regclass('public.qa_executions') IS NOT NULL THEN RAISE EXCEPTION 'Phase 5B already appears installed'; END IF;
  IF EXISTS (SELECT 1 FROM public.loop_task_runs WHERE status IN ('queued','running'))
    OR EXISTS (SELECT 1 FROM public.loops WHERE workflow_version=2 AND status NOT IN ('completed','cancelled','blocked')) THEN
    RAISE EXCEPTION 'Active Project Loops V2 work must drain before Phase 5B';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loop_task_runs WHERE run_role NOT IN ('implementation','review')) THEN
    RAISE EXCEPTION 'Unexpected pre-Phase-5B run role';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loop_tasks WHERE status='qa_pending') THEN
    RAISE EXCEPTION 'Unexpected pre-Phase-5B qa_pending task';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))
         OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))) THEN
    RAISE EXCEPTION 'Phase 5B roles must have exactly zero membership edges in either direction';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loop_tasks WHERE metadata ? 'qa_policy' AND (
      jsonb_typeof(metadata->'qa_policy') IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(metadata->'qa_policy') key)
        IS DISTINCT FROM ARRAY['flows','required','target_url','viewports']
      OR jsonb_typeof(metadata->'qa_policy'->'required') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(metadata->'qa_policy'->'viewports') IS DISTINCT FROM 'array'
      OR jsonb_typeof(metadata->'qa_policy'->'flows') IS DISTINCT FROM 'array')) THEN
    RAISE EXCEPTION 'Malformed historical persisted QA policy';
  END IF;
END $$;
COMMIT;
