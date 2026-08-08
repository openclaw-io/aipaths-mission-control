-- GON-91 / GON-88 — saca la ruta de máquina del contrato de reporting de Strategist.
--
-- La migración 037 sembró `contract_path` como ruta absoluta
-- (`/Users/joaco/openclaw/director-strategist/analytics/…`) tanto en la regla recurrente como
-- en el payload de los work items futuros. Al mudar los `director-*` a `<workspace>/agents/`
-- (GON-71) esa ruta deja de existir, y como está PERSISTIDA en datos no la arregla ningún
-- barrido de archivos: es el hallazgo de GON-88.
--
-- 037 no se edita — tiene que seguir siendo reproducible sobre una instalación limpia. Esta la
-- corrige hacia adelante.
--
-- La ruta nueva es RELATIVA al directorio de agentes. Es el único valor correcto en las dos
-- máquinas de la flota, que tienen `$HOME` distinto y layouts de distinta profundidad. El
-- código que la siembra (`src/lib/work-items/recurring.ts`) ya emite esta misma forma.
--
-- Idempotente: sólo toca filas que todavía tienen la ruta vieja.

do $$
declare
  strategist_rule_id uuid := 'e9fa4aa5-7c88-4241-a4e2-d08b8164f460';
  old_path text := '/Users/joaco/openclaw/director-strategist/analytics/live-class-reporting-contract-2026-08-04.md';
  new_path text := 'director-strategist/analytics/live-class-reporting-contract-2026-08-04.md';
  touched_rules integer;
  touched_items integer;
begin
  update public.recurring_work_rules
     set metadata = jsonb_set(metadata, '{contract_path}', to_jsonb(new_path), true),
         updated_at = now()
   where id = strategist_rule_id
     and metadata ->> 'contract_path' = old_path;
  get diagnostics touched_rules = row_count;

  -- Sólo los que todavía pueden ejecutarse. Los `done`/`canceled`/`failed` son historial y no
  -- se reescriben: un registro histórico con la ruta que de verdad se usó vale más que uno
  -- retocado para que quede prolijo.
  update public.work_items
     set payload = jsonb_set(payload, '{contract_path}', to_jsonb(new_path), true),
         updated_at = now()
   where payload ->> 'contract_path' = old_path
     and status = 'ready'
     and completed_at is null;
  get diagnostics touched_items = row_count;

  insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
  values (
    'work',
    'recurring_work.rule_contract_path_relativized',
    'recurring_work_rule',
    strategist_rule_id,
    'systems',
    jsonb_build_object(
      'reason', 'GON-71 mueve los director-* fuera de la ruta absoluta sembrada por la 037',
      'old_path', old_path,
      'new_path', new_path,
      'updated_rules', touched_rules,
      'updated_ready_work_items', touched_items
    )
  );

  raise notice 'contract_path relativizado: % regla(s), % work_item(s) ready', touched_rules, touched_items;
end $$;
