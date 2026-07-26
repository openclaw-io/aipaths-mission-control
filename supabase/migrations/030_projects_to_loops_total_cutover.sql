-- Breaking Mission Control Projects -> Loops cutover.
-- Pure namespace/value cutover: table and column shape is intentionally preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  destination text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.projects') IS NULL THEN missing := array_append(missing, 'projects'); END IF;
  IF to_regclass('public.project_events') IS NULL THEN missing := array_append(missing, 'project_events'); END IF;
  IF to_regclass('public.project_work_items') IS NULL THEN missing := array_append(missing, 'project_work_items'); END IF;
  IF to_regclass('public.work_items') IS NULL THEN missing := array_append(missing, 'work_items'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'Loops cutover source tables are absent: %', array_to_string(missing, ', ');
  END IF;

  IF to_regclass('public.loops') IS NOT NULL THEN destination := array_append(destination, 'loops'); END IF;
  IF to_regclass('public.loop_events') IS NOT NULL THEN destination := array_append(destination, 'loop_events'); END IF;
  IF to_regclass('public.loop_work_items') IS NOT NULL THEN destination := array_append(destination, 'loop_work_items'); END IF;
  IF cardinality(destination) > 0 THEN
    RAISE EXCEPTION 'Loops cutover destination tables already exist: %', array_to_string(destination, ', ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_items' AND column_name='project_id') THEN
    RAISE EXCEPTION 'Loops cutover source column work_items.project_id is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_events' AND column_name='project_id') THEN
    RAISE EXCEPTION 'Loops cutover source column project_events.project_id is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='project_work_items' AND column_name='project_id') THEN
    RAISE EXCEPTION 'Loops cutover source column project_work_items.project_id is absent';
  END IF;
  -- Optional relations are selected by source-column presence, not table presence.
  -- If the destination column predates this cutover, inversion would be ambiguous.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Loops cutover destination column pipeline_items.loop_id already exists (collision)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Loops cutover destination column recurrence_rules.loop_id already exists (collision)';
  END IF;
END $$;

LOCK TABLE public.projects, public.project_events, public.project_work_items, public.work_items IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='project_id') THEN
    LOCK TABLE public.pipeline_items IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='project_id') THEN
    LOCK TABLE public.recurrence_rules IN ACCESS EXCLUSIVE MODE;
  END IF;
END $$;

DO $$
DECLARE
  violations bigint;
  fk_count bigint;
  obj record;
