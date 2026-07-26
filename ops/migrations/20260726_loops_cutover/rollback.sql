-- Maintenance-window rollback for migration 030.
-- Exact inverse of the namespace/value cutover; it does not normalize table shape.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  destination text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.loops') IS NULL THEN missing := array_append(missing,'loops'); END IF;
  IF to_regclass('public.loop_events') IS NULL THEN missing := array_append(missing,'loop_events'); END IF;
  IF to_regclass('public.loop_work_items') IS NULL THEN missing := array_append(missing,'loop_work_items'); END IF;
  IF to_regclass('public.work_items') IS NULL THEN missing := array_append(missing,'work_items'); END IF;
  IF cardinality(missing)>0 THEN RAISE EXCEPTION 'Loops rollback source tables are absent: %',array_to_string(missing,', '); END IF;
  IF to_regclass('public.projects') IS NOT NULL THEN destination := array_append(destination,'projects'); END IF;
  IF to_regclass('public.project_events') IS NOT NULL THEN destination := array_append(destination,'project_events'); END IF;
  IF to_regclass('public.project_work_items') IS NOT NULL THEN destination := array_append(destination,'project_work_items'); END IF;
  IF cardinality(destination)>0 THEN RAISE EXCEPTION 'Loops rollback destination tables already exist: %',array_to_string(destination,', '); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_items' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Loops rollback source column work_items.loop_id is absent';
  END IF;
  IF to_regclass('public.pipeline_items') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Loops rollback optional source column pipeline_items.loop_id is absent';
  END IF;
  IF to_regclass('public.recurrence_rules') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='loop_id') THEN
    RAISE EXCEPTION 'Loops rollback optional source column recurrence_rules.loop_id is absent';
  END IF;
END $$;

LOCK TABLE public.loops, public.loop_events, public.loop_work_items, public.work_items IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF to_regclass('public.pipeline_items') IS NOT NULL THEN
    LOCK TABLE public.pipeline_items IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.recurrence_rules') IS NOT NULL THEN
    LOCK TABLE public.recurrence_rules IN ACCESS EXCLUSIVE MODE;
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_loop_work_items_primary_execution__cutover_created;
ALTER TABLE public.work_items DROP CONSTRAINT IF EXISTS work_items_source_type_loop_cutover_created;

DO $$
DECLARE
  collisions bigint;
  obj record;
BEGIN
  SELECT count(*) INTO collisions FROM public.work_items
  WHERE payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id'];
  IF collisions>0 THEN RAISE EXCEPTION 'Loops rollback found % work_items destination payload key collisions',collisions; END IF;
  SELECT count(*) INTO collisions FROM public.loop_events
  WHERE payload ?| ARRAY['source_project_id','source_project_title','materialized_from_project','project_status_at_materialization','superseded_for_project_id'];
  IF collisions>0 THEN RAISE EXCEPTION 'Loops rollback found % loop_events destination payload key collisions',collisions; END IF;

  SELECT count(*) INTO collisions FROM public.loop_events le LEFT JOIN public.loops l ON l.id=le.loop_id WHERE l.id IS NULL;
  IF collisions>0 THEN RAISE EXCEPTION 'Loops rollback found % orphan loop_events.loop_id values',collisions; END IF;
  SELECT count(*) INTO collisions FROM public.loop_work_items lwi
    LEFT JOIN public.loops l ON l.id=lwi.loop_id LEFT JOIN public.work_items wi ON wi.id=lwi.work_item_id
    WHERE l.id IS NULL OR wi.id IS NULL;
  IF collisions>0 THEN RAISE EXCEPTION 'Loops rollback found % orphan loop_work_items references',collisions; END IF;
  SELECT count(*) INTO collisions FROM public.work_items wi LEFT JOIN public.loops l ON l.id=wi.loop_id
    WHERE wi.loop_id IS NOT NULL AND l.id IS NULL;
  IF collisions>0 THEN RAISE EXCEPTION 'Loops rollback found % orphan work_items.loop_id values',collisions; END IF;

  FOR obj IN SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname IN ('loops','loop_events','loop_work_items','work_items','pipeline_items','recurrence_rules')
      AND c.conname ILIKE '%loop%'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname=replace(obj.conname,'loop','project')) THEN
      RAISE EXCEPTION 'Loops rollback destination constraint name already exists: %',replace(obj.conname,'loop','project');
    END IF;
  END LOOP;
  FOR obj IN SELECT indexname FROM pg_indexes WHERE schemaname='public'
    AND tablename IN ('loops','loop_events','loop_work_items','work_items','pipeline_items','recurrence_rules') AND indexname ILIKE '%loop%'
  LOOP
    IF to_regclass(format('public.%I',replace(obj.indexname,'loop','project'))) IS NOT NULL THEN
      RAISE EXCEPTION 'Loops rollback destination index name already exists: %',replace(obj.indexname,'loop','project');
    END IF;
  END LOOP;
