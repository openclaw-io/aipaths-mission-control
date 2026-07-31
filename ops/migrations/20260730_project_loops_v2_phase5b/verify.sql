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
    ('transition_visual_qa_work_item',to_regprocedure('public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)') IS NOT NULL),
    ('guard_visual_qa_work_item',to_regprocedure('public.guard_visual_qa_work_item()') IS NOT NULL),
    ('idx_qa_executions_stale',to_regclass('public.idx_qa_executions_stale') IS NOT NULL),
    ('validate_qa_execution_integrity',to_regprocedure('public.validate_qa_execution_integrity()') IS NOT NULL),
    ('qa_executions_integrity',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='qa_executions_integrity' AND tgrelid='public.qa_executions'::regclass AND NOT tgisinternal)),
    ('visual_qa_work_items_guard',EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='visual_qa_work_items_guard' AND tgrelid='public.work_items'::regclass AND NOT tgisinternal)),
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

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('claim_visual_qa_execution','heartbeat_visual_qa_execution',
        'complete_visual_qa_execution','reconcile_visual_qa_execution','transition_visual_qa_work_item',
        'validate_qa_execution_integrity','guard_visual_qa_work_item')
      AND (NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'aipaths_mc_qa_owner'
        OR NOT coalesce(p.proconfig,'{}'::text[]) @> ARRAY['search_path=pg_catalog, public'])) THEN
    RAISE EXCEPTION 'QA SECURITY DEFINER owner/search_path invalid';
  END IF;

  IF has_table_privilege('aipaths_mc_app','public.qa_authority_secrets','SELECT')
    OR has_table_privilege('aipaths_mc_app','public.qa_authority_secrets','INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('aipaths_mc_app','public.qa_work_item_transition_authorities','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('aipaths_mc_app','public.qa_executions','INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('aipaths_mc_app','public.qa_executions','SELECT') THEN
    RAISE EXCEPTION 'Application QA table grants invalid';
  END IF;
  IF has_function_privilege('aipaths_mc_app','public.install_qa_authority_hmac_key(text)','EXECUTE')
    OR has_function_privilege('aipaths_mc_app','public.transition_visual_qa_work_item(uuid,uuid,text,timestamp with time zone,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.claim_visual_qa_execution(jsonb,text,text)','EXECUTE')
    OR NOT has_function_privilege('aipaths_mc_app','public.heartbeat_visual_qa_execution(uuid,text)','EXECUTE')
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
      OR (e.result IS NOT NULL AND NOT public.qa_result_is_valid(e.result,e.target_sha,wi.payload->'qa_policy'))
      OR (e.result IS NOT NULL AND e.result_hash IS DISTINCT FROM public.qa_jsonb_sha256(e.result))
  ) THEN RAISE EXCEPTION 'Phase 5B QA execution verification failed'; END IF;
END $$;
COMMIT;
