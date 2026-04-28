# Intel Inbox hardening

Updated: 2026-04-28

## What this covers

The Intel Inbox now exposes enough context to distinguish weak title-only signals from enriched signals backed by Reddit discussion context or YouTube transcript summaries.

## UI/health behavior

`/intel` displays a compact health strip with:

- `Raw 3d`: raw intel rows first seen in the last 3 days.
- `Enriched 3d`: enriched rows created in the last 3 days.
- `Inbox visible`: current total inbox rows after filters/status mapping.
- `Reddit ctx`: recent enriched rows that used stored Reddit comments.
- `YT transcript ctx`: recent enriched rows that used competitor transcript summaries.
- `Transcripts`: summarized/fetched transcript counts.
- `Unavailable/failed`: transcript fetch/summary failures.
- `Snapshot dupes`: duplicate `competitor_video_snapshots` rows detected by `(competitor_channel_id, video_id)`.

The health badge is `warn` if there are unresolved competitor sources, failing sources, transcript failures, or duplicate snapshot rows.

## Source-context badges

Intel cards and details can show:

- `Reddit discussion · N comentarios` when Reddit comment context was persisted/used.
- `Reddit · sin comentarios cargados` when the item is Reddit but no comments are available.
- `YouTube transcript` when `metadata_json.transcript_summary_used=true`.
- `YouTube title only` when the YouTube item has no transcript context.

## Operational note

On 2026-04-28, existing duplicate `competitor_video_snapshots` rows were cleaned after approval. JSON backups of deleted rows were written under `director-systems/outgoing/competitor-video-snapshot-duplicates*.json`. The live table was verified at 66 rows with 0 duplicate groups.

## Guardrails

- Do not rely on YouTube RSS title/channel metadata alone when transcript summaries are available.
- Keep duplicate snapshot prevention in the Strategist fetcher; the Mission Control UI should only report if duplicates reappear.
- If `Snapshot dupes` becomes non-zero again, inspect the Strategist fetch path before deleting rows.
