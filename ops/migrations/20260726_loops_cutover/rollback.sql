-- Recovery-safe rollback for migration 030.
-- Safe both after a complete forward and after any committed forward checkpoint.
-- SQL Editor may execute every top-level statement in a separate autocommit.
BEGIN;

-- Provenance guard: this is intentionally the first non-control statement and
-- performs no mutation. A Projects namespace is recoverable only when forward's
-- durable metadata proves that forward actually started. In particular, running
-- rollback against an untouched Projects database cannot create a helper, alter
-- a CHECK, rewrite data, or rename an unrelated Loop-named object.
DO $rollback_entry_guard$
DECLARE
  project_relations integer;
  loop_relations integer;
BEGIN
  SELECT count(*) INTO project_relations FROM unnest(ARRAY[
    to_regclass('public.projects'),
    to_regclass('public.project_events'),
    to_regclass('public.project_work_items')
  ]) relation_name WHERE relation_name IS NOT NULL;
  SELECT count(*) INTO loop_relations FROM unnest(ARRAY[
    to_regclass('public.loops'),
    to_regclass('public.loop_events'),
    to_regclass('public.loop_work_items')
  ]) relation_name WHERE relation_name IS NOT NULL;

  IF NOT ((project_relations=3 AND loop_relations=0)
       OR (project_relations=0 AND loop_relations=3)) THEN
    RAISE EXCEPTION 'Loops rollback entry guard: expected exactly one complete namespace (Projects or Loops); catalog is mixed/ambiguous';
  END IF;
  IF project_relations=3
     AND to_regclass('public.__mc_loops_cutover_20260726_source_type_checks') IS NULL THEN
    RAISE EXCEPTION 'Loops rollback entry guard: Projects namespace has no cutover provenance metadata; forward never started or provenance is missing; refusing all mutation';
  END IF;
END $rollback_entry_guard$;

SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- Persistent only between this statement and the recovery statement. The final
-- cleanup removes it; a failed rollback can simply be rerun.
CREATE OR REPLACE FUNCTION public.__mc_loops_cutover_20260726_rewrite_loop_values(value jsonb)
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
      SELECT coalesce(jsonb_agg(public.__mc_loops_cutover_20260726_rewrite_loop_values(item)),'[]'::jsonb)
        INTO result FROM jsonb_array_elements(value) AS items(item);
      RETURN result;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(key,public.__mc_loops_cutover_20260726_rewrite_loop_values(item)),'{}'::jsonb)
        INTO result FROM jsonb_each(value) AS items(key,item);
      RETURN result;
    ELSE RETURN value;
  END CASE;
END $$;

-- One atomic recovery statement. The namespace rename was also one atomic
-- forward statement, so recoverable catalog shapes are either all Projects or
-- all Loops; data/check transformations may be at any earlier checkpoint.
DO $loops_recovery$
DECLARE
  is_loop_namespace boolean;
  is_project_namespace boolean;
  metadata_present boolean;
  original_checks jsonb := '[]'::jsonb;
  event_table text;
  domain_table text;
  relation_name regclass;
  obj record;
  next_name text;
  replacement text;
  collisions bigint;
