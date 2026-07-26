-- Read-only gate. Run before migration 030 on each target store.
BEGIN;
SET LOCAL TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  present_destination text[] := ARRAY[]::text[];
  violations bigint;
  fk_count bigint;
  obj record;
BEGIN
  IF to_regclass('public.projects') IS NULL THEN missing := array_append(missing,'projects'); END IF;
  IF to_regclass('public.project_events') IS NULL THEN missing := array_append(missing,'project_events'); END IF;
  IF to_regclass('public.project_work_items') IS NULL THEN missing := array_append(missing,'project_work_items'); END IF;
  IF to_regclass('public.work_items') IS NULL THEN missing := array_append(missing,'work_items'); END IF;
  IF cardinality(missing)>0 THEN RAISE EXCEPTION 'Preflight failed; source tables absent: %',array_to_string(missing,', '); END IF;

  IF to_regclass('public.loops') IS NOT NULL THEN present_destination := array_append(present_destination,'loops'); END IF;
  IF to_regclass('public.loop_events') IS NOT NULL THEN present_destination := array_append(present_destination,'loop_events'); END IF;
  IF to_regclass('public.loop_work_items') IS NOT NULL THEN present_destination := array_append(present_destination,'loop_work_items'); END IF;
  IF cardinality(present_destination)>0 THEN RAISE EXCEPTION 'Preflight failed; destination tables already present: %',array_to_string(present_destination,', '); END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_items' AND column_name='project_id') THEN RAISE EXCEPTION 'Preflight failed; work_items.project_id absent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_events' AND column_name='project_id') THEN RAISE EXCEPTION 'Preflight failed; project_events.project_id absent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_work_items' AND column_name='project_id') THEN RAISE EXCEPTION 'Preflight failed; project_work_items.project_id absent'; END IF;
  -- Optional relations participate only when their legacy source column exists.
  -- A pre-existing destination column is always a cutover collision.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Preflight failed; destination column pipeline_items.loop_id already exists (collision)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Preflight failed; destination column recurrence_rules.loop_id already exists (collision)';
  END IF;

  SELECT count(*) INTO violations FROM public.project_events pe LEFT JOIN public.projects p ON p.id=pe.project_id WHERE p.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % orphan project_events.project_id values',violations; END IF;
  SELECT count(*) INTO violations FROM public.project_work_items pwi
    LEFT JOIN public.projects p ON p.id=pwi.project_id LEFT JOIN public.work_items wi ON wi.id=pwi.work_item_id
    WHERE p.id IS NULL OR wi.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % orphan project_work_items references',violations; END IF;
  SELECT count(*) INTO violations FROM public.work_items wi LEFT JOIN public.projects p ON p.id=wi.project_id
    WHERE wi.project_id IS NOT NULL AND p.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % orphan work_items.project_id values',violations; END IF;

  SELECT count(*) INTO violations FROM public.work_items wi LEFT JOIN public.projects p ON p.id::text=wi.source_id
  WHERE wi.source_type='project' AND p.id IS NULL AND wi.status NOT IN ('done','failed','canceled','cancelled');
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % non-terminal source_type=project rows have orphan source_id',violations; END IF;

  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='n'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact work_items.project_id -> projects.id ON DELETE SET NULL FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_events'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_events'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact project_events.project_id -> projects.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_work_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_work_items'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact project_work_items.project_id -> projects.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_work_items'::regclass AND c.confrelid='public.work_items'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_work_items'::regclass AND attname='work_item_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact project_work_items.work_item_id -> work_items.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='project_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.pipeline_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.pipeline_items'::regclass AND attname='project_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
    IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact pipeline_items.project_id -> projects.id FK count is %',fk_count; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='project_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.recurrence_rules'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.recurrence_rules'::regclass AND attname='project_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
    IF fk_count<>1 THEN RAISE EXCEPTION 'Preflight failed; exact recurrence_rules.project_id -> projects.id FK count is %',fk_count; END IF;
  END IF;

  SELECT count(*) INTO violations FROM (SELECT project_id FROM public.project_work_items WHERE relation_type='primary_execution' GROUP BY project_id HAVING count(*)>1) d;
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % duplicate primary executions',violations; END IF;

  -- No destination key or value may exist before cutover: rollback is global.
  SELECT count(*) INTO violations FROM public.work_items
  WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id','orphaned_source_loop_id']
     OR source_type='loop' OR requested_by IN ('loop-planner','loop-execution-materializer')
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % destination controlled keys/values already exist in work_items',violations; END IF;
  SELECT count(*) INTO violations FROM public.project_events
  WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id']
     OR event_type LIKE 'loop.%' OR actor IN ('loop-planner','loop-execution-materializer')
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % destination controlled keys/values already exist in project_events',violations; END IF;
  SELECT count(*) INTO violations FROM public.projects
  WHERE jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; % destination controlled values already exist in projects.metadata',violations; END IF;

  SELECT count(*) INTO violations FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
    AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[]
    AND position('''loop''' IN pg_get_constraintdef(c.oid))>0;
  IF violations>0 THEN RAISE EXCEPTION 'Preflight failed; destination controlled value loop already exists in source_type CHECK'; END IF;

  FOR obj IN SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
      AND (r.relname IN ('projects','project_events','project_work_items','work_items')
        OR (r.relname IN ('pipeline_items','recurrence_rules') AND EXISTS
          (SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema='public' AND ic.table_name=r.relname AND ic.column_name='project_id')))
      AND c.conname ILIKE '%project%'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname=replace(obj.conname,'project','loop')) THEN
      RAISE EXCEPTION 'Preflight failed; destination constraint name exists: %',replace(obj.conname,'project','loop');
    END IF;
  END LOOP;
  FOR obj IN SELECT schemaname,indexname FROM pg_indexes i WHERE schemaname='public'
    AND (tablename IN ('projects','project_events','project_work_items','work_items')
      OR (tablename IN ('pipeline_items','recurrence_rules') AND EXISTS
        (SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema='public' AND ic.table_name=i.tablename AND ic.column_name='project_id')))
    AND indexname ILIKE '%project%'
  LOOP
    IF to_regclass(format('public.%I',replace(obj.indexname,'project','loop'))) IS NOT NULL THEN
      RAISE EXCEPTION 'Preflight failed; destination index name exists: %',replace(obj.indexname,'project','loop');
    END IF;
  END LOOP;
END $$;

SELECT 'projects' AS relation,count(*) AS row_count FROM public.projects
UNION ALL SELECT 'project_events',count(*) FROM public.project_events
UNION ALL SELECT 'project_work_items',count(*) FROM public.project_work_items
UNION ALL SELECT 'work_items_with_project_id',count(*) FROM public.work_items WHERE project_id IS NOT NULL
UNION ALL SELECT 'legacy_source_type',count(*) FROM public.work_items WHERE source_type='project';
COMMIT;
