-- Project Loops V2 Phase 5B: dedicated structured visual QA state machine.
-- Additive cloud-parity artifact; local Postgres is the runtime authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Fixed cluster roles separate ordinary runtime SQL from QA authority. Role DDL
-- is idempotent because disposable databases share one PostgreSQL cluster.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_qa_owner') THEN
    CREATE ROLE aipaths_mc_qa_owner NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_app') THEN
    CREATE ROLE aipaths_mc_app LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $roles$;
ALTER ROLE aipaths_mc_qa_owner NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE aipaths_mc_app LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
DO $role_isolation$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))
         OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))) THEN
    RAISE EXCEPTION 'Phase 5B roles must have exactly zero membership edges in either direction' USING ERRCODE='42501';
  END IF;
END $role_isolation$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, aipaths_mc_app;
GRANT USAGE ON SCHEMA public TO aipaths_mc_app,aipaths_mc_qa_owner;

ALTER TABLE public.loop_tasks DROP CONSTRAINT loop_tasks_status_check;
ALTER TABLE public.loop_tasks ADD CONSTRAINT loop_tasks_status_check
  CHECK (status IN ('pending','ready','in_progress','review_pending','qa_pending','rework_required','blocked','completed','skipped','cancelled'));

ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_run_role_check;
ALTER TABLE public.loop_task_runs DROP CONSTRAINT loop_task_runs_role_target_check;
ALTER TABLE public.loop_task_runs
  ADD CONSTRAINT loop_task_runs_run_role_check CHECK (run_role IN ('implementation', 'review', 'qa')),
  ADD CONSTRAINT loop_task_runs_role_target_check CHECK (
    (run_role='implementation' AND target_run_id IS NULL AND target_sha IS NULL)
    OR (run_role IN ('review','qa') AND target_run_id IS NOT NULL AND target_sha IS NOT NULL)
  );

CREATE TABLE public.qa_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_run_id uuid NOT NULL UNIQUE,
  task_id uuid NOT NULL,
  work_item_id uuid NOT NULL UNIQUE REFERENCES public.work_items(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL,
  target_run_id uuid NOT NULL,
  target_sha text NOT NULL CHECK (target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','blocked')),
  capability_hash bytea NOT NULL CHECK (octet_length(capability_hash)=32),
  capability_expires_at timestamptz NOT NULL,
  capability_consumed_at timestamptz,
  capability_revoked_at timestamptz,
  qa_session_id text NOT NULL UNIQUE CHECK (qa_session_id ~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$'),
  result jsonb,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  error text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_executions_qa_run_task_fkey FOREIGN KEY (qa_run_id,task_id)
    REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  CONSTRAINT qa_executions_target_run_task_fkey FOREIGN KEY (target_run_id,task_id)
    REFERENCES public.loop_task_runs(id,task_id) ON DELETE RESTRICT,
  CONSTRAINT qa_executions_capability_state_check CHECK (capability_consumed_at IS NULL OR capability_revoked_at IS NULL),
  CONSTRAINT qa_executions_result_object_check CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  CONSTRAINT qa_executions_terminal_check CHECK (
    (status='running' AND finished_at IS NULL AND result IS NULL AND result_hash IS NULL AND error IS NULL
      AND capability_consumed_at IS NULL AND capability_revoked_at IS NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND result IS NOT NULL AND result_hash IS NOT NULL
      AND error IS NULL AND capability_consumed_at IS NOT NULL AND capability_revoked_at IS NULL)
    OR (status IN ('failed','blocked') AND finished_at IS NOT NULL AND result IS NULL AND result_hash IS NULL
      AND error IS NOT NULL AND capability_consumed_at IS NULL AND capability_revoked_at IS NOT NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND result IS NOT NULL AND result_hash IS NOT NULL
      AND error IS NOT NULL AND capability_consumed_at IS NOT NULL AND capability_revoked_at IS NULL)
  )
);
CREATE INDEX idx_qa_executions_stale ON public.qa_executions(heartbeat_at,id) WHERE status='running';
CREATE INDEX idx_qa_executions_task_created ON public.qa_executions(task_id,created_at DESC,id DESC);
REVOKE ALL ON public.qa_executions FROM PUBLIC;
ALTER TABLE public.qa_executions OWNER TO aipaths_mc_qa_owner;
GRANT SELECT ON public.qa_executions TO aipaths_mc_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.qa_executions FROM aipaths_mc_app;

CREATE TABLE public.qa_authority_secrets (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hmac_key bytea NOT NULL CHECK (octet_length(hmac_key)=32),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  rotated_by text NOT NULL
);
INSERT INTO public.qa_authority_secrets(singleton,hmac_key,rotated_by)
VALUES(true,public.gen_random_bytes(32),'migration-random-initialization');
REVOKE ALL ON public.qa_authority_secrets FROM PUBLIC,aipaths_mc_app;
ALTER TABLE public.qa_authority_secrets OWNER TO aipaths_mc_qa_owner;

-- SECURITY INVOKER is intentional: current_user remains the caller, so SET ROLE
-- aipaths_mc_app cannot inherit a superuser session's ability to rotate the key.
CREATE FUNCTION public.install_qa_authority_hmac_key(key_hex text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
BEGIN
  IF NOT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),false) THEN
    RAISE EXCEPTION 'QA authority HMAC key installation requires current superuser role' USING ERRCODE='42501';
  END IF;
  IF key_hex IS NULL OR key_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'QA authority HMAC key must be exactly 64 lowercase hex characters' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.qa_authority_secrets(singleton,hmac_key,rotated_at,rotated_by)
  VALUES(true,decode(key_hex,'hex'),clock_timestamp(),current_user)
  ON CONFLICT(singleton) DO UPDATE SET hmac_key=excluded.hmac_key,rotated_at=excluded.rotated_at,rotated_by=excluded.rotated_by;
END $body$;
ALTER FUNCTION public.install_qa_authority_hmac_key(text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.install_qa_authority_hmac_key(text) FROM PUBLIC,aipaths_mc_app;

-- Canonical JSON hashing shared by policy/result integrity checks. The bounded QA
-- contracts contain JSON scalars, arrays and objects only.
CREATE OR REPLACE FUNCTION public.qa_jsonb_canonical(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||public.qa_jsonb_canonical(child),',' ORDER BY key)
      FROM jsonb_each(value) entry(key,child)),'')||'}'
    WHEN 'array' THEN '['||coalesce((SELECT string_agg(public.qa_jsonb_canonical(child),',' ORDER BY ordinality)
      FROM jsonb_array_elements(value) WITH ORDINALITY entry(child,ordinality)),'')||']'
    ELSE value::text
  END