END $$;

-- Restore the source_type CHECK before any row changes loop -> project.
CREATE TEMP TABLE loops_rollback_source_type_checks ON COMMIT DROP AS
SELECT c.conname,pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
  AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[];

DO $$
DECLARE
  obj record;
  inner_definition text;
BEGIN
  FOR obj IN SELECT conname,definition FROM loops_rollback_source_type_checks LOOP
    IF replace(obj.definition,'''loop''','''project''')=obj.definition THEN
      RAISE EXCEPTION 'Loops rollback cannot restore source_type CHECK % because it has no exact loop literal',obj.conname;
    END IF;
    inner_definition := regexp_replace(obj.definition,'^CHECK \((.*)\)( NOT VALID)?$','\1');
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I',obj.conname);
    EXECUTE format('ALTER TABLE public.work_items ADD CONSTRAINT %I CHECK ((source_type = ''project'') OR (%s)) NOT VALID',obj.conname,inner_definition);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.rewrite_loop_controlled_values(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  result jsonb;
  scalar text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'string' THEN
      scalar := value #>> '{}';
      RETURN to_jsonb(CASE scalar
        WHEN 'quick_loop_box' THEN 'quick_project_box'
        WHEN 'loop-planner' THEN 'project-planner'
        WHEN 'loop-execution-materializer' THEN 'project-execution-materializer'
        ELSE scalar END);
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.rewrite_loop_controlled_values(item)),'[]'::jsonb)
        INTO result FROM jsonb_array_elements(value) AS items(item);
      RETURN result;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(key,pg_temp.rewrite_loop_controlled_values(item)),'{}'::jsonb)
        INTO result FROM jsonb_each(value) AS items(key,item);
      RETURN result;
    ELSE RETURN value;
  END CASE;
END $$;

UPDATE public.work_items SET payload=pg_temp.rewrite_loop_controlled_values(
  (payload - 'source_loop_id' - 'source_loop_title' - 'materialized_from_loop' - 'loop_status_at_materialization' - 'superseded_for_loop_id' - 'orphaned_source_loop_id')
  || CASE WHEN payload ? 'source_loop_id' THEN jsonb_build_object('source_project_id',payload->'source_loop_id') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'source_loop_title' THEN jsonb_build_object('source_project_title',payload->'source_loop_title') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'materialized_from_loop' THEN jsonb_build_object('materialized_from_project',payload->'materialized_from_loop') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'loop_status_at_materialization' THEN jsonb_build_object('project_status_at_materialization',payload->'loop_status_at_materialization') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'superseded_for_loop_id' THEN jsonb_build_object('superseded_for_project_id',payload->'superseded_for_loop_id') ELSE '{}'::jsonb END
)
WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id','orphaned_source_loop_id']
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));

