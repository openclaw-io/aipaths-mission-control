-- Strategist report cadence router for Work Queue recurring work.
-- This keeps data ingestion separate: com.aipaths.daily-scrape remains the canonical
-- scraper/snapshot job; this rule only materializes strategist report work_items.

insert into public.recurring_work_rules (
  title,
  instruction,
  owner_agent,
  target_agent_id,
  requested_by,
  priority,
  cadence_unit,
  cadence_interval,
  time_of_day,
  timezone,
  start_date,
  horizon_days,
  enabled,
  metadata
)
select
  'Strategist reporting review',
  'Cadence-router rule. Materialize exactly one strategist report task per local date: monthly on day 1, weekly on Mondays, daily otherwise. Use Mission Control canonical reporting tables only. Keep com.aipaths.daily-scrape as the data ingestion job.',
  'strategist',
  'strategist',
  'systems',
  'medium',
  'days',
  1,
  '07:00',
  'Europe/London',
  current_date,
  14,
  true,
  jsonb_build_object(
    'mode', 'cadence_router',
    'category', 'strategist_reporting',
    'monthly_day', 1,
    'weekly_weekday', 1,
    'channel_reports', '1474386202835685457',
    'channel_agent_log', '1473660854800224316',
    'source_tables', jsonb_build_array(
      'ops_daily_snapshots',
      'academy_daily_kpis',
      'ops_youtube_video_daily',
      'ops_youtube_channel_daily',
      'ops_youtube_short_daily',
      'ops_community_daily',
      'ops_youtube_comments',
      'intel_items_raw',
      'intel_trend_daily'
    ),
    'deprecated_legacy_sources', jsonb_build_array(
      'recurrence_rules',
      'recurrence_materializations',
      'daily_digest'
    ),
    'cleanup_backout', 'Disable this recurring_work_rules row to stop new report tasks. Do not drop legacy recurrence_* or daily_digest tables until two stable weekly reports have been verified.'
  )
where not exists (
  select 1
  from public.recurring_work_rules
  where title = 'Strategist reporting review'
    and owner_agent = 'strategist'
    and metadata ->> 'category' = 'strategist_reporting'
);

comment on table public.recurring_work_rules is 'Active Work Queue recurring rules. Strategist reports use metadata.mode=cadence_router here, not legacy recurrence_rules.';
comment on table public.recurring_work_occurrences is 'Materialized Work Queue recurring occurrences. Idempotent by rule_id + occurrence_key.';

do $$
begin
  if to_regclass('public.recurrence_rules') is not null then
    comment on table public.recurrence_rules is 'DEPRECATED: legacy strategist recurrence path. Do not revive for new reports; use recurring_work_rules / recurring_work_occurrences / work_items. Keep for audit/backout until cleanup is approved.';
  end if;

  if to_regclass('public.recurrence_materializations') is not null then
    comment on table public.recurrence_materializations is 'DEPRECATED: legacy recurrence materialization audit table. New report tasks are materialized through recurring_work_occurrences and work_items.';
  end if;

  if to_regclass('public.daily_digest') is not null then
    comment on table public.daily_digest is 'DEPRECATED legacy reporting table. New strategist reports must read canonical Mission Control reporting tables, especially ops_daily_snapshots.';
  end if;
end $$;