$body$;
CREATE OR REPLACE FUNCTION public.qa_jsonb_sha256(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $body$
  SELECT encode(public.digest(convert_to(public.qa_jsonb_canonical(value),'UTF8'),'sha256'),'hex')
$body$;
REVOKE ALL ON FUNCTION public.qa_jsonb_canonical(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qa_jsonb_sha256(jsonb) FROM PUBLIC;

CREATE FUNCTION public.qa_text_is_valid(value text,max_bytes integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE encoded bytea; DECLARE i integer;
BEGIN
  IF value IS NULL OR max_bytes<1 THEN RETURN false; END IF;
  encoded:=convert_to(value,'UTF8');
  FOR i IN 0..octet_length(encoded)-1 LOOP
    IF get_byte(encoded,i)=0 THEN RETURN false; END IF;
  END LOOP;
  RETURN octet_length(encoded) BETWEEN 1 AND max_bytes
    AND get_byte(encoded,0) NOT BETWEEN 0 AND 32 AND get_byte(encoded,0)<>127
    AND get_byte(encoded,octet_length(encoded)-1) NOT BETWEEN 0 AND 32
    AND get_byte(encoded,octet_length(encoded)-1)<>127;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_text_is_valid(text,integer) FROM PUBLIC;

CREATE FUNCTION public.qa_target_url_is_valid(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE encoded bytea; DECLARE i integer; DECLARE remainder text; DECLARE authority text;
DECLARE host text; DECLARE raw_port text; DECLARE labels text[]; DECLARE label text;
DECLARE parts text[]; DECLARE part text;
BEGIN
  IF value IS NULL THEN RETURN false; END IF;
  encoded:=convert_to(value,'UTF8');
  IF octet_length(encoded) NOT BETWEEN 1 AND 2048 THEN RETURN false; END IF;
  FOR i IN 0..octet_length(encoded)-1 LOOP
    IF get_byte(encoded,i)<33 OR get_byte(encoded,i)>126 THEN RETURN false; END IF;
  END LOOP;
  IF value !~ '^https?://[^/?#:]+(?::[0-9]+)?(?:[/?][^#]*)?$' THEN RETURN false; END IF;
  remainder:=substring(value FROM position('://' IN value)+3);
  authority:=substring(remainder FROM '^[^/?#]+');
  IF authority LIKE '%:%' THEN
    IF authority !~ '^[^:]+:[0-9]+$' THEN RETURN false; END IF;
    host:=split_part(authority,':',1); raw_port:=split_part(authority,':',2);
    IF raw_port !~ '^[1-9][0-9]{0,4}$' OR raw_port::integer>65535 THEN RETURN false; END IF;
  ELSE host:=authority; END IF;
  IF host IS NULL OR host='' OR octet_length(host)>253 OR host<>lower(host) THEN RETURN false; END IF;
  IF host ~ '^[0-9.]+$' THEN
    parts:=string_to_array(host,'.');
    IF array_length(parts,1) IS DISTINCT FROM 4 THEN RETURN false; END IF;
    FOREACH part IN ARRAY parts LOOP
      IF part !~ '^(?:0|[1-9][0-9]{0,2})$' OR part::integer>255 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  labels:=string_to_array(host,'.');
  FOREACH label IN ARRAY labels LOOP
    IF label !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_target_url_is_valid(text) FROM PUBLIC;

-- Exact canonical persisted-policy validation. A present malformed policy must
-- never acquire the same semantics as an absent or canonical required=false policy.
CREATE FUNCTION public.qa_policy_is_valid(policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(policy) key)
      IS DISTINCT FROM ARRAY['flows','required','target_url','viewports']
    OR jsonb_typeof(policy->'required') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(policy->'viewports') IS DISTINCT FROM 'array'
    OR jsonb_typeof(policy->'flows') IS DISTINCT FROM 'array'
    OR octet_length(convert_to(public.qa_jsonb_canonical(policy),'UTF8'))>65536
    OR jsonb_array_length(policy->'viewports')>8 OR jsonb_array_length(policy->'flows')>20 THEN RETURN false;
  END IF;
  IF policy->'required'='false'::jsonb THEN
    RETURN policy->'target_url' IS NOT DISTINCT FROM 'null'::jsonb
      AND jsonb_array_length(policy->'viewports')=0 AND jsonb_array_length(policy->'flows')=0;
  END IF;
  IF policy->'required' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(policy->'target_url') IS DISTINCT FROM 'string'
    OR NOT public.qa_target_url_is_valid(policy->>'target_url')
    OR jsonb_array_length(policy->'viewports')=0 THEN RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
          IS DISTINCT FROM ARRAY['height','name','width']
        OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
        OR NOT public.qa_text_is_valid(item->>'name',80)
        OR jsonb_typeof(item->'width') IS DISTINCT FROM 'number' OR item->>'width' !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(item->'height') IS DISTINCT FROM 'number' OR item->>'height' !~ '^(0|[1-9][0-9]*)$'
        OR (item->>'width')::integer NOT BETWEEN 320 AND 2560 OR (item->>'height')::integer NOT BETWEEN 320 AND 2560)
    OR (SELECT count(*) FROM jsonb_array_elements(policy->'viewports')) IS DISTINCT FROM
       (SELECT count(DISTINCT lower(item->>'name')) FROM jsonb_array_elements(policy->'viewports') item)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'flows') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item#>>'{}',500))
    OR (SELECT count(*) FROM jsonb_array_elements_text(policy->'flows')) IS DISTINCT FROM
       (SELECT count(DISTINCT flow) FROM jsonb_array_elements_text(policy->'flows') flow) THEN RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_policy_is_valid(jsonb) FROM PUBLIC;

-- Defense-in-depth result validation mirrors the complete bounded TypeScript contract.
CREATE FUNCTION public.qa_result_is_valid(value jsonb, expected_sha text, policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $body$
DECLARE verdict text;
DECLARE expected_viewports integer;
DECLARE expected_flows integer;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) key)
      IS DISTINCT FROM ARRAY['error','evidence','findings','flow_checks','tested_sha','verdict','viewport_checks']
    OR jsonb_typeof(value->'verdict') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'tested_sha') IS DISTINCT FROM 'string'
    OR value->>'tested_sha' IS DISTINCT FROM expected_sha
    OR jsonb_typeof(value->'viewport_checks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'flow_checks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'evidence') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'findings') IS DISTINCT FROM 'array'
    OR octet_length(convert_to(public.qa_jsonb_canonical(value),'UTF8'))>262144
    OR NOT public.qa_policy_is_valid(policy)
    OR policy->'required' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;
  END IF;
  verdict := value->>'verdict';
  IF verdict IS NULL OR verdict NOT IN ('pass','changes','infrastructure_failure') THEN RETURN false; END IF;
  IF value->'error' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'error') IS DISTINCT FROM 'string'
    OR NOT public.qa_text_is_valid(value->>'error',2048)) THEN RETURN false; END IF;
  IF jsonb_array_length(value->'evidence')>64 OR jsonb_array_length(value->'findings')>50 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(value->'evidence') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
        IS DISTINCT FROM ARRAY['bytes','flow','kind','media_type','sha256','storage_ref','viewport']
      OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string' OR item->>'kind' NOT IN ('screenshot','video','trace','log')
      OR jsonb_typeof(item->'storage_ref') IS DISTINCT FROM 'string'
      OR NOT public.qa_text_is_valid(item->>'storage_ref',1024)
      OR item->>'storage_ref' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      OR item->>'storage_ref' LIKE '%//%' OR item->>'storage_ref' ~ '(^|/)[.][.]?(/|$)'
      OR jsonb_typeof(item->'sha256') IS DISTINCT FROM 'string' OR item->>'sha256' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(item->'bytes') IS DISTINCT FROM 'number' OR item->>'bytes' !~ '^[1-9][0-9]*$'
      OR (item->>'bytes')::numeric>104857600
      OR jsonb_typeof(item->'media_type') IS DISTINCT FROM 'string'
      OR item->>'media_type' NOT IN ('image/png','image/jpeg','image/webp','video/webm','video/mp4','application/json','application/zip','text/plain')
      OR jsonb_typeof(item->'viewport') NOT IN ('null','string') OR jsonb_typeof(item->'flow') NOT IN ('null','string')
      OR (jsonb_typeof(item->'viewport')='string' AND (NOT public.qa_text_is_valid(item->>'viewport',80)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') p WHERE p->>'name' IS NOT DISTINCT FROM item->>'viewport')))
      OR (jsonb_typeof(item->'flow')='string' AND (NOT public.qa_text_is_valid(item->>'flow',500)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'flows') p(flow) WHERE p.flow IS NOT DISTINCT FROM item->>'flow')))) THEN RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(value->'findings') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['evidence','recommendation','title']
      OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'title',500)
      OR jsonb_typeof(item->'evidence') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'evidence',2048)
      OR jsonb_typeof(item->'recommendation') IS DISTINCT FROM 'string' OR NOT public.qa_text_is_valid(item->>'recommendation',2048)) THEN RETURN false;
  END IF;
  IF verdict='infrastructure_failure' THEN
    RETURN jsonb_array_length(value->'viewport_checks')=0 AND jsonb_array_length(value->'flow_checks')=0
      AND jsonb_array_length(value->'evidence')=0 AND jsonb_array_length(value->'findings')=0
      AND jsonb_typeof(value->'error')='string' AND public.qa_text_is_valid(value->>'error',2048);
  END IF;
  expected_viewports := jsonb_array_length(policy->'viewports'); expected_flows := jsonb_array_length(policy->'flows');
  IF jsonb_array_length(value->'evidence') IS DISTINCT FROM expected_viewports * greatest(expected_flows,1) * 2
    OR (SELECT count(DISTINCT item->>'storage_ref') FROM jsonb_array_elements(value->'evidence') item)
      IS DISTINCT FROM jsonb_array_length(value->'evidence')::bigint
    OR (SELECT count(DISTINCT ROW(item->>'viewport',item->>'flow',item->>'kind')) FROM jsonb_array_elements(value->'evidence') item)
      IS DISTINCT FROM jsonb_array_length(value->'evidence')::bigint
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'evidence') item
      WHERE item->>'kind' NOT IN ('screenshot','log')
        OR jsonb_typeof(item->'viewport') IS DISTINCT FROM 'string'
        OR (item->>'kind'='screenshot' AND item->>'media_type' IS DISTINCT FROM 'image/png')
        OR (item->>'kind'='log' AND item->>'media_type' IS DISTINCT FROM 'application/json')
        OR (expected_flows=0 AND item->'flow' IS DISTINCT FROM 'null'::jsonb)
        OR (expected_flows>0 AND jsonb_typeof(item->'flow') IS DISTINCT FROM 'string')) THEN RETURN false;
  END IF;
  IF jsonb_array_length(value->'viewport_checks') IS DISTINCT FROM expected_viewports
    OR jsonb_array_length(value->'flow_checks') IS DISTINCT FROM expected_flows
    OR (SELECT count(DISTINCT item->>'viewport') FROM jsonb_array_elements(value->'viewport_checks') item) IS DISTINCT FROM expected_viewports::bigint
    OR (SELECT count(DISTINCT item->>'flow') FROM jsonb_array_elements(value->'flow_checks') item) IS DISTINCT FROM expected_flows::bigint
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['details','status','viewport']
      OR jsonb_typeof(item->'viewport') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(policy->'viewports') p WHERE p->>'name' IS NOT DISTINCT FROM item->>'viewport')
      OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string' OR item->>'status' NOT IN ('pass','fail')
      OR jsonb_typeof(item->'details') NOT IN ('null','string')
      OR (jsonb_typeof(item->'details')='string' AND NOT public.qa_text_is_valid(item->>'details',2048)))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM ARRAY['details','flow','status']
      OR jsonb_typeof(item->'flow') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'flows') p(flow) WHERE p.flow IS NOT DISTINCT FROM item->>'flow')
      OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string' OR item->>'status' NOT IN ('pass','fail')
      OR jsonb_typeof(item->'details') NOT IN ('null','string')
      OR (jsonb_typeof(item->'details')='string' AND NOT public.qa_text_is_valid(item->>'details',2048))) THEN RETURN false;
  END IF;
  IF value->'error' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  IF verdict='pass' THEN
    RETURN jsonb_array_length(value->'findings')=0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE item->>'status' IS DISTINCT FROM 'pass')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE item->>'status' IS DISTINCT FROM 'pass');
  END IF;
  RETURN jsonb_array_length(value->'findings')>0 AND (
    EXISTS (SELECT 1 FROM jsonb_array_elements(value->'viewport_checks') item WHERE item->>'status'='fail')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(value->'flow_checks') item WHERE item->>'status'='fail'));
