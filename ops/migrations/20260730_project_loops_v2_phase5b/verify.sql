BEGIN;
SET TRANSACTION READ ONLY;
DO $$
DECLARE missing text;
DECLARE definition text;
BEGIN
  SELECT string_agg(name,', ') INTO missing FROM (VALUES
    ('qa_executions',to_regclass('public.qa_executions') IS NOT NULL),
    ('qa_authority_secrets',to_regclass('public.qa_authority_secrets') IS NOT NULL),
    ('qa_work_item_transition_authorities',to_regclass('public.qa_work_item_transition_authorities') IS NOT NULL),
    ('qa_jsonb_canonical',to_regprocedure('public.qa_jsonb_canonical(jsonb)') IS NOT NULL),
    ('qa_jsonb_sha256',to_regprocedure('public.qa_jsonb_sha256(jsonb)') IS NOT NULL),
    ('qa_policy_is_valid',to_regprocedure('public.qa_policy_is_valid(jsonb)') IS NOT NULL),
    ('qa_result_is_valid',to_regprocedure('public.qa_result_is_valid(jsonb,text,jsonb)') IS NOT NULL),
    ('lock_visual_qa_execution',to_regprocedure('public.lock_visual_qa_execution(uuid)') IS NOT NULL),
    ('transition_visual_qa_work_item',to_regprocedure('public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)') IS NOT NULL),
    ('attach_visual_qa_execution_pid',to_regprocedure('public.attach_visual_qa_execution_pid(uuid,integer,text,text)') IS NOT NULL),
    ('bind_visual_qa_planner_session',to_regprocedure('public.bind_visual_qa_planner_session(uuid,text,text)') IS NOT NULL),
    ('persist_visual_qa_evidence',to_regprocedure('public.persist_visual_qa_evidence(uuid,text)') IS NOT NULL),
    ('guard_visual_qa_evidence',to_regprocedure('public.guard_visual_qa_evidence()') IS NOT NULL),
    ('guard_visual_qa_work_item',to_regprocedure('public.guard_visual_qa_work_item()') IS NOT NULL),
    ('idx_loop_evidence_visual_qa_uri',to_regclass('public.idx_loop_evidence_visual_qa_uri') IS NOT NULL),
    ('idx_qa_executions_stale',to_regclass('public.idx_qa_executions_stale') IS NOT NULL),
    ('validate_qa_execution_integrity',to_regprocedure('public.validate_qa_execution_integrity()') IS NOT NULL),
    ('qa_executions_integrity',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='qa_executions_integrity' AND tgrelid='public.qa_executions'::regclass AND NOT tgisinternal)),
    ('visual_qa_work_items_guard',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='visual_qa_work_items_guard' AND tgrelid='public.work_items'::regclass AND NOT tgisinternal)),
    ('visual_qa_evidence_guard',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='visual_qa_evidence_guard' AND tgrelid='public.loop_evidence'::regclass AND NOT tgisinternal)),
    ('qa_executions_terminal_immutable',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='qa_executions_terminal_immutable' AND tgrelid='public.qa_executions'::regclass AND NOT tgisinternal))
  ) AS checks(name,present) WHERE NOT present;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Phase 5B verification missing: %',missing; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_app' AND rolcanlogin AND NOT rolsuper
      AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aipaths_mc_qa_owner' AND NOT rolcanlogin AND NOT rolsuper
      AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) THEN
    RAISE EXCEPTION 'Phase 5B role attributes are not least privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))
         OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('aipaths_mc_app','aipaths_mc_qa_owner'))) THEN
    RAISE EXCEPTION 'Phase 5B roles have a membership edge; exact zero is required';
  END IF;
  IF has_schema_privilege('aipaths_mc_app','public','CREATE')
    OR NOT has_schema_privilege('aipaths_mc_app','public','USAGE')
    OR NOT has_schema_privilege('aipaths_mc_qa_owner','public','USAGE')
    OR EXISTS (SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) acl
      WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE') THEN
    RAISE EXCEPTION 'public schema must retain USAGE but deny CREATE to PUBLIC and aipaths_mc_app';
  END IF;

  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.qa_executions'::regclass) IS DISTINCT FROM 'aipaths_mc_qa_owner'
    OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.qa_authority_secrets'::regclass) IS DISTINCT FROM 'aipaths_mc_qa_owner'
    OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.qa_work_item_transition_authorities'::regclass) IS DISTINCT FROM 'aipaths_mc_qa_owner'
    OR (SELECT count(*) FROM public.qa_authority_secrets)<>1
    OR (SELECT octet_length(hmac_key) FROM public.qa_authority_secrets WHERE singleton=true) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'QA authority ownership/secret installation invalid';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_task_runs_run_role_check'
      AND pg_get_constraintdef(oid) LIKE '%qa%') THEN RAISE EXCEPTION 'QA run role constraint missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loop_tasks_status_check'
      AND pg_get_constraintdef(oid) LIKE '%qa_pending%') THEN RAISE EXCEPTION 'qa_pending task status missing'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='qa_executions'
      AND column_name='qa_session_id' AND is_nullable<>'NO')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass AND contype='u'
      AND pg_get_constraintdef(oid) LIKE '%qa_session_id%') THEN
    RAISE EXCEPTION 'QA server session uniqueness/not-null authority missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='qa_executions'
      AND column_name='runner_birth_token' AND is_nullable='YES')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_runner_identity_check'
      AND pg_get_constraintdef(oid) LIKE '%runner_birth_token%') THEN
    RAISE EXCEPTION 'QA runner birth identity column/constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='qa_executions'
      AND column_name='planner_session_id' AND is_nullable='YES')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_planner_session_format_check'
      AND pg_get_constraintdef(oid) LIKE '%planner_session_id%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_planner_session_unique')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.qa_executions'::regclass
      AND conname='qa_executions_completion_planner_bound_check'
      AND pg_get_constraintdef(oid) LIKE '%planner_session_id%') THEN
    RAISE EXCEPTION 'QA planner session audit column/constraints missing';
  END IF;

  SELECT pg_get_functiondef('public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)'::regprocedure) INTO definition;
  IF definition NOT ILIKE '%SECURITY DEFINER%' OR definition NOT LIKE '%qa_work_item_transition_authorities%'
    OR definition NOT LIKE '%raw_capability%' OR definition NOT LIKE '%capability_hash%'
    OR definition NOT LIKE '%FOR UPDATE%' OR definition NOT LIKE '%UPDATE public.work_items%'
    THEN RAISE EXCEPTION 'Atomic visual QA capability transition definition invalid'; END IF;
  SELECT pg_get_functiondef('public.guard_visual_qa_work_item()'::regprocedure) INTO definition;
  IF definition LIKE '%current_setting(%' OR definition NOT LIKE '%qa_work_item_transition_authorities%'
    OR definition NOT LIKE '%dedicated transition authority with valid capability%' OR definition NOT LIKE '%capability_proof%'
    THEN RAISE EXCEPTION 'Visual QA work guard definition invalid'; END IF;
  SELECT pg_get_functiondef('public.validate_qa_execution_integrity()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%qa_result_is_valid%' OR definition NOT LIKE '%IS DISTINCT FROM%'
    OR definition NOT LIKE '%QA execution session integrity mismatch%' THEN RAISE EXCEPTION 'QA integrity/result/session definition invalid'; END IF;
  SELECT pg_get_functiondef('public.attach_visual_qa_execution_pid(uuid,integer,text,text)'::regprocedure) INTO definition;
  IF definition NOT ILIKE '%SECURITY DEFINER%' OR definition NOT LIKE '%runner_birth_token%'
    OR definition NOT LIKE '%pid=p_pid%' OR definition NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'Visual QA runner birth identity attach definition invalid';
  END IF;
  SELECT pg_get_functiondef('public.bind_visual_qa_planner_session(uuid,text,text)'::regprocedure) INTO definition;
  IF definition NOT ILIKE '%SECURITY DEFINER%' OR definition NOT LIKE '%planner_session_id%'
    OR definition NOT LIKE '%raw_capability%' OR definition NOT LIKE '%capability_hash%'
    OR definition NOT LIKE '%FOR UPDATE%' OR definition NOT LIKE '%already bound and immutable%' THEN
    RAISE EXCEPTION 'Visual QA planner session bind definition invalid';
  END IF;
  SELECT pg_get_functiondef('public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamp with time zone)'::regprocedure) INTO definition;
  IF definition NOT LIKE '%planner_session_id IS NULL%' THEN
    RAISE EXCEPTION 'Visual QA completion must require planner session binding';
  END IF;
  SELECT pg_get_functiondef('public.persist_visual_qa_evidence(uuid,text)'::regprocedure) INTO definition;
  IF definition NOT ILIKE '%SECURITY DEFINER%' OR definition NOT LIKE '%FOR UPDATE%'
    OR definition NOT LIKE '%qa_jsonb_sha256%' OR definition NOT LIKE '%jsonb_array_elements%'
    OR definition NOT LIKE '%INSERT INTO public.loop_evidence%' OR definition NOT LIKE '%task_id%'
    OR definition NOT LIKE '%qa_run_id%' OR definition NOT LIKE '%result_hash%' THEN
    RAISE EXCEPTION 'Visual QA evidence persistence authority definition invalid';
  END IF;
  SELECT pg_get_functiondef('public.guard_visual_qa_evidence()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%current_user%'
    OR definition NOT LIKE '%terminal and immutable%' OR definition NOT LIKE '%authority/result binding mismatch%'
    OR definition NOT LIKE '%qa_jsonb_sha256%' OR definition NOT LIKE '%jsonb_array_elements%' THEN
    RAISE EXCEPTION 'Visual QA evidence guard definition invalid';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('claim_visual_qa_execution','heartbeat_visual_qa_execution',
        'attach_visual_qa_execution_pid','lock_visual_qa_execution','bind_visual_qa_planner_session','persist_visual_qa_evidence',
        'complete_visual_qa_execution','reconcile_visual_qa_execution','transition_visual_qa_work_item',
        'validate_qa_execution_integrity','guard_visual_qa_work_item')
      AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'aipaths_mc_qa_owner'
        OR NOT coalesce(p.proconfig,'{}'::text[]) @> ARRAY['search_path=pg_catalog, public'])) THEN
    RAISE EXCEPTION 'QA SECURITY DEFINER owner/search_path invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='guard_visual_qa_evidence' AND NOT p.prosecdef
        AND pg_get_userbyid(p.proowner)='aipaths_mc_qa_owner'
        AND coalesce(p.proconfig,'{}'::text[]) @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'Visual QA evidence invoker guard owner/search_path invalid';
  END IF;

  IF has_table_privilege('aipaths_mc_app','public.qa_authority_secrets','SELECT')
    OR has_table_privilege('aipaths_mc_app','public.qa_authority_secrets','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('aipaths_mc_app','public.qa_work_item_transition_authorities','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('aipaths_mc_app','public.qa_executions','INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('aipaths_mc_app','public.qa_executions','SELECT')
    OR NOT has_table_privilege('aipaths_mc_qa_owner','public.loop_evidence','SELECT,INSERT') THEN
    RAISE EXCEPTION 'Application QA table grants invalid';
  END IF;
  IF has_function_privilege('aipaths_mc_app','public.install_qa_authority_hmac_key(text)','EXECUTE')
    OR has_function_privilege('aipaths_mc_app','public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.claim_visual_qa_execution(jsonb,text,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.heartbeat_visual_qa_execution(uuid,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.attach_visual_qa_execution_pid(uuid,integer,text,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.lock_visual_qa_execution(uuid)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.bind_visual_qa_planner_session(uuid,text,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.persist_visual_qa_evidence(uuid,text)','EXECUTE')
    OR has_function_privilege('aipaths_mc_app','public.guard_visual_qa_evidence()','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.complete_visual_qa_execution(uuid,uuid,text,text,text,text,jsonb,text,timestamp with time zone)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.reconcile_visual_qa_execution(uuid,text,timestamp with time zone)','EXECUTE') THEN
    RAISE EXCEPTION 'Application QA function grants expose the wrong authority surface';
  END IF;

  IF (SELECT count(DISTINCT acl.privilege_type) FROM pg_default_acl defaults
      JOIN pg_roles owner ON owner.oid=defaults.defaclrole JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl JOIN pg_roles grantee ON grantee.oid=acl.grantee
      WHERE owner.rolname=current_user AND namespace.nspname='public' AND defaults.defaclobjtype='r'
        AND grantee.rolname='aipaths_mc_app' AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))<>4
    OR (SELECT count(DISTINCT acl.privilege_type) FROM pg_default_acl defaults
      JOIN pg_roles owner ON owner.oid=defaults.defaclrole JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl JOIN pg_roles grantee ON grantee.oid=acl.grantee
      WHERE owner.rolname=current_user AND namespace.nspname='public' AND defaults.defaclobjtype='S'
        AND grantee.rolname='aipaths_mc_app' AND acl.privilege_type IN ('USAGE','SELECT','UPDATE'))<>3 THEN
    RAISE EXCEPTION 'Application future table/sequence default privileges missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid IN ('public.qa_jsonb_canonical(jsonb)'::regprocedure,'public.qa_jsonb_sha256(jsonb)'::regprocedure,
        'public.qa_policy_is_valid(jsonb)'::regprocedure,'public.qa_result_is_valid(jsonb,text,jsonb)'::regprocedure,
        'public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)'::regprocedure,
        'public.attach_visual_qa_execution_pid(uuid,integer,text,text)'::regprocedure,
        'public.bind_visual_qa_planner_session(uuid,text,text)'::regprocedure,
        'public.persist_visual_qa_evidence(uuid,text)'::regprocedure,
        'public.guard_visual_qa_evidence()'::regprocedure,
        'public.validate_qa_execution_integrity()'::regprocedure,'public.guard_visual_qa_work_item()'::regprocedure)
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'PUBLIC function execution privilege remains'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.oid IN ('public.qa_executions'::regclass,'public.qa_authority_secrets'::regclass,
        'public.qa_work_item_transition_authorities'::regclass)
        AND acl.grantee=0) THEN RAISE EXCEPTION 'PUBLIC QA table privilege remains'; END IF;
  IF EXISTS (SELECT 1 FROM public.qa_work_item_transition_authorities) THEN RAISE EXCEPTION 'Leaked visual QA transition authority row'; END IF;
  IF EXISTS (SELECT 1 FROM public.loop_tasks WHERE metadata ? 'qa_policy'
      AND NOT public.qa_policy_is_valid(metadata->'qa_policy')) THEN
    RAISE EXCEPTION 'Malformed historical persisted QA policy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loop_task_runs qr LEFT JOIN public.loop_task_runs impl ON impl.id=qr.target_run_id
    LEFT JOIN public.loop_task_reviews d ON d.task_id=qr.task_id AND d.task_run_id=qr.target_run_id AND d.quality_cycle=qr.quality_cycle
      AND d.status='approved' AND d.reviewed_sha=qr.target_sha
    WHERE qr.run_role='qa' AND (impl.id IS NULL OR impl.task_id IS DISTINCT FROM qr.task_id OR impl.run_role IS DISTINCT FROM 'implementation'
      OR impl.status IS DISTINCT FROM 'succeeded' OR impl.quality_cycle IS DISTINCT FROM qr.quality_cycle
      OR impl.artifact_sha IS DISTINCT FROM qr.target_sha OR d.id IS NULL)
  ) THEN RAISE EXCEPTION 'Phase 5B QA target verification failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.qa_executions e JOIN public.loop_task_runs qr ON qr.id=e.qa_run_id
    JOIN public.loop_task_runs impl ON impl.id=e.target_run_id JOIN public.work_items wi ON wi.id=e.work_item_id
    WHERE qr.task_id IS DISTINCT FROM e.task_id OR qr.run_role IS DISTINCT FROM 'qa' OR qr.work_item_id IS DISTINCT FROM e.work_item_id
      OR qr.execution_attempt_id IS DISTINCT FROM e.execution_attempt_id OR qr.target_sha IS DISTINCT FROM e.target_sha
      OR impl.task_id IS DISTINCT FROM e.task_id OR impl.artifact_sha IS DISTINCT FROM e.target_sha
      OR wi.payload->>'runtime_contract' IS DISTINCT FROM 'visual_qa_v1' OR wi.payload->>'policy_hash' IS DISTINCT FROM e.policy_hash
      OR NOT public.qa_policy_is_valid(wi.payload->'qa_policy') OR wi.payload->'qa_policy'->'required' IS DISTINCT FROM 'true'::jsonb
      OR (e.status<>'running' AND e.capability_revoked_at IS NULL AND e.planner_session_id IS NULL
        AND NOT (e.status='failed' AND e.capability_consumed_at IS NOT NULL AND e.result->>'verdict'='infrastructure_failure'))
      OR (e.result IS NOT NULL AND NOT public.qa_result_is_valid(e.result,e.target_sha,wi.payload->'qa_policy'))
      OR (e.result IS NOT NULL AND e.result_hash IS DISTINCT FROM public.qa_jsonb_sha256(e.result))
  ) THEN RAISE EXCEPTION 'Phase 5B QA execution verification failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.loop_evidence evidence
    LEFT JOIN LATERAL (
      SELECT 1 valid FROM public.qa_executions execution
      CROSS JOIN LATERAL jsonb_array_elements(execution.result->'evidence') authoritative(descriptor)
      WHERE evidence.task_id=execution.task_id AND evidence.task_run_id=execution.qa_run_id
        AND evidence.metadata->>'qa_execution_id'=execution.id::text
        AND evidence.metadata->>'task_id'=execution.task_id::text
        AND evidence.metadata->>'qa_run_id'=execution.qa_run_id::text
        AND evidence.metadata->>'work_item_id'=execution.work_item_id::text
        AND evidence.metadata->>'execution_attempt_id'=execution.execution_attempt_id::text
        AND evidence.metadata->>'policy_hash'=execution.policy_hash
        AND evidence.metadata->>'result_hash'=execution.result_hash
        AND evidence.metadata->>'tested_sha'=execution.result->>'tested_sha'
        AND evidence.metadata->>'planner_session_id' IS NOT DISTINCT FROM execution.planner_session_id
        AND evidence.metadata->'schema_version'='1'::jsonb
        AND evidence.metadata->'descriptor'=authoritative.descriptor
        AND evidence.kind='visual_qa_'||(authoritative.descriptor->>'kind')
        AND evidence.uri='visual-qa://'||(authoritative.descriptor->>'storage_ref')
        AND evidence.content IS NULL AND evidence.created_at=execution.finished_at
        AND execution.status IN ('succeeded','failed')
        AND execution.capability_consumed_at IS NOT NULL AND execution.capability_revoked_at IS NULL
        AND execution.result_hash=public.qa_jsonb_sha256(execution.result)
      LIMIT 1
    ) authority ON true
    WHERE (evidence.kind LIKE 'visual_qa_%' OR evidence.uri LIKE 'visual-qa://%') AND authority.valid IS NULL
  ) THEN RAISE EXCEPTION 'Visual QA evidence row lacks exact immutable result authority'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.qa_executions execution
    CROSS JOIN LATERAL jsonb_array_elements(execution.result->'evidence') authoritative(descriptor)
    LEFT JOIN public.loop_evidence evidence ON evidence.task_id=execution.task_id AND evidence.task_run_id=execution.qa_run_id
      AND evidence.metadata->>'qa_execution_id'=execution.id::text
      AND evidence.metadata->>'task_id'=execution.task_id::text
      AND evidence.metadata->>'qa_run_id'=execution.qa_run_id::text
      AND evidence.metadata->>'result_hash'=execution.result_hash
      AND evidence.metadata->'descriptor'=authoritative.descriptor
      AND evidence.kind='visual_qa_'||(authoritative.descriptor->>'kind')
      AND evidence.uri='visual-qa://'||(authoritative.descriptor->>'storage_ref')
    WHERE execution.status IN ('succeeded','failed') AND execution.capability_consumed_at IS NOT NULL
      AND execution.capability_revoked_at IS NULL AND execution.result_hash=public.qa_jsonb_sha256(execution.result)
      AND evidence.id IS NULL
  ) THEN RAISE EXCEPTION 'Terminal Visual QA result descriptor lacks protected evidence row'; END IF;
END $$;
COMMIT;
