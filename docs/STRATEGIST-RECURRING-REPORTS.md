# Strategist recurring reports

Mission Control now schedules strategist reports through the active Work Queue recurring system:

- `recurring_work_rules`
- `recurring_work_occurrences`
- `work_items`

Do **not** revive the legacy `recurrence_rules` / `recurrence_materializations` path for new reports.

## Architecture

1. `com.aipaths.daily-scrape` remains the data ingestion job.
   - It runs scrapers and writes canonical Mission Control reporting tables.
   - It should not dispatch AI report-writing work.
2. Work Queue materializes report tasks.
   - `work-item-scheduler.ts` calls `/api/work-items/recurring-rules/materialize`.
   - `src/lib/work-items/recurring.ts` expands the strategist cadence-router rule.
3. Strategist executes the resulting `work_items` through the normal notify/dispatch path.

## Cadence router

The seeded rule is `Strategist reporting review` with `metadata.mode = "cadence_router"` and `metadata.category = "strategist_reporting"`.

For each Europe/London local date, the router creates exactly one report task:

1. Day of month `1` → `Monthly review — YYYY-MM`
2. Monday → `Weekly review — YYYY-MM-DD`
3. Otherwise → `Daily review — YYYY-MM-DD`

Monthly supersedes weekly/daily. Weekly supersedes daily.

## Canonical report sources

Report tasks should read Mission Control canonical tables:

- `ops_daily_snapshots`
- `academy_daily_kpis`
- `ops_youtube_video_daily`
- `ops_youtube_channel_daily`
- `ops_youtube_short_daily`
- `ops_community_daily`
- `ops_youtube_comments`
- `intel_items_raw`
- `intel_trend_daily`

Legacy Academy `daily_digest` is archival and must not be a new-report source.

## Seed / migration

Migration:

- `supabase/migrations/026_seed_strategist_reporting_recurring_rule.sql`

It inserts the strategist router rule if it does not already exist, comments active recurring tables, and marks legacy recurrence/reporting tables deprecated when present. It does not drop legacy tables.

## Dry-run

Use the non-mutating preview endpoint:

```bash
curl -s "http://localhost:3001/api/work-items/recurring-rules/materialize?dry_run=1&days=14"
```

Expected shape for the strategist rule: 14 upcoming local dates, one title per date, with monthly on day 1, weekly on Mondays, daily otherwise.

## Backout

Safe backout is to disable the seeded row:

```sql
update public.recurring_work_rules
set enabled = false, updated_at = now()
where title = 'Strategist reporting review'
  and owner_agent = 'strategist'
  and metadata ->> 'category' = 'strategist_reporting';
```

This stops new materialization. Existing `work_items` can be cancelled/requeued manually from Work Queue if needed.

## Cleanup plan

Do not drop legacy tables yet.

After at least two stable weekly reports from canonical Mission Control tables:

1. Confirm no active code or LaunchAgent uses `recurrence-reconciler` or legacy strategist recurrence.
2. Export/backup legacy tables needed for audit.
3. Remove active references to legacy `recurrence_*` and Academy reporting tables.
4. Rename/archive legacy tables or drop them only after explicit approval.