EXCEPTION WHEN others THEN RETURN false;
END $body$;
REVOKE ALL ON FUNCTION public.qa_result_is_valid(jsonb,text,jsonb) FROM PUBLIC;

CREATE FUNCTION public.lock_visual_qa_execution(execution_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
BEGIN
  PERFORM 1 FROM public.qa_executions WHERE id=execution_id FOR UPDATE;
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.lock_visual_qa_execution(uuid) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.lock_visual_qa_execution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_visual_qa_execution(uuid) TO aipaths_mc_app;

-- Replace Phase 4's two-role trigger with explicit implementation/review/qa branches.
DROP TRIGGER loop_task_runs_quality_integrity ON public.loop_task_runs;
DROP TRIGGER loop_task_reviews_quality_integrity ON public.loop_task_reviews;
CREATE OR REPLACE FUNCTION public.validate_loop_quality_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
DECLARE target public.loop_task_runs%ROWTYPE;
DECLARE implementation public.loop_task_runs%ROWTYPE;
DECLARE review_run public.loop_task_runs%ROWTYPE;
DECLARE qa_work public.work_items%ROWTYPE;
DECLARE reviewer_session text;
DECLARE phase4 boolean;
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' THEN
    SELECT NEW.run_role IN ('review','qa') OR NEW.repository_id IS NOT NULL OR NEW.base_sha IS NOT NULL
      OR NEW.artifact_sha IS NOT NULL OR NEW.server_session_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.work_items wi WHERE wi.id=NEW.work_item_id
        AND wi.payload->>'runtime_contract' IN ('fresh_review_v1','visual_qa_v1')) INTO phase4;
    IF phase4 AND (NEW.repository_id IS NULL OR NEW.base_sha IS NULL) THEN RAISE EXCEPTION 'Phase 4+ run requires registered repository and base SHA' USING ERRCODE='23514'; END IF;
    IF NEW.run_role='implementation' THEN
      IF NEW.target_run_id IS NOT NULL OR NEW.target_sha IS NOT NULL THEN RAISE EXCEPTION 'Implementation run cannot have target identity' USING ERRCODE='23514'; END IF;
      IF phase4 AND NEW.status='succeeded' AND (NEW.artifact_sha IS NULL OR NEW.server_session_id IS NULL) THEN RAISE EXCEPTION 'Succeeded Phase 4 implementation run requires artifact SHA and server session' USING ERRCODE='23514'; END IF;
    ELSIF NEW.run_role='review' THEN
      SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
      IF NOT FOUND OR target.task_id<>NEW.task_id OR target.run_role<>'implementation' OR target.quality_cycle<>NEW.quality_cycle OR target.status<>'succeeded' OR target.artifact_sha IS NULL OR target.artifact_sha<>NEW.target_sha OR target.repository_id<>NEW.repository_id OR target.base_sha<>NEW.base_sha THEN RAISE EXCEPTION 'Review run target integrity mismatch' USING ERRCODE='23514'; END IF;
      IF NEW.status='succeeded' AND (NEW.server_session_id IS NULL OR target.server_session_id IS NULL OR NEW.server_session_id=target.server_session_id) THEN RAISE EXCEPTION 'Review run terminal session integrity mismatch' USING ERRCODE='23514'; END IF;
    ELSIF NEW.run_role='qa' THEN
      SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
      SELECT * INTO qa_work FROM public.work_items WHERE id=NEW.work_item_id;
      SELECT d.reviewer_session_id INTO reviewer_session FROM public.loop_task_reviews d
        WHERE d.task_id=NEW.task_id AND d.task_run_id=NEW.target_run_id AND d.quality_cycle=NEW.quality_cycle
          AND d.status='approved' AND d.reviewed_sha=NEW.target_sha;
      IF NOT FOUND OR target.task_id IS DISTINCT FROM NEW.task_id OR target.run_role IS DISTINCT FROM 'implementation'
        OR target.quality_cycle IS DISTINCT FROM NEW.quality_cycle OR target.status IS DISTINCT FROM 'succeeded'
        OR target.artifact_sha IS NULL OR target.artifact_sha IS DISTINCT FROM NEW.target_sha
        OR target.repository_id IS DISTINCT FROM NEW.repository_id OR target.base_sha IS DISTINCT FROM NEW.base_sha
        OR reviewer_session IS NULL OR qa_work.id IS NULL
        OR (NEW.status='queued' AND qa_work.status IS DISTINCT FROM 'ready')
        OR (NEW.status='running' AND (qa_work.status IS NULL OR qa_work.status NOT IN ('ready','in_progress')))
        OR (NEW.status='succeeded' AND (qa_work.status IS NULL OR qa_work.status NOT IN ('in_progress','done')))
        OR (NEW.status IN ('failed','cancelled') AND (qa_work.status IS NULL OR qa_work.status NOT IN ('in_progress','failed','canceled')))
        OR qa_work.source_type IS DISTINCT FROM 'loop'
        OR qa_work.source_id IS DISTINCT FROM NEW.task_id::text
        OR qa_work.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1'
        OR qa_work.payload->>'run_role' IS DISTINCT FROM 'qa'
        OR qa_work.payload->>'loop_task_id' IS DISTINCT FROM NEW.task_id::text
        OR qa_work.payload->>'execution_attempt_id' IS DISTINCT FROM NEW.execution_attempt_id::text
        OR qa_work.payload->>'quality_cycle' IS DISTINCT FROM NEW.quality_cycle::text
        OR qa_work.payload->>'target_run_id' IS DISTINCT FROM NEW.target_run_id::text
        OR qa_work.payload->>'target_sha' IS DISTINCT FROM NEW.target_sha
        OR qa_work.payload->'qa_policy' IS DISTINCT FROM (SELECT metadata->'qa_policy' FROM public.loop_tasks WHERE id=NEW.task_id)
        OR NOT public.qa_policy_is_valid(qa_work.payload->'qa_policy')
        OR qa_work.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
        OR qa_work.payload->>'policy_hash' IS DISTINCT FROM public.qa_jsonb_sha256(qa_work.payload->'qa_policy') THEN
        RAISE EXCEPTION 'QA run work/target/policy integrity mismatch' USING ERRCODE='23514';
      END IF;
      IF (NEW.status='succeeded' OR (NEW.status='failed' AND NEW.server_session_id IS NOT NULL)) AND NEW.finished_at IS NOT NULL
        AND (NEW.server_session_id IS NULL OR NEW.server_session_id !~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$' OR target.server_session_id IS NULL
        OR NEW.server_session_id IN (target.server_session_id,reviewer_session)) THEN
        RAISE EXCEPTION 'QA run terminal session integrity mismatch' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Unknown Loop run role' USING ERRCODE='23514';
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
  ELSIF NEW.status='rejected' AND review_run.status NOT IN ('failed','cancelled') THEN RAISE EXCEPTION 'Failed review decision is incoherent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER loop_task_runs_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_runs FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();