BEGIN
  -- Destination controlled keys/values must not predate the cutover. Otherwise a
  -- global inverse rewrite cannot distinguish old rows from cutover rows.
  SELECT count(*) INTO violations FROM public.work_items
  WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id','orphaned_source_loop_id']
     OR source_type='loop'
     OR requested_by IN ('loop-planner','loop-execution-materializer')
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','loop-execution-materializer'));
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % destination controlled keys/values in work_items', violations; END IF;

  SELECT count(*) INTO violations FROM public.project_events
  WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id']
     OR event_type LIKE 'loop.%'
     OR actor IN ('loop-planner','loop-execution-materializer')
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','loop-execution-materializer'));
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % destination controlled keys/values in project_events', violations; END IF;

  SELECT count(*) INTO violations FROM public.projects
  WHERE jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','quick_loop_box'))
     OR jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','loop-planner'))
     OR jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','loop-execution-materializer'));
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % destination controlled values in projects.metadata', violations; END IF;

  SELECT count(*) INTO violations FROM public.project_events pe LEFT JOIN public.projects p ON p.id=pe.project_id WHERE p.id IS NULL;
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % orphan project_events.project_id values', violations; END IF;
  SELECT count(*) INTO violations FROM public.project_work_items pwi
    LEFT JOIN public.projects p ON p.id=pwi.project_id LEFT JOIN public.work_items wi ON wi.id=pwi.work_item_id
    WHERE p.id IS NULL OR wi.id IS NULL;
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % orphan project_work_items references', violations; END IF;
  SELECT count(*) INTO violations FROM public.work_items wi LEFT JOIN public.projects p ON p.id=wi.project_id
    WHERE wi.project_id IS NOT NULL AND p.id IS NULL;
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % orphan work_items.project_id values', violations; END IF;

  SELECT count(*) INTO violations
  FROM public.work_items wi LEFT JOIN public.projects p ON p.id::text=wi.source_id::text
  WHERE wi.source_type='project' AND p.id IS NULL
    AND wi.status NOT IN ('done','failed','canceled','cancelled');
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % non-terminal source_type=project rows with orphan source_id', violations; END IF;

  -- Require each exact source FK (source column, target table/id, and delete action).
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.work_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='n'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact work_items.project_id -> projects.id ON DELETE SET NULL FK; found %', fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_events'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_events'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact project_events.project_id -> projects.id ON DELETE CASCADE FK; found %', fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_work_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_work_items'::regclass AND attname='project_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
  IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact project_work_items.project_id -> projects.id ON DELETE CASCADE FK; found %', fk_count; END IF;
  SELECT count(*) INTO fk_count FROM pg_constraint c
  WHERE c.conrelid='public.project_work_items'::regclass AND c.confrelid='public.work_items'::regclass AND c.contype='f' AND c.confdeltype='c'
    AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.project_work_items'::regclass AND attname='work_item_id')]::smallint[]
    AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.work_items'::regclass AND attname='id')]::smallint[];
  IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact project_work_items.work_item_id -> work_items.id ON DELETE CASCADE FK; found %', fk_count; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='project_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.pipeline_items'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.pipeline_items'::regclass AND attname='project_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
    IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact pipeline_items.project_id -> projects.id FK; found %',fk_count; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='project_id') THEN
    SELECT count(*) INTO fk_count FROM pg_constraint c
    WHERE c.conrelid='public.recurrence_rules'::regclass AND c.confrelid='public.projects'::regclass AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.recurrence_rules'::regclass AND attname='project_id')]::smallint[]
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.projects'::regclass AND attname='id')]::smallint[];
    IF fk_count <> 1 THEN RAISE EXCEPTION 'Loops cutover requires exact recurrence_rules.project_id -> projects.id FK; found %',fk_count; END IF;
  END IF;

  SELECT count(*) INTO violations FROM (SELECT project_id FROM public.project_work_items WHERE relation_type='primary_execution' GROUP BY project_id HAVING count(*) > 1) d;
  IF violations > 0 THEN RAISE EXCEPTION 'Loops cutover found % projects with duplicate primary executions', violations; END IF;

  -- Fail before ALTER ... RENAME if a generated destination object name is occupied.
  FOR obj IN SELECT c.conname FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
      AND (r.relname IN ('projects','project_events','project_work_items','work_items')
        OR (r.relname IN ('pipeline_items','recurrence_rules') AND EXISTS
          (SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema='public' AND ic.table_name=r.relname AND ic.column_name='project_id')))
      AND c.conname ILIKE '%project%'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname=replace(obj.conname,'project','loop')) THEN
      RAISE EXCEPTION 'Loops cutover destination constraint name already exists: %', replace(obj.conname,'project','loop');
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
      RAISE EXCEPTION 'Loops cutover destination index name already exists: %', replace(obj.indexname,'project','loop');
    END IF;
  END LOOP;
END $$;

-- The CHECK must accept loop before any row changes project -> loop. Preserve the
-- original definition in-session so the temporary widened CHECK can be finalized.
CREATE TEMP TABLE loops_cutover_source_type_checks ON COMMIT DROP AS
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
  AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[];

DO $$
DECLARE
  obj record;
  inner_definition text;
