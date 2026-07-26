-- Read-only gate. Run after migration 030 on each target store.
BEGIN;
SET LOCAL TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
DECLARE
  violations bigint;
  fk_count bigint;
BEGIN
  IF to_regclass('public.loops') IS NULL OR to_regclass('public.loop_events') IS NULL
     OR to_regclass('public.loop_work_items') IS NULL OR to_regclass('public.work_items') IS NULL THEN
    RAISE EXCEPTION 'Postflight failed; one or more canonical Loop tables are absent';
  END IF;
  IF to_regclass('public.projects') IS NOT NULL OR to_regclass('public.project_events') IS NOT NULL
     OR to_regclass('public.project_work_items') IS NOT NULL THEN
    RAISE EXCEPTION 'Postflight failed; one or more legacy domain tables remain';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_items' AND column_name='loop_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_events' AND column_name='loop_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='loop_work_items' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Postflight failed; one or more canonical loop_id columns are absent';
  END IF;

  SELECT count(*) INTO violations FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('work_items','loop_events','loop_work_items') AND column_name='project_id';
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % legacy project_id columns remain',violations; END IF;
  SELECT count(*) INTO violations FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('work_items','loop_events','loop_work_items','pipeline_items','recurrence_rules') AND column_name='project_id';
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; global scan found % active project_id columns in relevant tables',violations; END IF;
  SELECT count(*) INTO violations FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
      AND (r.relname IN ('loops','loop_events','loop_work_items','work_items')
        OR (r.relname IN ('pipeline_items','recurrence_rules') AND EXISTS
          (SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema='public' AND ic.table_name=r.relname AND ic.column_name='loop_id')))
      AND c.conname ILIKE '%project%';
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % legacy constraint names remain',violations; END IF;
  SELECT count(*) INTO violations FROM pg_indexes i WHERE schemaname='public'
    AND (tablename IN ('loops','loop_events','loop_work_items','work_items')
      OR (tablename IN ('pipeline_items','recurrence_rules') AND EXISTS
        (SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema='public' AND ic.table_name=i.tablename AND ic.column_name='loop_id')))
    AND (indexname ILIKE '%project%' OR indexdef ~* '\mproject_id\M');
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % legacy index names remain',violations; END IF;

  SELECT count(*) INTO violations FROM public.loop_events le LEFT JOIN public.loops l ON l.id=le.loop_id WHERE l.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % orphan loop_events.loop_id values',violations; END IF;
  SELECT count(*) INTO violations FROM public.loop_work_items lwi
    LEFT JOIN public.loops l ON l.id=lwi.loop_id LEFT JOIN public.work_items wi ON wi.id=lwi.work_item_id
    WHERE l.id IS NULL OR wi.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % orphan loop_work_items references',violations; END IF;
  SELECT count(*) INTO violations FROM public.work_items wi LEFT JOIN public.loops l ON l.id=wi.loop_id
    WHERE wi.loop_id IS NOT NULL AND l.id IS NULL;
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % orphan work_items.loop_id values',violations; END IF;

  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.confrelid='public.loops'::regclass AND c.contype='f' AND c.confdeltype='n'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='loop_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loops'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact work_items.loop_id -> loops.id ON DELETE SET NULL FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.loop_events'::regclass AND c.confrelid='public.loops'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loop_events'::regclass AND attname='loop_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loops'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact loop_events.loop_id -> loops.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.loop_work_items'::regclass AND c.confrelid='public.loops'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loop_work_items'::regclass AND attname='loop_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loops'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact loop_work_items.loop_id -> loops.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.loop_work_items'::regclass AND c.confrelid='public.work_items'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loop_work_items'::regclass AND attname='work_item_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='id')]::smallint[];
  IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact loop_work_items.work_item_id -> work_items.id ON DELETE CASCADE FK count is %',fk_count; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='loop_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.pipeline_items'::regclass AND c.confrelid='public.loops'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.pipeline_items'::regclass AND attname='loop_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loops'::regclass AND attname='id')]::smallint[];
    IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact pipeline_items.loop_id -> loops.id FK count is %',fk_count; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='loop_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.recurrence_rules'::regclass AND c.confrelid='public.loops'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.recurrence_rules'::regclass AND attname='loop_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.loops'::regclass AND attname='id')]::smallint[];
    IF fk_count<>1 THEN RAISE EXCEPTION 'Postflight failed; exact recurrence_rules.loop_id -> loops.id FK count is %',fk_count; END IF;
  END IF;

  SELECT count(*) INTO violations FROM (SELECT loop_id FROM public.loop_work_items WHERE relation_type='primary_execution' GROUP BY loop_id HAVING count(*)>1) d;
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % duplicate primary executions',violations; END IF;
  SELECT count(*) INTO violations FROM pg_index i
  WHERE i.indrelid='public.loop_work_items'::regclass AND i.indisunique AND i.indpred IS NOT NULL
    AND i.indnkeyatts=1
    AND i.indkey::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid=i.indrelid AND attname='loop_id')
    AND pg_get_expr(i.indpred,i.indrelid) ~* 'relation_type.*primary_execution';
  IF violations<>1 THEN RAISE EXCEPTION 'Postflight failed; indisunique primary_execution partial index definition count is %, expected exactly 1',violations; END IF;

  SELECT count(*) INTO violations FROM public.work_items
  WHERE source_type='project' OR requested_by IN ('project-planner','project-execution-materializer')
     OR payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id']
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_project_box'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','project-planner'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','project-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % work_items retain controlled legacy keys/values',violations; END IF;
  SELECT count(*) INTO violations FROM public.work_items wi LEFT JOIN public.loops l ON l.id::text=wi.source_id
  WHERE wi.source_type='loop' AND l.id IS NULL
    AND (wi.status NOT IN ('done','failed','canceled','cancelled')
      OR NOT (wi.payload ? 'orphaned_source_loop_id')
      OR (wi.payload->>'orphaned_source_loop_id') IS DISTINCT FROM wi.source_id);
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % orphan Loop source_id rows lack a valid orphaned_source_loop_id marker',violations; END IF;
  SELECT count(*) INTO violations FROM public.work_items wi
  WHERE wi.payload ? 'orphaned_source_loop_id'
    AND (wi.source_type<>'loop' OR wi.status NOT IN ('done','failed','canceled','cancelled')
      OR (wi.payload->>'orphaned_source_loop_id') IS DISTINCT FROM wi.source_id);
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % invalid orphaned_source_loop_id markers',violations; END IF;
  SELECT count(*) INTO violations FROM public.loop_events
  WHERE event_type LIKE 'project.%' OR actor IN ('project-planner','project-execution-materializer')
     OR payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id']
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_project_box'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','project-planner'))
     OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','project-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % loop_events retain controlled legacy keys/values',violations; END IF;
  SELECT count(*) INTO violations FROM public.loops
  WHERE jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','quick_project_box'))
     OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','project-planner'))
     OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','project-execution-materializer'));
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; % loops.metadata values remain quick_project_box/project-planner legacy values',violations; END IF;

  SELECT count(*) INTO violations FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
    AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[]
    AND c.conname<>'work_items_source_type_loop_cutover_created'
    AND position('''project''' IN pg_get_constraintdef(c.oid))>0;
  IF violations>0 THEN RAISE EXCEPTION 'Postflight failed; legacy project remains in work_items.source_type CHECK'; END IF;
  SELECT count(*) INTO violations FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
    AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[];
  IF violations=0 THEN RAISE EXCEPTION 'Postflight failed; source_type has no CHECK enforcing the Loop cutover invariant'; END IF;
END $$;

SELECT 'loops' AS relation,count(*) AS row_count FROM public.loops
UNION ALL SELECT 'loop_events',count(*) FROM public.loop_events
UNION ALL SELECT 'loop_work_items',count(*) FROM public.loop_work_items
UNION ALL SELECT 'work_items_with_loop_id',count(*) FROM public.work_items WHERE loop_id IS NOT NULL;
COMMIT;