CREATE TRIGGER loop_task_reviews_quality_integrity BEFORE INSERT OR UPDATE ON public.loop_task_reviews FOR EACH ROW EXECUTE FUNCTION public.validate_loop_quality_integrity();

CREATE FUNCTION public.validate_qa_execution_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE qa_run public.loop_task_runs%ROWTYPE;
DECLARE target public.loop_task_runs%ROWTYPE;
DECLARE work public.work_items%ROWTYPE;
DECLARE reviewer_session text;
BEGIN
  SELECT * INTO qa_run FROM public.loop_task_runs WHERE id=NEW.qa_run_id;
  SELECT * INTO target FROM public.loop_task_runs WHERE id=NEW.target_run_id;
  SELECT * INTO work FROM public.work_items WHERE id=NEW.work_item_id;
  SELECT d.reviewer_session_id INTO reviewer_session FROM public.loop_task_reviews d
    WHERE d.task_id=NEW.task_id AND d.task_run_id=NEW.target_run_id AND d.quality_cycle=qa_run.quality_cycle
      AND d.status='approved' AND d.reviewed_sha=NEW.target_sha;
  IF qa_run.id IS NULL OR target.id IS NULL OR work.id IS NULL
    OR qa_run.run_role IS DISTINCT FROM 'qa' OR qa_run.task_id IS DISTINCT FROM NEW.task_id
    OR qa_run.work_item_id IS DISTINCT FROM NEW.work_item_id OR qa_run.execution_attempt_id IS DISTINCT FROM NEW.execution_attempt_id
    OR qa_run.target_run_id IS DISTINCT FROM NEW.target_run_id OR qa_run.target_sha IS DISTINCT FROM NEW.target_sha
    OR target.task_id IS DISTINCT FROM NEW.task_id OR target.quality_cycle IS DISTINCT FROM qa_run.quality_cycle
    OR target.run_role IS DISTINCT FROM 'implementation' OR target.status IS DISTINCT FROM 'succeeded'
    OR target.artifact_sha IS DISTINCT FROM NEW.target_sha
    OR work.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1' OR work.payload->>'run_role' IS DISTINCT FROM 'qa'
    OR work.payload->>'execution_attempt_id' IS DISTINCT FROM NEW.execution_attempt_id::text
    OR work.payload->>'target_run_id' IS DISTINCT FROM NEW.target_run_id::text
    OR work.payload->>'target_sha' IS DISTINCT FROM NEW.target_sha OR work.payload->>'policy_hash' IS DISTINCT FROM NEW.policy_hash
    OR work.payload->>'quality_cycle' IS DISTINCT FROM qa_run.quality_cycle::text
    OR work.payload->'qa_policy' IS DISTINCT FROM (SELECT metadata->'qa_policy' FROM public.loop_tasks WHERE id=NEW.task_id)
    OR NOT public.qa_policy_is_valid(work.payload->'qa_policy')
    OR work.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
    OR NEW.policy_hash IS DISTINCT FROM public.qa_jsonb_sha256(work.payload->'qa_policy')
    OR work.payload->>'plan_revision_id' IS DISTINCT FROM (SELECT s.plan_revision_id::text FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id WHERE t.id=NEW.task_id)
    OR work.payload->>'plan_hash' IS DISTINCT FROM (SELECT p.content_hash FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id WHERE t.id=NEW.task_id AND p.status='approved')
    OR coalesce((SELECT l.current_plan_revision_id IS DISTINCT FROM s.plan_revision_id FROM public.loop_tasks t JOIN public.loop_stages s ON s.id=t.stage_id JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id JOIN public.loops l ON l.id=p.loop_id WHERE t.id=NEW.task_id),true)
    OR reviewer_session IS NULL THEN
    RAISE EXCEPTION 'QA execution binding integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.qa_session_id IS NULL OR NEW.qa_session_id IS NOT DISTINCT FROM target.server_session_id
    OR NEW.qa_session_id IS NOT DISTINCT FROM reviewer_session
    OR EXISTS (SELECT 1 FROM public.loop_task_runs r WHERE r.run_role IN ('implementation','review')
      AND r.server_session_id IS NOT DISTINCT FROM NEW.qa_session_id) THEN
    RAISE EXCEPTION 'QA execution session integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.result IS NOT NULL AND (NOT public.qa_result_is_valid(NEW.result,NEW.target_sha,work.payload->'qa_policy')
    OR NEW.result_hash IS DISTINCT FROM public.qa_jsonb_sha256(NEW.result)) THEN
    RAISE EXCEPTION 'QA execution result/SHA/hash integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='succeeded' AND (qa_run.status IS DISTINCT FROM 'succeeded'
    OR jsonb_typeof(NEW.result->'verdict') IS DISTINCT FROM 'string'
    OR NEW.result->>'verdict' NOT IN ('pass','changes')
    OR NEW.qa_session_id IS DISTINCT FROM qa_run.server_session_id) THEN
    RAISE EXCEPTION 'QA execution terminal session integrity mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='failed' AND NEW.capability_consumed_at IS NOT NULL
    AND (qa_run.status IS DISTINCT FROM 'failed' OR NEW.result->>'verdict' IS DISTINCT FROM 'infrastructure_failure'
      OR NEW.error IS DISTINCT FROM NEW.result->>'error' OR NEW.qa_session_id IS DISTINCT FROM qa_run.server_session_id) THEN
    RAISE EXCEPTION 'QA infrastructure failure integrity mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION public.validate_qa_execution_integrity() FROM PUBLIC;