BEGIN
  FOR obj IN SELECT conname,definition FROM loops_cutover_source_type_checks LOOP
    IF position('''loop''' IN obj.definition) > 0 THEN
      RAISE EXCEPTION 'Loops cutover source_type CHECK already contains destination value loop: %', obj.conname;
    END IF;
    IF replace(obj.definition, '''project''', '''loop''') = obj.definition THEN
      RAISE EXCEPTION 'Loops cutover cannot adjust source_type CHECK % because it has no exact project literal', obj.conname;
    END IF;
    inner_definition := regexp_replace(obj.definition, '^CHECK \((.*)\)( NOT VALID)?$', '\1');
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I', obj.conname);
    EXECUTE format('ALTER TABLE public.work_items ADD CONSTRAINT %I CHECK ((source_type = ''loop'') OR (%s)) NOT VALID', obj.conname, inner_definition);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.rewrite_project_controlled_values(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  result jsonb;
  scalar text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'string' THEN
      scalar := value #>> '{}';
      RETURN to_jsonb(CASE scalar
        WHEN 'quick_project_box' THEN 'quick_loop_box'
        WHEN 'project-planner' THEN 'loop-planner'
        WHEN 'project-execution-materializer' THEN 'loop-execution-materializer'
        ELSE scalar END);
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.rewrite_project_controlled_values(item)), '[]'::jsonb)
        INTO result FROM jsonb_array_elements(value) AS items(item);
      RETURN result;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(key, pg_temp.rewrite_project_controlled_values(item)), '{}'::jsonb)
        INTO result FROM jsonb_each(value) AS items(key,item);
      RETURN result;
    ELSE RETURN value;
  END CASE;
END $$;

-- Rewrite controlled JSON keys and exact controlled scalar values only.
UPDATE public.work_items SET payload = pg_temp.rewrite_project_controlled_values(
  (payload - 'source_project_id' - 'source_project_title' - 'materialized_from_project' - 'project_status_at_materialization' - 'superseded_for_project_id')
  || CASE WHEN payload ? 'source_project_id' THEN jsonb_build_object('source_loop_id',payload->'source_project_id') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'source_project_title' THEN jsonb_build_object('source_loop_title',payload->'source_project_title') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'materialized_from_project' THEN jsonb_build_object('materialized_from_loop',payload->'materialized_from_project') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'project_status_at_materialization' THEN jsonb_build_object('loop_status_at_materialization',payload->'project_status_at_materialization') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'superseded_for_project_id' THEN jsonb_build_object('superseded_for_loop_id',payload->'superseded_for_project_id') ELSE '{}'::jsonb END
)
WHERE payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id']
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','quick_project_box'))
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','project-planner'))
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','project-execution-materializer'));

UPDATE public.project_events SET payload = pg_temp.rewrite_project_controlled_values(
  (payload - 'source_project_id' - 'source_project_title' - 'materialized_from_project' - 'project_status_at_materialization' - 'superseded_for_project_id')
  || CASE WHEN payload ? 'source_project_id' THEN jsonb_build_object('source_loop_id',payload->'source_project_id') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'source_project_title' THEN jsonb_build_object('source_loop_title',payload->'source_project_title') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'materialized_from_project' THEN jsonb_build_object('materialized_from_loop',payload->'materialized_from_project') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'project_status_at_materialization' THEN jsonb_build_object('loop_status_at_materialization',payload->'project_status_at_materialization') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'superseded_for_project_id' THEN jsonb_build_object('superseded_for_loop_id',payload->'superseded_for_project_id') ELSE '{}'::jsonb END
)
WHERE payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id']
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','quick_project_box'))
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','project-planner'))
   OR jsonb_path_exists(payload, '$.** ? (@ == $value)', jsonb_build_object('value','project-execution-materializer'));

UPDATE public.projects SET metadata=pg_temp.rewrite_project_controlled_values(metadata)
WHERE jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','quick_project_box'))
   OR jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','project-planner'))
   OR jsonb_path_exists(metadata, '$.** ? (@ == $value)', jsonb_build_object('value','project-execution-materializer'));

UPDATE public.work_items wi
SET payload=payload || jsonb_build_object('orphaned_source_loop_id',wi.source_id)
WHERE wi.source_type='project' AND wi.status IN ('done','failed','canceled','cancelled')
  AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id::text=wi.source_id::text);

UPDATE public.work_items SET
  source_type=CASE WHEN source_type='project' THEN 'loop' ELSE source_type END,
  requested_by=CASE requested_by WHEN 'project-planner' THEN 'loop-planner' WHEN 'project-execution-materializer' THEN 'loop-execution-materializer' ELSE requested_by END
