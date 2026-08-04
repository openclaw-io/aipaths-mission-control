BEGIN;

ALTER TABLE public.qa_executions
  ADD COLUMN IF NOT EXISTS pid integer CHECK (pid IS NULL OR pid>0),
  ADD COLUMN IF NOT EXISTS runner_birth_token text,
  ADD COLUMN IF NOT EXISTS planner_session_id text;

GRANT SELECT,INSERT ON public.loop_evidence TO aipaths_mc_qa_owner;

-- Migration 035 is already applied on existing installations. Rebind the
-- signed claim contract here so the V1 runtime's 90-minute capability TTL is
-- effective on upgrades as well as fresh schema installs.
CREATE OR REPLACE FUNCTION public.claim_visual_qa_execution(envelope jsonb,signature text,raw_capability text) RETURNS boolean
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

-- Acquire the qa_executions row lock through fixed SECURITY DEFINER authority;
-- the app role intentionally has no direct UPDATE privilege on this table.
CREATE OR REPLACE FUNCTION public.lock_visual_qa_execution(execution_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
BEGIN
  PERFORM 1 FROM public.qa_executions WHERE id=execution_id FOR UPDATE;
  RETURN FOUND;
END $body$;
ALTER FUNCTION public.lock_visual_qa_execution(uuid) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.lock_visual_qa_execution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_visual_qa_execution(uuid) TO aipaths_mc_app;

-- Tighten evidence coverage for installations where migration 035 is already applied.
CREATE OR REPLACE FUNCTION public.qa_result_is_valid(value jsonb, expected_sha text, policy jsonb) RETURNS boolean
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

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_runner_identity_check') THEN
    ALTER TABLE public.qa_executions ADD CONSTRAINT qa_executions_runner_identity_check CHECK (
      (pid IS NULL AND runner_birth_token IS NULL) OR (pid IS NOT NULL AND runner_birth_token ~
        '^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_planner_session_format_check') THEN
    ALTER TABLE public.qa_executions ADD CONSTRAINT qa_executions_planner_session_format_check
      CHECK (planner_session_id IS NULL OR planner_session_id ~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_planner_session_unique') THEN
    ALTER TABLE public.qa_executions ADD CONSTRAINT qa_executions_planner_session_unique UNIQUE(planner_session_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_completion_planner_bound_check') THEN
    ALTER TABLE public.qa_executions ADD CONSTRAINT qa_executions_completion_planner_bound_check
      CHECK (status='running' OR capability_revoked_at IS NOT NULL OR planner_session_id IS NOT NULL
        OR (status='failed' AND result->>'verdict'='infrastructure_failure'));
  END IF;
END $body$;

CREATE OR REPLACE FUNCTION public.attach_visual_qa_execution_pid(p_execution_id uuid,p_pid integer,p_runner_birth_token text,raw_capability text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE beat timestamptz;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  IF execution.id IS NULL OR p_pid IS NULL OR p_pid<=0 OR p_runner_birth_token IS NULL
    OR p_runner_birth_token !~ '^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash THEN
    RAISE EXCEPTION 'invalid visual QA pid capability/binding' USING ERRCODE='28000';
  END IF;
  IF execution.status='running' THEN
    IF execution.capability_consumed_at IS NOT NULL OR execution.capability_revoked_at IS NOT NULL
      OR execution.capability_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'invalid or expired visual QA pid capability/binding' USING ERRCODE='28000';
    END IF;
    beat:=clock_timestamp();
    UPDATE public.qa_executions SET pid=p_pid,runner_birth_token=p_runner_birth_token,heartbeat_at=beat,updated_at=beat
      WHERE id=p_execution_id AND status='running' AND pid IS NULL AND runner_birth_token IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'visual QA runner identity already attached' USING ERRCODE='23514'; END IF;
    RETURN 'running';
  END IF;
  IF execution.status IN ('succeeded','failed','blocked') THEN RETURN execution.status; END IF;
  RAISE EXCEPTION 'invalid visual QA pid state' USING ERRCODE='23514';
END $body$;

ALTER FUNCTION public.attach_visual_qa_execution_pid(uuid,integer,text,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.attach_visual_qa_execution_pid(uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_visual_qa_execution_pid(uuid,integer,text,text) TO aipaths_mc_app;

CREATE OR REPLACE FUNCTION public.bind_visual_qa_planner_session(p_execution_id uuid,p_planner_session_id text,raw_capability text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE beat timestamptz; DECLARE run_data record;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  SELECT r.status run_status,r.task_id,r.work_item_id,r.execution_attempt_id,r.target_run_id,r.target_sha,
    wi.status work_status,wi.payload INTO run_data FROM public.loop_task_runs r JOIN public.work_items wi ON wi.id=r.work_item_id
    WHERE r.id=execution.qa_run_id;
  IF execution.id IS NULL OR p_planner_session_id IS NULL OR p_planner_session_id !~ '^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$'
    OR raw_capability IS NULL OR raw_capability !~ '^[A-Za-z0-9_-]{43}$'
    OR public.digest(convert_to(raw_capability,'UTF8'),'sha256') IS DISTINCT FROM execution.capability_hash
    OR execution.status IS DISTINCT FROM 'running' OR execution.capability_consumed_at IS NOT NULL
    OR execution.capability_revoked_at IS NOT NULL OR execution.capability_expires_at<=clock_timestamp()
    OR run_data.run_status IS DISTINCT FROM 'running' OR run_data.work_status IS DISTINCT FROM 'in_progress'
    OR run_data.task_id IS DISTINCT FROM execution.task_id OR run_data.work_item_id IS DISTINCT FROM execution.work_item_id
    OR run_data.execution_attempt_id IS DISTINCT FROM execution.execution_attempt_id
    OR run_data.target_run_id IS DISTINCT FROM execution.target_run_id OR run_data.target_sha IS DISTINCT FROM execution.target_sha
    OR run_data.payload->>'policy_hash' IS DISTINCT FROM execution.policy_hash THEN
    RAISE EXCEPTION 'invalid visual QA planner session capability/binding' USING ERRCODE='28000';
  END IF;
  IF execution.planner_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'visual QA planner session already bound and immutable' USING ERRCODE='23514';
  END IF;
  beat:=clock_timestamp();
  UPDATE public.qa_executions SET planner_session_id=p_planner_session_id,heartbeat_at=beat,updated_at=beat
    WHERE id=p_execution_id AND status='running' AND planner_session_id IS NULL;
  RETURN FOUND;
END $body$;

ALTER FUNCTION public.bind_visual_qa_planner_session(uuid,text,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.bind_visual_qa_planner_session(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_visual_qa_planner_session(uuid,text,text) TO aipaths_mc_app;

CREATE OR REPLACE FUNCTION public.complete_visual_qa_execution(p_execution_id uuid,p_attempt_id uuid,p_target_sha text,p_policy_hash text,
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
    OR execution.capability_revoked_at IS NOT NULL
    OR (execution.planner_session_id IS NULL AND terminal_status<>'failed') OR p_finished_at IS NULL
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
    RAISE EXCEPTION 'visual QA completion capability/immutable planner binding mismatch' USING ERRCODE='28000';
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_evidence_visual_qa_uri ON public.loop_evidence(uri)
  WHERE uri LIKE 'visual-qa://%';

CREATE OR REPLACE FUNCTION public.guard_visual_qa_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
DECLARE old_visual boolean:=false; DECLARE new_visual boolean:=false;
BEGIN
  IF TG_OP<>'INSERT' THEN
    old_visual:=coalesce(OLD.kind LIKE 'visual_qa_%',false) OR coalesce(OLD.uri LIKE 'visual-qa://%',false);
  END IF;
  IF TG_OP<>'DELETE' THEN
    new_visual:=coalesce(NEW.kind LIKE 'visual_qa_%',false) OR coalesce(NEW.uri LIKE 'visual-qa://%',false);
  END IF;
  IF NOT old_visual AND NOT new_visual THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Visual QA evidence is terminal and immutable' USING ERRCODE='23514';
  END IF;
  IF current_user IS DISTINCT FROM 'aipaths_mc_qa_owner' THEN
    RAISE EXCEPTION 'Visual QA evidence requires SECURITY DEFINER authority' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.qa_executions execution
    CROSS JOIN LATERAL jsonb_array_elements(execution.result->'evidence') authoritative(descriptor)
    WHERE execution.id::text IS NOT DISTINCT FROM NEW.metadata->>'qa_execution_id'
      AND execution.task_id IS NOT DISTINCT FROM NEW.task_id
      AND execution.task_id::text IS NOT DISTINCT FROM NEW.metadata->>'task_id'
      AND execution.qa_run_id IS NOT DISTINCT FROM NEW.task_run_id
      AND execution.qa_run_id::text IS NOT DISTINCT FROM NEW.metadata->>'qa_run_id'
      AND execution.work_item_id::text IS NOT DISTINCT FROM NEW.metadata->>'work_item_id'
      AND execution.execution_attempt_id::text IS NOT DISTINCT FROM NEW.metadata->>'execution_attempt_id'
      AND execution.policy_hash IS NOT DISTINCT FROM NEW.metadata->>'policy_hash'
      AND execution.result_hash IS NOT DISTINCT FROM NEW.metadata->>'result_hash'
      AND execution.result->>'tested_sha' IS NOT DISTINCT FROM NEW.metadata->>'tested_sha'
      AND execution.planner_session_id IS NOT DISTINCT FROM NEW.metadata->>'planner_session_id'
      AND execution.status IN ('succeeded','failed')
      AND execution.capability_consumed_at IS NOT NULL AND execution.capability_revoked_at IS NULL
      AND execution.finished_at IS NOT NULL AND NEW.created_at IS NOT DISTINCT FROM execution.finished_at
      AND execution.result IS NOT NULL AND execution.result_hash IS NOT NULL
      AND execution.result_hash=public.qa_jsonb_sha256(execution.result)
      AND NEW.content IS NULL AND NEW.metadata->'schema_version'='1'::jsonb
      AND NEW.metadata->'descriptor'=authoritative.descriptor
      AND NEW.kind='visual_qa_'||(authoritative.descriptor->>'kind')
      AND NEW.uri='visual-qa://'||(authoritative.descriptor->>'storage_ref')
  ) THEN
    RAISE EXCEPTION 'Visual QA evidence authority/result binding mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
ALTER FUNCTION public.guard_visual_qa_evidence() OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.guard_visual_qa_evidence() FROM PUBLIC,aipaths_mc_app;
DROP TRIGGER IF EXISTS visual_qa_evidence_guard ON public.loop_evidence;
CREATE TRIGGER visual_qa_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.loop_evidence
  FOR EACH ROW EXECUTE FUNCTION public.guard_visual_qa_evidence();

CREATE OR REPLACE FUNCTION public.persist_visual_qa_evidence(p_execution_id uuid,p_result_hash text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE execution public.qa_executions%ROWTYPE; DECLARE expected integer; DECLARE persisted integer; DECLARE valid integer;
BEGIN
  SELECT * INTO execution FROM public.qa_executions WHERE id=p_execution_id FOR UPDATE;
  IF execution.id IS NULL OR execution.status NOT IN ('succeeded','failed')
    OR execution.capability_consumed_at IS NULL OR execution.capability_revoked_at IS NOT NULL
    OR execution.finished_at IS NULL OR execution.result IS NULL OR execution.result_hash IS NULL
    OR p_result_hash IS DISTINCT FROM execution.result_hash
    OR execution.result_hash IS DISTINCT FROM public.qa_jsonb_sha256(execution.result) THEN
    RAISE EXCEPTION 'Visual QA evidence terminal result authority mismatch' USING ERRCODE='23514';
  END IF;
  expected:=jsonb_array_length(execution.result->'evidence');
  SELECT count(*)::integer INTO persisted FROM public.loop_evidence evidence
    WHERE evidence.kind LIKE 'visual_qa_%' AND evidence.metadata->>'qa_execution_id'=execution.id::text;
  IF persisted>0 THEN
    SELECT count(*)::integer INTO valid FROM public.loop_evidence evidence
    CROSS JOIN LATERAL jsonb_array_elements(execution.result->'evidence') authoritative(descriptor)
    WHERE evidence.metadata->>'qa_execution_id'=execution.id::text
      AND evidence.task_id=execution.task_id AND evidence.task_run_id=execution.qa_run_id
      AND evidence.metadata->>'task_id'=execution.task_id::text
      AND evidence.metadata->>'qa_run_id'=execution.qa_run_id::text
      AND evidence.metadata->>'work_item_id'=execution.work_item_id::text
      AND evidence.metadata->>'execution_attempt_id'=execution.execution_attempt_id::text
      AND evidence.metadata->>'policy_hash'=execution.policy_hash
      AND evidence.metadata->>'result_hash'=execution.result_hash
      AND evidence.metadata->>'tested_sha'=execution.result->>'tested_sha'
      AND evidence.metadata->>'planner_session_id' IS NOT DISTINCT FROM execution.planner_session_id
      AND evidence.content IS NULL AND evidence.created_at=execution.finished_at
      AND evidence.metadata->'schema_version'='1'::jsonb
      AND evidence.metadata->'descriptor'=authoritative.descriptor
      AND evidence.kind='visual_qa_'||(authoritative.descriptor->>'kind')
      AND evidence.uri='visual-qa://'||(authoritative.descriptor->>'storage_ref');
    IF persisted<>expected OR valid<>expected THEN
      RAISE EXCEPTION 'Existing Visual QA evidence authority/result binding mismatch' USING ERRCODE='23514';
    END IF;
    RETURN persisted;
  END IF;
  INSERT INTO public.loop_evidence(task_id,task_run_id,kind,uri,content,metadata,created_at)
  SELECT execution.task_id,execution.qa_run_id,'visual_qa_'||(authoritative.descriptor->>'kind'),
    'visual-qa://'||(authoritative.descriptor->>'storage_ref'),NULL,
    jsonb_build_object(
      'schema_version',1,
      'qa_execution_id',execution.id,
      'planner_session_id',execution.planner_session_id,
      'task_id',execution.task_id,
      'qa_run_id',execution.qa_run_id,
      'work_item_id',execution.work_item_id,
      'execution_attempt_id',execution.execution_attempt_id,
      'policy_hash',execution.policy_hash,
      'result_hash',execution.result_hash,
      'tested_sha',execution.result->>'tested_sha',
      'descriptor',authoritative.descriptor
    ),execution.finished_at
  FROM jsonb_array_elements(execution.result->'evidence') authoritative(descriptor);
  GET DIAGNOSTICS persisted=ROW_COUNT;
  IF persisted<>expected THEN
    RAISE EXCEPTION 'Visual QA evidence persistence cardinality mismatch' USING ERRCODE='23514';
  END IF;
  RETURN persisted;
END $body$;
ALTER FUNCTION public.persist_visual_qa_evidence(uuid,text) OWNER TO aipaths_mc_qa_owner;
REVOKE ALL ON FUNCTION public.persist_visual_qa_evidence(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.persist_visual_qa_evidence(uuid,text) TO aipaths_mc_app;

COMMIT;
