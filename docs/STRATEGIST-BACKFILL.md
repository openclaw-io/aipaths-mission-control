# Strategist Backfill

Migration `016_create_strategist_internal_analytics.sql` created the base destination schema in Mission Control.
Migration `018_create_ops_youtube_comments.sql` added the canonical comment table needed for the remaining strategist cutover.

Status update (2026-04-20): the live strategist runtime cutover is complete. Academy migration `104_archive_strategist_legacy_analytics.sql` has archived the retired Academy strategist tables for reference, so this operator toolset now exists mainly for validation, audit, and any carefully-scoped historical follow-up.

This repo includes a conservative operator toolset for strategist analytics backfill from Academy Supabase into Mission Control.

## Files

- `scripts/backfill-strategist-analytics.mjs`
- `scripts/validate-strategist-backfill.mjs`
- `scripts/lib/strategist-backfill-common.mjs`

## In scope

Source Academy tables:
- `external_signals`
- `trend_snapshots`
- `community_activity`
- `channel_metrics`
- `youtube_metrics`
- `youtube_shorts_metrics`
- `youtube_comments`

Destination Mission Control tables:
- `intel_items_raw`
- `intel_trend_daily`
- `ops_community_daily`
- `ops_youtube_channel_daily`
- `ops_owned_videos`
- `ops_youtube_video_daily`
- `ops_youtube_short_daily`
- `ops_youtube_comments`
- `pipeline_runs`

## Not in scope yet

- historical backfill for `academy_daily_kpis`
- historical backfill for `ops_daily_snapshots`
- direct copy of `daily_digest`

Runtime writes for `academy_daily_kpis` and `ops_daily_snapshots` now belong in Strategist's daily pipeline, but historical bootstrap/backfill still remains phase 2.

## Mapping

### External intelligence
- `external_signals` -> `intel_items_raw`
- `source` maps through `intel_sources.source_key`
- `canonical_url = url`
- `source_context = subreddit`
- `engagement_score = score`
- `engagement_count = comments_count`
- `metadata` is parsed into `metadata_json`, or stored as `{ raw: ... }` if not valid JSON

### Trends
- `trend_snapshots` -> `intel_trend_daily`

### Community
- `community_activity` -> `ops_community_daily`
- `notable_messages` is parsed into `notable_messages_json`

### YouTube channel
- `channel_metrics` -> `ops_youtube_channel_daily`

### YouTube long-form
- `youtube_metrics` -> `ops_owned_videos` + `ops_youtube_video_daily`
- `ops_owned_videos` mirrors Academy video metadata minimally
- `video_kind = 'longform'`

### YouTube Shorts
- `youtube_shorts_metrics` -> `ops_owned_videos` + `ops_youtube_short_daily`
- `video_kind = 'short'`
- if an Academy `videos` row is missing, fallback title is the `academy_video_id`

### YouTube comments
- `youtube_comments` -> `ops_owned_videos` + `ops_youtube_comments`
- `video_kind = 'longform'`
- keeps comment-level rows canonical in Mission Control for daily snapshots and comment analysis

## Env assumptions

The scripts read:
- Mission Control env: `aipaths-mission-control/.env.local`
- Academy env: `/Users/joaco/Documents/openclaw/repos/aipaths-academy/.env.local`

Expected keys:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Safety model

- **dry-run is the default**
- nothing writes unless `--write` is passed
- `pipeline_runs` rows are created only for actual writes
- no destructive action is performed by these scripts

## Usage

### Dry-run a single table

```bash
npm run backfill:strategist -- --table=external_signals
```

### Dry-run everything

```bash
npm run backfill:strategist -- --all
```

### Write one table

```bash
npm run backfill:strategist -- --table=trend_snapshots --write
```

### Write everything

```bash
npm run backfill:strategist -- --all --write
```

### Limit rows for testing

```bash
npm run backfill:strategist -- --table=youtube_metrics --limit=25
```

### Validate after backfill

```bash
npm run validate:strategist-backfill -- --all
```

## Recommended run order

1. Dry-run one table at a time
2. Dry-run all tables
3. Write lower-risk tables first:
   - `trend_snapshots`
   - `channel_metrics`
   - `community_activity`
4. Write heavier tables next:
   - `external_signals`
   - `youtube_metrics`
   - `youtube_shorts_metrics`
   - `youtube_comments`
5. Run validation
6. Use Strategist runtime builders for forward-fill of `academy_daily_kpis` and `ops_daily_snapshots`
7. Only then plan any historical phase-2 bootstrap for curated snapshots

## Caveats

- `ops_owned_videos` uses `academy_video_id` as the unique local mirror key.
- This tool assumes the seeded `intel_sources` rows exist in Mission Control.
- `academy_daily_kpis` historical backfill is intentionally deferred because it should be built from conservative Academy rollups, not guessed from mixed legacy tables.
- `ops_daily_snapshots` should be forward-filled by the runtime builder first. Any historical bootstrap should preserve lineage and avoid turning legacy `daily_digest` into the canonical source.