WHERE source_type='project' OR requested_by IN ('project-planner','project-execution-materializer');

DO $$
DECLARE
  obj record;
  replacement text;
BEGIN
  FOR obj IN SELECT conname,definition FROM loops_cutover_source_type_checks LOOP
    replacement := replace(obj.definition,'''project''','''loop''');
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I',obj.conname);
    EXECUTE format('ALTER TABLE public.work_items ADD CONSTRAINT %I %s',obj.conname,replacement);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM loops_cutover_source_type_checks) THEN
    ALTER TABLE public.work_items ADD CONSTRAINT work_items_source_type_loop_cutover_created
      CHECK (source_type IS DISTINCT FROM 'project');
  END IF;
END $$;

UPDATE public.project_events SET
  event_type=regexp_replace(event_type, '^project\.', 'loop.'),
  actor=CASE actor WHEN 'project-planner' THEN 'loop-planner' WHEN 'project-execution-materializer' THEN 'loop-execution-materializer' ELSE actor END
WHERE event_type LIKE 'project.%' OR actor IN ('project-planner','project-execution-materializer');

ALTER TABLE public.projects RENAME TO loops;
ALTER TABLE public.project_events RENAME TO loop_events;
ALTER TABLE public.project_work_items RENAME TO loop_work_items;
ALTER TABLE public.work_items RENAME COLUMN project_id TO loop_id;
ALTER TABLE public.loop_events RENAME COLUMN project_id TO loop_id;
ALTER TABLE public.loop_work_items RENAME COLUMN project_id TO loop_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='project_id') THEN
    ALTER TABLE public.pipeline_items RENAME COLUMN project_id TO loop_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='project_id') THEN
    ALTER TABLE public.recurrence_rules RENAME COLUMN project_id TO loop_id;
  END IF;
END $$;

DO $$
DECLARE
  obj record;
  next_name text;
BEGIN
  FOR obj IN SELECT c.conrelid::regclass AS relation_name,c.conname FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
      AND (r.relname IN ('loops','loop_events','loop_work_items','work_items')
        OR (r.relname IN ('pipeline_items','recurrence_rules') AND EXISTS
          (SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema='public' AND ic.table_name=r.relname AND ic.column_name='loop_id')))
      AND c.conname ILIKE '%project%'
  LOOP
    next_name := replace(obj.conname,'project','loop');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',obj.relation_name,obj.conname,next_name);
  END LOOP;
  FOR obj IN SELECT schemaname,indexname FROM pg_indexes i WHERE schemaname='public'
    AND (tablename IN ('loops','loop_events','loop_work_items','work_items')
      OR (tablename IN ('pipeline_items','recurrence_rules') AND EXISTS
        (SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema='public' AND ic.table_name=i.tablename AND ic.column_name='loop_id')))
    AND indexname ILIKE '%project%'
  LOOP
    next_name := replace(obj.indexname,'project','loop');
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',obj.schemaname,obj.indexname,next_name);
  END LOOP;
END $$;

DO $$
DECLARE exact_indexes bigint;
BEGIN
  SELECT count(*) INTO exact_indexes
  FROM pg_index i
  WHERE i.indrelid='public.loop_work_items'::regclass AND i.indisunique AND i.indpred IS NOT NULL
    AND i.indnkeyatts=1
    AND i.indkey::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid=i.indrelid AND attname='loop_id')
    AND pg_get_expr(i.indpred,i.indrelid) ~* 'relation_type.*primary_execution';
  IF exact_indexes=0 THEN
    CREATE UNIQUE INDEX uq_loop_work_items_primary_execution__cutover_created
      ON public.loop_work_items(loop_id) WHERE relation_type='primary_execution';
  ELSIF exact_indexes<>1 THEN
    RAISE EXCEPTION 'Loops cutover found % primary_execution uniqueness indexes; expected at most one legacy index',exact_indexes;
  END IF;
END $$;

DROP FUNCTION pg_temp.rewrite_project_controlled_values(jsonb);
COMMIT;
