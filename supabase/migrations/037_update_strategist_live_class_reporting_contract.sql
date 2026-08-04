-- Apply Gonza's 2026-08-04 Strategist reporting decision to existing rows.
-- Migration 026 seeds fresh installs; this migration updates already-materialized
-- Mission Control state without changing cadence.

do $$
declare
  strategist_rule_id uuid := 'e9fa4aa5-7c88-4241-a4e2-d08b8164f460';
  report_instruction text := 'Cadence-router rule. Materialize exactly one strategist report task per local date: monthly on day 1, weekly on Mondays, daily otherwise. Use the 2026-08-04 live-class reporting contract only. Keep com.aipaths.daily-scrape as the data ingestion job.';
  live_metadata jsonb := jsonb_build_object(
    'mode', 'cadence_router',
    'category', 'strategist_reporting',
    'contract_version', 'live_class_reporting_v1_2026_08_04',
    'contract_decision_date', '2026-08-04',
    'contract_path', '/Users/joaco/openclaw/director-strategist/analytics/live-class-reporting-contract-2026-08-04.md',
    'monthly_day', 1,
    'weekly_weekday', 1,
    'channel_reports', '1474386202835685457',
    'channel_agent_log', '1473660854800224316',
    'report_sections', jsonb_build_array(
      'edition_live_registrations',
      'top_3_acquisition_channels_by_signups',
      'global_funnel_views_clicks_signups_ventas',
      'community_new_members'
    ),
    'source_tables', jsonb_build_array(
      'academy.live_events',
      'academy.events',
      'academy.live_registrations',
      'academy.orders',
      'mission_control.ops_community_member_daily'
    ),
    'canonical_fields', jsonb_build_object(
      'edition', jsonb_build_object(
        'table', 'academy.live_events',
        'fields', jsonb_build_array('id', 'slug', 'title', 'starts_at', 'status'),
        'selection', 'Use slug=tu-primer-agente-ia; if multiple editions are open, keep selected id/starts_at explicit.'
      ),
      'views', jsonb_build_object(
        'table', 'academy.events',
        'event_type', 'live_landing_view',
        'time_field', 'timestamp',
        'metric', 'Unique live-class landing sessions in the reporting window.'
      ),
      'cta_clicks', jsonb_build_object(
        'table', 'academy.events',
        'event_type', 'live_registration_started',
        'time_field', 'timestamp',
        'metric', 'Registration CTA/form-start clicks in the reporting window.'
      ),
      'live_registrations', jsonb_build_object(
        'table', 'academy.live_registrations',
        'time_field', 'registered_at',
        'fields', jsonb_build_array('id', 'event_id', 'status', 'registered_at', 'source', 'ref', 'first_ref', 'last_ref', 'visitor_id', 'session_id')
      ),
      'acquisition_channels', jsonb_build_object(
        'primary', 'academy.live_registrations.first_ref normalized with derive_attribution_source',
        'fallback', 'academy.live_registrations.source, then ref/last_ref, labelled as fallback when first_ref is unavailable',
        'ranking', 'Rank only channels with at least one live registration; order by signup count and show count/share.'
      ),
      'ventas', jsonb_build_object(
        'table', 'academy.orders',
        'time_field', 'completed_at',
        'fields', jsonb_build_array('id', 'status', 'completed_at', 'amount', 'currency', 'product_id', 'current_ref', 'first_ref', 'last_ref', 'visitor_id', 'session_id'),
        'attribution', 'Completed paid orders attributable to the live-class/cohort path by registration visitor/session match or live-class ref evidence. If attribution coverage is incomplete, report N/D.'
      ),
      'community_new_members', jsonb_build_object(
        'table', 'mission_control.ops_community_member_daily',
        'time_field', 'date',
        'fields', jsonb_build_array('date', 'new_human_members', 'human_members_at_check', 'total_members_at_check', 'checked_at', 'coverage'),
        'metric', 'sum(new_human_members)',
        'window', 'Sum closed Europe/London calendar dates inside the report window. For daily, require the previous complete local date row.',
        'freshness', 'Return N/D when the expected closed-date row is absent. Current totals belong to checked_at, not date.',
        'backfill_note', 'Rows with coverage=current_member_list_backfill are incomplete because members who departed before the first sync are unrecoverable.'
      )
    ),
    'acquisition_attribution', jsonb_build_object(
      'primary', 'academy.live_registrations.first_ref normalized with derive_attribution_source',
      'fallback', 'academy.live_registrations.source, then ref/last_ref, labelled as fallback when first_ref is unavailable',
      'ranking', 'Rank only channels with at least one live registration; order by signup count and show count/share.'
    ),
    'missing_coverage_policy', jsonb_build_object(
      'value', 'N/D',
      'rule', 'Use N/D, not 0, when a source/table/field/window was not successfully checked for full coverage. Report zero only after successful full-window coverage.'
    ),
    'deprecated_legacy_sources', jsonb_build_array(
      'recurrence_rules',
      'recurrence_materializations',
      'daily_digest'
    ),
    'cleanup_backout', 'Disable this recurring_work_rules row to stop new report tasks. Do not drop legacy recurrence_* or daily_digest tables until two stable weekly reports have been verified.'
  );
  stale_keys text[] := array[
    'daily_primary_field',
    'excluded_routine_sources',
    'diagnostic_reporting_mode',
    'reporting_contract_version',
    'diagnostic_tracking_cutoff_at',
    'diagnostic_tracking_cutoff_reason'
  ];