CREATE TRIGGER qa_executions_integrity BEFORE INSERT OR UPDATE ON public.qa_executions FOR EACH ROW EXECUTE FUNCTION public.validate_qa_execution_integrity();

-- visual_qa_v1 work can move only inside the dedicated atomic transition function.
-- Claim/pass authority carries the raw capability only in this transaction-scoped,
-- immediately deleted proof row. Reconcile is intentionally bounded to fail-safe blocking.
-- Database-owner/superuser trigger alteration or disabling is outside this boundary.
CREATE TABLE public.qa_work_item_transition_authorities (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  work_item_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  transition text NOT NULL CHECK (transition IN ('claim','complete','reconcile')),
  capability_proof text CHECK (capability_proof IS NULL OR capability_proof ~ '^[A-Za-z0-9_-]{43}$'),
  PRIMARY KEY (backend_pid,transaction_id,work_item_id)
);
REVOKE ALL ON public.qa_work_item_transition_authorities FROM PUBLIC,aipaths_mc_app;
ALTER TABLE public.qa_work_item_transition_authorities OWNER TO aipaths_mc_qa_owner;

CREATE FUNCTION public.guard_visual_qa_work_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE transition text;
BEGIN
  IF TG_OP='INSERT' OR OLD.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1' THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'visual_qa_v1 work cannot be deleted' USING ERRCODE='23514'; END IF;
  SELECT a.transition INTO transition FROM public.qa_work_item_transition_authorities a
    JOIN public.qa_executions qe ON qe.id=a.execution_id AND qe.work_item_id=a.work_item_id
    WHERE a.backend_pid=pg_backend_pid() AND a.transaction_id=txid_current() AND a.work_item_id=NEW.id
      AND a.execution_id::text IS NOT DISTINCT FROM NEW.payload->>'qa_execution_id'
      AND qe.status='running' AND qe.capability_consumed_at IS NULL AND qe.capability_revoked_at IS NULL
      AND ((a.transition IN ('claim','complete') AND a.capability_proof IS NOT NULL
          AND public.digest(convert_to(a.capability_proof,'UTF8'),'sha256') IS NOT DISTINCT FROM qe.capability_hash)
        OR (a.transition='reconcile' AND (a.capability_proof IS NULL OR (
          public.digest(convert_to(a.capability_proof,'UTF8'),'sha256') IS NOT DISTINCT FROM qe.capability_hash))));
  IF transition IS NULL THEN
    RAISE EXCEPTION 'visual_qa_v1 work requires dedicated transition authority with valid capability' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','started_at','completed_at','updated_at','payload'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','started_at','completed_at','updated_at','payload'])
    OR (NEW.payload - ARRAY['dispatch_state','qa_execution_id','dispatch_completed_at'])
      IS DISTINCT FROM (OLD.payload - ARRAY['dispatch_state','qa_execution_id','dispatch_completed_at']) THEN
    RAISE EXCEPTION 'visual_qa_v1 work identity is immutable' USING ERRCODE='23514';
  END IF;
  IF (transition='claim' AND NOT (OLD.status='ready' AND NEW.status='in_progress'))
    OR (transition='complete' AND NOT (OLD.status='in_progress' AND NEW.status='done'))
    OR (transition='reconcile' AND NOT (OLD.status='in_progress' AND NEW.status='failed')) THEN
    RAISE EXCEPTION 'visual_qa_v1 work transition is invalid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.loop_task_runs qr JOIN public.qa_executions qe ON qe.qa_run_id=qr.id AND qe.work_item_id=NEW.id
    WHERE qr.work_item_id=NEW.id AND qe.id::text IS NOT DISTINCT FROM NEW.payload->>'qa_execution_id' AND qe.status='running'
      AND qe.capability_consumed_at IS NULL AND qe.capability_revoked_at IS NULL
      AND ((transition='claim' AND qr.status='running' AND OLD.payload->>'dispatch_state' IS NOT DISTINCT FROM 'ready'
            AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'in_progress')
        OR (transition='complete' AND qr.status='succeeded' AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'completed')
        OR (transition='reconcile' AND qr.status='failed' AND NEW.payload->>'dispatch_state' IS NOT DISTINCT FROM 'failed'))
  ) THEN RAISE EXCEPTION 'visual_qa_v1 work transition authority mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION public.guard_visual_qa_work_item() FROM PUBLIC;
