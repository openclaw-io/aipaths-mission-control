-- Recurring Work Rules
-- Keeps recurring operational work visible in Work Queue Calendar without creating infinite tasks.

create table if not exists public.recurring_work_rules (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  instruction text not null,
  owner_agent text not null,
  target_agent_id text,
  requested_by text not null default 'system',
  priority text default 'medium',
  cadence_unit text not null default 'days' check (cadence_unit in ('days', 'weeks')),
  cadence_interval integer not null default 1 check (cadence_interval > 0),
  time_of_day text not null default '02:30',
  timezone text not null default 'Europe/London',
  start_date date not null default current_date,
  end_date date,
  horizon_days integer not null default 28 check (horizon_days > 0 and horizon_days <= 120),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  last_materialized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recurring_work_occurrences (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.recurring_work_rules(id) on delete cascade,
  occurrence_key text not null,
  scheduled_for timestamptz not null,
  work_item_id uuid references public.work_items(id) on delete set null,
  status text not null default 'materialized',
  created_at timestamptz not null default now(),
  unique(rule_id, occurrence_key)
);

create index if not exists idx_recurring_work_rules_enabled on public.recurring_work_rules(enabled, start_date);
create index if not exists idx_recurring_work_occurrences_rule_scheduled on public.recurring_work_occurrences(rule_id, scheduled_for);
create index if not exists idx_recurring_work_occurrences_work_item on public.recurring_work_occurrences(work_item_id);