BEGIN
  is_loop_namespace := to_regclass('public.loops') IS NOT NULL
    AND to_regclass('public.loop_events') IS NOT NULL
    AND to_regclass('public.loop_work_items') IS NOT NULL;
  is_project_namespace := to_regclass('public.projects') IS NOT NULL
    AND to_regclass('public.project_events') IS NOT NULL
    AND to_regclass('public.project_work_items') IS NOT NULL;

  IF to_regclass('public.work_items') IS NULL THEN
    RAISE EXCEPTION 'Loops rollback recovery preflight: public.work_items is absent';
  END IF;
  IF is_loop_namespace = is_project_namespace THEN
    RAISE EXCEPTION 'Loops rollback recovery preflight: expected exactly one complete namespace (Loops or Projects); catalog is mixed/ambiguous';
  END IF;
  IF is_loop_namespace AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_items' AND column_name='loop_id'
  ) THEN
    RAISE EXCEPTION 'Loops rollback recovery preflight: Loop namespace lacks work_items.loop_id';
  END IF;
  IF is_project_namespace AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='work_items' AND column_name='project_id'
  ) THEN
    RAISE EXCEPTION 'Loops rollback recovery preflight: Projects namespace lacks work_items.project_id';
  END IF;
  IF is_loop_namespace THEN
    SELECT count(*) INTO collisions
    FROM public.work_items wi LEFT JOIN public.loops l ON l.id::text=wi.source_id::text
    WHERE wi.source_type='loop' AND l.id IS NULL
      AND (wi.status NOT IN ('done','failed','canceled','cancelled')
        OR NOT (wi.payload ? 'orphaned_source_loop_id')
        OR (wi.payload->>'orphaned_source_loop_id')::text IS DISTINCT FROM wi.source_id::text);
    IF collisions>0 THEN
      RAISE EXCEPTION 'Loops rollback recovery preflight: % orphan Loop source_id rows lack a valid marker',collisions;
    END IF;
  END IF;

  metadata_present := to_regclass('public.__mc_loops_cutover_20260726_source_type_checks') IS NOT NULL;
  IF metadata_present THEN
    EXECUTE 'SELECT coalesce(jsonb_agg(jsonb_build_object(''conname'',conname,''definition'',definition) ORDER BY conname),''[]''::jsonb)
               FROM public.__mc_loops_cutover_20260726_source_type_checks'
      INTO original_checks;
  ELSE
    -- Complete-forward rollback: derive the exact source definition by replacing
    -- only the controlled SQL literal. The fallback CHECK represents no source CHECK.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'conname',CASE WHEN is_loop_namespace THEN replace(c.conname,'loop','project') ELSE c.conname END,
             'definition',CASE WHEN is_loop_namespace
               THEN replace(pg_get_constraintdef(c.oid),'''loop''','''project''')
               ELSE pg_get_constraintdef(c.oid) END
           ) ORDER BY c.conname),'[]'::jsonb)
      INTO original_checks
    FROM pg_constraint c
    WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
      AND c.conname<>'work_items_source_type_loop_cutover_created'
      AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[];
  END IF;

  -- Removing current source_type CHECKs is safe inside this single transaction;
  -- exact source definitions are recreated before this statement commits.
  FOR obj IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
      AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I',obj.conname);
  END LOOP;

  -- Every inverse is selective/idempotent for a forward partial checkpoint.
  UPDATE public.work_items
  SET payload=public.__mc_loops_cutover_20260726_rewrite_loop_values(
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

  UPDATE public.work_items SET
    source_type=CASE WHEN source_type='loop' THEN 'project' ELSE source_type END,
    requested_by=CASE requested_by WHEN 'loop-planner' THEN 'project-planner' WHEN 'loop-execution-materializer' THEN 'project-execution-materializer' ELSE requested_by END
  WHERE source_type='loop' OR requested_by IN ('loop-planner','loop-execution-materializer');

  event_table := CASE WHEN is_loop_namespace THEN 'loop_events' ELSE 'project_events' END;
  domain_table := CASE WHEN is_loop_namespace THEN 'loops' ELSE 'projects' END;
  EXECUTE format($sql$
    UPDATE public.%I SET payload=public.__mc_loops_cutover_20260726_rewrite_loop_values(
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
       OR jsonb_path_exists(payload,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'))
  $sql$,event_table);
  EXECUTE format($sql$
    UPDATE public.%I SET
      event_type=regexp_replace(event_type,'^loop\.','project.'),
      actor=CASE actor WHEN 'loop-planner' THEN 'project-planner' WHEN 'loop-execution-materializer' THEN 'project-execution-materializer' ELSE actor END
    WHERE event_type LIKE 'loop.%%' OR actor IN ('loop-planner','loop-execution-materializer')
  $sql$,event_table);
  EXECUTE format($sql$
    UPDATE public.%I SET metadata=public.__mc_loops_cutover_20260726_rewrite_loop_values(metadata)
    WHERE jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','quick_loop_box'))
       OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-planner'))
       OR jsonb_path_exists(metadata,'$.** ? (@ == $value)',jsonb_build_object('value','loop-execution-materializer'))
  $sql$,domain_table);

  DROP INDEX IF EXISTS public.uq_loop_work_items_primary_execution__cutover_created;

  IF is_loop_namespace THEN
    ALTER TABLE public.loops RENAME TO projects;
    ALTER TABLE public.loop_events RENAME TO project_events;
    ALTER TABLE public.loop_work_items RENAME TO project_work_items;
    ALTER TABLE public.work_items RENAME COLUMN loop_id TO project_id;
    ALTER TABLE public.project_events RENAME COLUMN loop_id TO project_id;
    ALTER TABLE public.project_work_items RENAME COLUMN loop_id TO project_id;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='loop_id') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_items' AND column_name='project_id') THEN
        RAISE EXCEPTION 'Loops rollback recovery collision: pipeline_items has both loop_id and project_id';
      END IF;
      ALTER TABLE public.pipeline_items RENAME COLUMN loop_id TO project_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='loop_id') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recurrence_rules' AND column_name='project_id') THEN
        RAISE EXCEPTION 'Loops rollback recovery collision: recurrence_rules has both loop_id and project_id';
      END IF;
      ALTER TABLE public.recurrence_rules RENAME COLUMN loop_id TO project_id;
    END IF;
  END IF;

  -- Invert only names produced by forward. Collision checks stay inside the
  -- atomic recovery statement, so a failure leaves the prior checkpoint intact.
  FOR obj IN SELECT c.conrelid::regclass AS relation_name,c.conname FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname='public'
      AND (r.relname IN ('projects','project_events','project_work_items','work_items')
        OR (r.relname IN ('pipeline_items','recurrence_rules') AND EXISTS
          (SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema='public' AND ic.table_name=r.relname AND ic.column_name='project_id')))
      AND c.conname ILIKE '%loop%'
  LOOP
    next_name := replace(obj.conname,'loop','project');
    IF next_name<>obj.conname THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname=next_name) THEN
        RAISE EXCEPTION 'Loops rollback recovery destination constraint name exists: %',next_name;
      END IF;
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',obj.relation_name,obj.conname,next_name);
    END IF;
  END LOOP;
  FOR obj IN SELECT schemaname,indexname FROM pg_indexes i WHERE schemaname='public'
    AND (tablename IN ('projects','project_events','project_work_items','work_items')
      OR (tablename IN ('pipeline_items','recurrence_rules') AND EXISTS
        (SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema='public' AND ic.table_name=i.tablename AND ic.column_name='project_id')))
    AND indexname ILIKE '%loop%'
  LOOP
    next_name := replace(obj.indexname,'loop','project');
    IF next_name<>obj.indexname THEN
      IF to_regclass(format('public.%I',next_name)) IS NOT NULL THEN
        RAISE EXCEPTION 'Loops rollback recovery destination index name exists: %',next_name;
      END IF;
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',obj.schemaname,obj.indexname,next_name);
    END IF;
  END LOOP;

  -- Constraint names/definitions are restored from durable metadata for partial
  -- forward, or from the exact inverse definition for complete forward.
  FOR obj IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='public.work_items'::regclass AND c.contype='c'
      AND c.conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_type')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I',obj.conname);
  END LOOP;
  FOR obj IN SELECT value->>'conname' AS conname,value->>'definition' AS definition
    FROM jsonb_array_elements(original_checks)
  LOOP
    IF position('''loop''' IN obj.definition)>0 THEN
      RAISE EXCEPTION 'Loops rollback recovery cannot restore source CHECK %: derived definition still contains loop literal',obj.conname;
    END IF;
    EXECUTE format('ALTER TABLE public.work_items ADD CONSTRAINT %I %s',obj.conname,obj.definition);
  END LOOP;
END $loops_recovery$;

-- No helper objects remain after successful recovery. Includes the forward
-- helper because failure may have occurred before forward cleanup.
DO $rollback_cleanup$ BEGIN
  DROP FUNCTION IF EXISTS public.__mc_loops_cutover_20260726_rewrite_project_values(jsonb);
  DROP FUNCTION IF EXISTS public.__mc_loops_cutover_20260726_rewrite_loop_values(jsonb);
  DROP TABLE IF EXISTS public.__mc_loops_cutover_20260726_source_type_checks;
END $rollback_cleanup$;
RESET lock_timeout;
RESET statement_timeout;
COMMIT;