UPDATE public.loop_events SET payload=pg_temp.rewrite_loop_controlled_values(
  (payload - 'source_loop_id' - 'source_loop_title' - 'materialized_from_loop' - 'loop_status_at_materialization' - 'superseded_for_loop_id')
  || CASE WHEN payload ? 'source_loop_id' THEN jsonb_build_object('source_project_id',payload->'source_loop_id') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'source_loop_title' THEN jsonb_build_object('source_project_title',payload->'source_loop_title') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'materialized_from_loop' THEN jsonb_build_object('materialized_from_project',payload->'materialized_from_loop') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'loop_status_at_materialization' THEN jsonb_build_object('project_status_at_materialization',payload->'loop_status_at_materialization') ELSE '{}'::jsonb END
  || CASE WHEN payload ? 'superseded_for_loop_id' THEN jsonb_build_object('superseded_for_project_id',payload->'superseded_for_loop_id') ELSE '{}'::jsonb END
)
WHERE payload ?| ARRAY['source_loop_id','source_loop_title','materialized_from_loop','loop_status_at_materialization','superseded_for_loop_id']
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
   OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));

UPDATE public.loops SET metadata=pg_temp.rewrite_loop_controlled_values(metadata)
WHERE jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
   OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
   OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'));

UPDATE public.work_items SET
  source_type=CASE WHEN source_type='loop' THEN 'project' ELSE source_type END,
  requested_by=CASE requested_by WHEN 'loop-planner' THEN 'project-planner' WHEN 'loop-execution-materializer' THEN 'project-execution-materializer' ELSE requested_by END
WHERE source_type='loop' OR requested_by IN ('loop-planner','loop-execution-materializer');

DO $$
DECLARE
  obj record;
  replacement text;
BEGIN
  FOR obj IN SELECT conname,definition FROM loops_rollback_source_type_checks LOOP
    replacement := replace(obj.definition,'''loop''','''project''');
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I',obj.conname);
    EXECUTE format('ALTER TABLE public.work_items ADD CONSTRAINT %I %s',obj.conname,replacement);
  END LOOP;
END $$;

UPDATE public.loop_events SET
  event_type=regexp_replace(event_type,'^loop\.','project.'),
  actor=CASE actor WHEN 'loop-planner' THEN 'project-planner' WHEN 'loop-execution-materializer' THEN 'project-execution-materializer' ELSE actor END
WHERE event_type LIKE 'loop.%' OR actor IN ('loop-planner','loop-execution-materializer');

ALTER TABLE public.loops RENAME TO projects;
ALTER TABLE public.loop_events RENAME TO project_events;
ALTER TABLE public.loop_work_items RENAME TO project_work_items;
ALTER TABLE public.work_items RENAME COLUMN loop_id TO project_id;
ALTER TABLE public.project_events RENAME COLUMN loop_id TO project_id;
ALTER TABLE public.project_work_items RENAME COLUMN loop_id TO project_id;
DO $$ BEGIN
  IF to_regclass('public.pipeline_items') IS NOT NULL THEN
    ALTER TABLE public.pipeline_items RENAME COLUMN loop_id TO project_id;
  END IF;
  IF to_regclass('public.recurrence_rules') IS NOT NULL THEN
    ALTER TABLE public.recurrence_rules RENAME COLUMN loop_id TO project_id;
  END IF;
END $$;

DO $$
DECLARE
  obj record;
  next_name text;
BEGIN
  FOR obj IN SELECT c.conrelid::regclass AS relation_name,c.conname FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public' AND r.relname IN ('projects','project_events','project_work_items','work_items','pipeline_items','recurrence_rules')
      AND c.conname ILIKE '%loop%'
  LOOP
    next_name := replace(obj.conname,'loop','project');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',obj.relation_name,obj.conname,next_name);
  END LOOP;
  FOR obj IN SELECT schemaname,indexname FROM pg_indexes WHERE schemaname='public'
    AND tablename IN ('projects','project_events','project_work_items','work_items','pipeline_items','recurrence_rules') AND indexname ILIKE '%loop%'
  LOOP
    next_name := replace(obj.indexname,'loop','project');
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',obj.schemaname,obj.indexname,next_name);
  END LOOP;
END $$;

DROP FUNCTION pg_temp.rewrite_loop_controlled_values(jsonb);
COMMIT;