CREATE TRIGGER visual_qa_work_items_guard BEFORE UPDATE OR DELETE ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.guard_visual_qa_work_item();
ALTER FUNCTION public.validate_qa_execution_integrity() OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.guard_visual_qa_work_item() OWNER TO aipaths_mc_qa_owner;

-- Least-privilege authority-owner access used only through fixed SECURITY DEFINER entry points.
GRANT SELECT ON public.work_items,public.loop_task_runs,public.loop_task_reviews,public.loop_tasks,
  public.loop_stages,public.loop_plan_revisions,public.loops TO aipaths_mc_qa_owner;
GRANT UPDATE ON public.work_items,public.loop_task_runs,public.loop_tasks,public.loops TO aipaths_mc_qa_owner;

CREATE FUNCTION public.transition_visual_qa_work_item(work_id uuid, p_execution_id uuid, transition_name text,
  transition_at timestamptz, raw_capability text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE changed integer;
DECLARE execution public.qa_executions%ROWTYPE;
DECLARE run_status text;
BEGIN
  IF transition_name IS NULL OR transition_name NOT IN ('claim','complete','reconcile') OR transition_at IS NULL THEN
    RAISE EXCEPTION 'invalid visual QA transition request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO execution FROM public.qa_executions qe
    WHERE qe.id=p_execution_id AND qe.work_item_id=work_id FOR UPDATE;
  SELECT status INTO run_status FROM public.loop_task_runs WHERE id=execution.qa_run_id AND work_item_id=work_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running'
    OR execution.capability_consumed_at IS NOT NULL OR execution.capability_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'visual QA transition execution authority mismatch' USING ERRCODE='23514';
  END IF;
  IF (transition_name IN ('claim','complete') OR (transition_name='reconcile' AND raw_capability IS NOT NULL))
    AND (raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
      OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
      OR execution.capability_expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'invalid or expired visual QA raw capability' USING ERRCODE='28000';
  END IF;
  IF (transition_name='claim' AND run_status IS DISTINCT FROM 'running')
    OR (transition_name='complete' AND run_status IS DISTINCT FROM 'succeeded')
    OR (transition_name='reconcile' AND run_status IS DISTINCT FROM 'failed') THEN
    RAISE EXCEPTION 'visual QA transition run authority mismatch' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.qa_work_item_transition_authorities
    (backend_pid,transaction_id,work_item_id,execution_id,transition,capability_proof)
    VALUES(pg_backend_pid(),txid_current(),work_id,p_execution_id,transition_name,
      CASE WHEN raw_capability IS NOT NULL THEN raw_capability ELSE NULL END);
  UPDATE public.work_items SET
    status=CASE transition_name WHEN 'claim' THEN 'in_progress' WHEN 'complete' THEN 'done' ELSE 'failed' END,
    started_at=CASE WHEN transition_name='claim' THEN coalesce(started_at,transition_at) ELSE started_at END,
    completed_at=CASE WHEN transition_name='claim' THEN completed_at ELSE transition_at END,
    updated_at=transition_at,
    payload=payload||CASE transition_name
      WHEN 'claim' THEN jsonb_build_object('dispatch_state','in_progress','qa_execution_id',p_execution_id::text)
      WHEN 'complete' THEN jsonb_build_object('dispatch_state','completed','dispatch_completed_at',transition_at::text)
      ELSE jsonb_build_object('dispatch_state','failed','dispatch_completed_at',transition_at::text) END
    WHERE id=work_id AND ((transition_name='claim' AND status='ready') OR (transition_name IN ('complete','reconcile') AND status='in_progress'));
  GET DIAGNOSTICS changed=ROW_COUNT;
  DELETE FROM public.qa_work_item_transition_authorities a WHERE a.backend_pid=pg_backend_pid()
    AND a.transaction_id=txid_current() AND a.work_item_id=work_id;
  RETURN changed=1;
END $body$;
REVOKE ALL ON FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) FROM PUBLIC;
ALTER FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.transition_visual_qa_work_item(uuid,uuid,text,timestamptz,text) FROM aipaths_mc_app;

-- A claim is accepted only when the exact versioned envelope was signed by the
-- server-held key and every envelope field still matches locked database state.
CREATE FUNCTION public.claim_visual_qa_execution(envelope jsonb,signature text,raw_capability text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE key_material bytea; DECLARE row_data record; DECLARE claim_time timestamptz; DECLARE expires_time timestamptz;
DECLARE changed integer; DECLARE execution_id uuid; DECLARE work_id uuid; DECLARE run_id uuid;
BEGIN
  IF jsonb_typeof(envelope) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(envelope) key) IS DISTINCT FROM
      ARRAY['base_sha','capability_expires_at','capability_hash','claimed_at','execution_attempt_id','execution_id',
        'implementer_session_id','loop_id','plan_hash','plan_revision_id','policy_hash','qa_run_id','qa_session_id',
        'quality_cycle','repository_id','reviewer_session_id','target_run_id','target_sha','task_id','version','work_item_id']
    OR envelope->>'version' IS DISTINCT FROM 'qa_claim_v1'
    OR jsonb_typeof(envelope->'quality_cycle') IS DISTINCT FROM 'number'
    OR envelope->>'quality_cycle' !~ '^[1-3]$'
    OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR envelope->>'capability_hash' !~ '^[0-9a-f]{64}$'
    OR encode(public.digest(convert_to(raw_capability,'UTF8'),'sha256'),'hex') IS DISTINCT FROM envelope->>'capability_hash'
    OR EXISTS (SELECT 1 FROM jsonb_each(envelope) e WHERE e.key<>'quality_cycle' AND jsonb_typeof(e.value) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'invalid signed visual QA claim envelope' USING ERRCODE='22023';
  END IF;
  SELECT hmac_key INTO key_material FROM public.qa_authority_secrets WHERE singleton=true;
  IF key_material IS NULL OR encode(public.hmac(convert_to(public.qa_jsonb_canonical(envelope),'UTF8'),key_material,'sha256'),'hex')
      IS DISTINCT FROM signature THEN
    RAISE EXCEPTION 'invalid visual QA claim signature' USING ERRCODE='28000';
  END IF;
  claim_time:=(envelope->>'claimed_at')::timestamptz; expires_time:=(envelope->>'capability_expires_at')::timestamptz;
  IF envelope->>'claimed_at' IS DISTINCT FROM to_char(claim_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR envelope->>'capability_expires_at' IS DISTINCT FROM to_char(expires_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR expires_time IS DISTINCT FROM claim_time+interval '90 minutes'
    OR claim_time NOT BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'invalid visual QA claim timestamp binding' USING ERRCODE='22023';
  END IF;
  execution_id:=(envelope->>'execution_id')::uuid; work_id:=(envelope->>'work_item_id')::uuid; run_id:=(envelope->>'qa_run_id')::uuid;
  SELECT r.id qa_run_id,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,r.quality_cycle,
    r.repository_id,r.base_sha,r.status run_status,wi.status work_status,wi.payload,t.status task_status,t.metadata,
    p.id plan_revision_id,p.content_hash plan_hash,p.status revision_status,l.id loop_id,l.status loop_status,l.current_plan_revision_id,
    impl.status implementation_status,impl.run_role implementation_role,impl.artifact_sha implementation_sha,
    impl.server_session_id implementer_session_id,d.reviewer_session_id,d.reviewed_sha
    INTO row_data FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id
    JOIN public.loop_tasks t ON t.id=r.task_id JOIN public.loop_stages s ON s.id=t.stage_id
    JOIN public.loop_plan_revisions p ON p.id=s.plan_revision_id JOIN public.loops l ON l.id=p.loop_id
    JOIN public.loop_task_runs impl ON impl.id=r.target_run_id AND impl.task_id=r.task_id
    JOIN public.loop_task_reviews d ON d.task_id=r.task_id AND d.task_run_id=impl.id AND d.quality_cycle=r.quality_cycle
      AND d.status='approved' AND d.reviewed_sha=r.target_sha
    WHERE r.id=run_id AND wi.id=work_id FOR UPDATE OF r,wi,t,l;
  IF row_data.qa_run_id IS NULL OR row_data.run_status IS DISTINCT FROM 'queued' OR row_data.work_status IS DISTINCT FROM 'ready'
    OR row_data.task_status IS DISTINCT FROM 'qa_pending' OR row_data.loop_status IS DISTINCT FROM 'in_progress'
    OR row_data.revision_status IS DISTINCT FROM 'approved' OR row_data.current_plan_revision_id IS DISTINCT FROM row_data.plan_revision_id
    OR row_data.implementation_role IS DISTINCT FROM 'implementation' OR row_data.implementation_status IS DISTINCT FROM 'succeeded'
    OR row_data.implementation_sha IS DISTINCT FROM row_data.target_sha OR row_data.reviewed_sha IS DISTINCT FROM row_data.target_sha
    OR row_data.implementer_session_id IS NULL OR row_data.reviewer_session_id IS NULL
    OR row_data.implementer_session_id IS NOT DISTINCT FROM row_data.reviewer_session_id
    OR envelope->>'task_id' IS DISTINCT FROM row_data.task_id::text
    OR envelope->>'work_item_id' IS DISTINCT FROM row_data.work_item_id::text
    OR envelope->>'execution_attempt_id' IS DISTINCT FROM row_data.execution_attempt_id::text
    OR envelope->>'target_run_id' IS DISTINCT FROM row_data.target_run_id::text
    OR envelope->>'target_sha' IS DISTINCT FROM row_data.target_sha
    OR envelope->>'quality_cycle' IS DISTINCT FROM row_data.quality_cycle::text
    OR envelope->>'repository_id' IS DISTINCT FROM row_data.repository_id::text
    OR envelope->>'base_sha' IS DISTINCT FROM row_data.base_sha
    OR envelope->>'plan_revision_id' IS DISTINCT FROM row_data.plan_revision_id::text
    OR envelope->>'plan_hash' IS DISTINCT FROM row_data.plan_hash
    OR envelope->>'loop_id' IS DISTINCT FROM row_data.loop_id::text
    OR envelope->>'implementer_session_id' IS DISTINCT FROM row_data.implementer_session_id
    OR envelope->>'reviewer_session_id' IS DISTINCT FROM row_data.reviewer_session_id
    OR envelope->>'policy_hash' IS DISTINCT FROM row_data.payload->>'policy_hash'
    OR row_data.payload->>'execution_attempt_id' IS DISTINCT FROM row_data.execution_attempt_id::text
    OR row_data.payload->>'target_run_id' IS DISTINCT FROM row_data.target_run_id::text
    OR row_data.payload->>'target_sha' IS DISTINCT FROM row_data.target_sha
    OR row_data.payload->'qa_policy' IS DISTINCT FROM row_data.metadata->'qa_policy'
    OR NOT public.qa_policy_is_valid(row_data.payload->'qa_policy')
    OR row_data.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
    OR envelope->>'policy_hash' IS DISTINCT FROM public.qa_jsonb_sha256(row_data.payload->'qa_policy') THEN
    RAISE EXCEPTION 'signed visual QA claim binding mismatch' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.qa_executions(id,qa_run_id,task_id,work_item_id,execution_attempt_id,target_run_id,target_sha,
    policy_hash,status,capability_hash,capability_expires_at,qa_session_id,claimed_at,heartbeat_at,created_at,updated_at)
  VALUES(execution_id,row_data.qa_run_id,row_data.task_id,row_data.work_item_id,row_data.execution_attempt_id,row_data.target_run_id,
    row_data.target_sha,envelope->>'policy_hash','running',decode(envelope->>'capability_hash','hex'),expires_time,
    envelope->>'qa_session_id',claim_time,claim_time,claim_time,claim_time);
  UPDATE public.loop_task_runs SET status='running',started_at=coalesce(started_at,claim_time),updated_at=claim_time
    WHERE id=run_id AND status='queued';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR NOT public.transition_visual_qa_work_item(work_id,execution_id,'claim',claim_time,raw_capability) THEN
    RAISE EXCEPTION 'visual QA claim concurrent conflict' USING ERRCODE='40001';
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
  RAISE EXCEPTION 'invalid signed visual QA claim envelope' USING ERRCODE='22023';
END $body$;
ALTER FUNCTION public.claim_visual_qa_execution(jsonb,text,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.claim_visual_qa_execution(jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_visual_qa_execution(jsonb,text,text) TO aipaths_mc_app;

CREATE FUNCTION public.heartbeat_visual_qa_execution(p_execution_id uuid,raw_capability text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE beat timestamptz; DECLARE run_data record;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,
    wi.status work_status,wi.payload INTO run_data FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id
    WHERE r.id=execution.qa_run_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR execution.capability_expires_at<=clock_timestamp()
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
    OR run_data.run_status IS DISTINCT FROM 'running' OR run_data.work_status IS DISTINCT FROM 'in_progress'
    OR run_data.task_id IS DISTINCT FROM execution.task_id OR run_data.work_item_id IS DISTINCT FROM execution.work_item_id
    OR run_data.execution_attempt_id IS DISTINCT FROM execution.execution_attempt_id
    OR run_data.target_run_id IS DISTINCT FROM execution.target_run_id OR run_data.target_sha IS DISTINCT FROM execution.target_sha
    OR run_data.payload->>'policy_hash' IS DISTINCT FROM execution.policy_hash THEN
    RAISE EXCEPTION 'invalid or expired visual QA heartbeat capability/binding' USING ERRCODE='28000';
  END IF;
  beat:=clock_timestamp();
  UPDATE public.qa_executions SET heartbeat_at=beat,updated_at=beat WHERE id=p_execution_id;
  RETURN beat;
END $body$;
ALTER FUNCTION public.heartbeat_visual_qa_execution(uuid,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.heartbeat_visual_qa_execution(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_visual_qa_execution(uuid,text) TO aipaths_mc_app;

CREATE FUNCTION public.complete_visual_qa_execution(p_execution_id uuid,p_attempt_id uuid,p_target_sha text,p_policy_hash text,
  p_session_id text,raw_capability text,p_result jsonb,p_result_hash text,p_finished_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE run_data record; DECLARE terminal_status text; DECLARE result_error text;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,r.server_session_id,wi.status work_status,wi.payload INTO run_data
    FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id WHERE r.id=execution.qa_run_id;
  terminal_status:=CASE WHEN p_result->>'verdict'='infrastructure_failure' THEN 'failed' ELSE 'succeeded' END;
  result_error:=CASE WHEN p_result->'error'='null'::jsonb THEN NULL ELSE p_result->>'error' END;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR p_finished_at IS NULL
    OR execution.capability_expires_at<=clock_timestamp() OR p_finished_at>execution.capability_expires_at
    OR p_finished_at<execution.claimed_at OR p_finished_at>clock_timestamp()+interval '1 minute'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
    OR p_attempt_id IS DISTINCT FROM execution.execution_attempt_id OR p_target_sha IS DISTINCT FROM execution.target_sha
    OR p_policy_hash IS DISTINCT FROM execution.policy_hash OR p_session_id IS DISTINCT FROM execution.qa_session_id
    OR run_data.payload->>'execution_attempt_id' IS DISTINCT FROM execution.execution_attempt_id::text
    OR run_data.payload->>'target_sha' IS DISTINCT FROM execution.target_sha
    OR run_data.payload->>'policy_hash' IS DISTINCT FROM execution.policy_hash
    OR NOT public.qa_result_is_valid(p_result,execution.target_sha,run_data.payload->'qa_policy')
    OR p_result_hash IS DISTINCT FROM public.qa_jsonb_sha256(p_result)
    OR run_data.run_status IS DISTINCT FROM terminal_status OR run_data.server_session_id IS DISTINCT FROM execution.qa_session_id
    OR run_data.work_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'visual QA completion capability/immutable binding mismatch' USING ERRCODE='28000';
  END IF;
  IF NOT public.transition_visual_qa_work_item(execution.work_item_id,p_execution_id,
      CASE WHEN terminal_status='failed' THEN 'reconcile' ELSE 'complete' END,p_finished_at,raw_capability) THEN
    RAISE EXCEPTION 'visual QA completion work transition conflict' USING ERRCODE='40001';
  END IF;
  UPDATE public.qa_executions SET status=terminal_status,error=result_error,capability_consumed_at=p_finished_at,
    finished_at=p_finished_at,result=p_result,result_hash=p_result_hash,heartbeat_at=p_finished_at,updated_at=p_finished_at
    WHERE id=p_execution_id AND status='running';
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamptz) TO aipaths_mc_app;

CREATE FUNCTION public.reconcile_visual_qa_execution(p_execution_id uuid,p_reason text,p_finished_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE run_data record;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,wi.status work_status INTO run_data FROM public.loop_task_runs r
    JOIN public.work_items wi ON wi.id=r.work_item_id WHERE r.id=execution.qa_run_id;
  IF execution.id IS NULL OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR execution.heartbeat_at>=clock_timestamp()-interval '10 minutes'
    OR p_reason IS DISTINCT FROM 'qa_execution_stale_timeout' OR p_finished_at IS NULL
    OR run_data.run_status IS DISTINCT FROM 'failed' OR run_data.work_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'visual QA reconcile is not a stale running-to-failed transition' USING ERRCODE='23514';
  END IF;
  IF NOT public.transition_visual_qa_work_item(execution.work_item_id,p_execution_id,'reconcile',p_finished_at,NULL) THEN
    RAISE EXCEPTION 'visual QA reconcile work transition conflict' USING ERRCODE='40001';
  END IF;
  UPDATE public.qa_executions SET status='failed',error=p_reason,finished_at=p_finished_at,
    capability_revoked_at=p_finished_at,heartbeat_at=p_finished_at,updated_at=p_finished_at WHERE id=p_execution_id AND status='running';
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_visual_qa_execution(uuid,text,timestamptz) TO aipaths_mc_app;

CREATE OR REPLACE FUNCTION public.reject_terminal_loop_quality_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
BEGIN
  IF TG_TABLE_NAME='loop_task_runs' AND OLD.status IN ('succeeded','failed','cancelled') AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task run is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='loop_task_reviews' THEN
    IF TG_OP='DELETE' AND OLD.status='pending' THEN RAISE EXCEPTION 'Pending Loop task review cannot be deleted' USING ERRCODE='23514';
    ELSIF OLD.status<>'pending' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal Loop task review is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='reviewer_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal reviewer execution is immutable' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='qa_executions' AND OLD.status<>'running' AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN RAISE EXCEPTION 'Terminal QA execution is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$;
CREATE TRIGGER qa_executions_terminal_immutable BEFORE UPDATE OR DELETE ON public.qa_executions FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_loop_quality_mutation();

-- Ordinary application SQL keeps existing Mission Control behavior but cannot
-- read key material or write/re-key/truncate QA authority rows. QA mutations are
-- exposed only through the exact entry points above.
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO aipaths_mc_app;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO aipaths_mc_app;
DO $default_privileges$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO aipaths_mc_app',current_user);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO aipaths_mc_app',current_user);
END $default_privileges$;
REVOKE ALL ON public.qa_authority_secrets,public.qa_work_item_transition_authorities FROM aipaths_mc_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.qa_executions FROM aipaths_mc_app;
GRANT SELECT ON public.qa_executions TO aipaths_mc_app;

ALTER FUNCTION public.qa_jsonb_canonical(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_jsonb_sha256(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_text_is_valid(text,integer) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_target_url_is_valid(text) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_policy_is_valid(jsonb) OWNER TO aipaths_mc_qa_owner;
ALTER FUNCTION public.qa_result_is_valid(jsonb,text,jsonb) OWNER TO aipaths_mc_qa_owner;
GRANT EXECUTE ON FUNCTION public.qa_jsonb_canonical(jsonb),public.qa_jsonb_sha256(jsonb),
  public.qa_text_is_valid(text,integer),public.qa_target_url_is_valid(text),public.qa_policy_is_valid(jsonb),
  public.qa_result_is_valid(jsonb,text,jsonb) TO aipaths_mc_app;
COMMIT;