begin
  update public.recurring_work_rules
     set instruction = report_instruction,
         metadata = (metadata - stale_keys) || live_metadata,
         updated_at = now()
   where id = strategist_rule_id;

  update public.work_items
     set instruction = concat(
           'Prepare the ',
           case payload ->> 'report_type'
             when 'monthly_review' then 'monthly'
             when 'weekly_review' then 'weekly'
             else 'daily'
           end,
           ' strategist report for ',
           case payload ->> 'report_type'
             when 'monthly_review' then coalesce(payload ->> 'month', payload ->> 'report_date')
             else coalesce(payload ->> 'report_date', split_part(title, ' — ', 2))
           end,
           E'.\n\nUse the live-class reporting contract. The report must contain only: (1) edition-specific live class registrations, (2) top 3 acquisition channels that produced those registrations, ordered by signups with count/share, (3) global funnel Views -> Clicks -> Signups -> Ventas, and (4) new Community members.\n\nCanonical fields: views from academy.events event_type=live_landing_view; CTA clicks from academy.events event_type=live_registration_started; signups from academy.live_registrations by event_id and registered_at; ventas from academy.orders completed orders attributable to the live-class/cohort path; Community joins from mission_control.ops_community_member_daily by date, summing new_human_members for closed Europe/London days.\n\nUse first-touch acquisition when available: live_registrations.first_ref normalized with derive_attribution_source. If first_ref is unavailable, use source/ref/last_ref as a labelled fallback.\n\nNever report a false zero. Use N/D when source coverage or tracking is missing; report 0 only when the relevant source was checked for the full reporting window.\n\nKeep the report strictly to those four sections; no extra analysis, broad rankings, broad platform metrics, tasks, commentary, or fan-out.\n\nDo not read Academy legacy daily_digest or legacy recurrence tables.\n\nKeep com.aipaths.daily-scrape as the data ingestion source, then post the finished report through the normal strategist reporting path and close this work item.'
         ),
         payload = (payload - stale_keys) || live_metadata || jsonb_build_object(
           'trigger', 'recurring_work_rule',
           'recurring_rule_id', strategist_rule_id::text,
           'cadence_unit', 'days',
           'cadence_interval', 1,
           'timezone', 'Europe/London',
           'legacy_sources_deprecated', jsonb_build_array('recurrence_rules', 'recurrence_materializations', 'daily_digest')
         ),
         updated_at = now()
   where source_type = 'service'
     and source_id = strategist_rule_id::text
     and scheduled_for >= now()
     and status = 'ready'
     and started_at is null
     and completed_at is null;

  insert into public.event_log (domain, event_type, entity_type, entity_id, actor, payload)
  values (
    'work',
    'recurring_work.rule_contract_updated',
    'recurring_work_rule',
    strategist_rule_id,
    'dev',
    jsonb_build_object(
      'contract_version', live_metadata ->> 'contract_version',
      'contract_decision_date', live_metadata ->> 'contract_decision_date',
      'updated_future_ready_work_items', (
        select count(*)
          from public.work_items
         where source_type = 'service'
           and source_id = strategist_rule_id::text
           and scheduled_for >= now()
           and status = 'ready'
           and started_at is null
           and completed_at is null
      )
    )
  );
end $$;
