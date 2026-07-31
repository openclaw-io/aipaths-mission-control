# YouTube Scheduled stage cutover — 2026-07-31

## Purpose

Make `scheduled` the canonical workflow stage between Editing and Published, and retire `learning` as a workflow stage. Learning/postmortem data remains in metadata and Statistics.

## Scope

Run independently against each Mission Control store. Do not use `sync-local-core-from-cloud.mjs` for this cutover: local and cloud are intentionally divergent.

Expected at preparation time:

- Local: 4 legacy Learning videos and 1 active scheduled launch still marked Editing.
- Cloud: 4 legacy Learning videos and no active scheduled launch matching the semantic predicate.

## Safety sequence

1. Take a verified database backup and export every row selected by `preflight.sql`.
2. Run `preflight.sql`; it raises and aborts on any `BLOCKER_*` row or prior backup.
3. Deploy/build the application contract before exposing the migrated state.
4. For each `BLOCKER_RECONCILE_LAUNCH_PACKAGE`, run the deployed local launch-package reconciliation against the exact `pipeline_item_id`, same video ID and same `publish_at`. This must preserve terminal drafts, update the six open schedules in place, persist `launch_generation` plus the canonical activation work-item ID, set `current_url=null`, and leave exactly nine launch work items for the current package.
5. Enter a short maintenance window: stop the Mission Control LaunchAgent and every scheduler/worker capable of writing `pipeline_items`, `work_items`, or `pipeline_work_map`; verify the HTTP port is down and no application-role transaction remains active in `pg_stat_activity`.
6. Rerun `preflight.sql` while writers are quiesced; every active package must report `ready` and exactly one open activation.
7. Run `forward.sql` once, independently per store. If PostgreSQL returns `40P01` or a lock timeout, roll back, re-check writer quiescence, and retry the complete file once; never continue from a partial statement.
8. Restart the stopped runtime services and verify `/api/healthz`, `/youtube`, the exact scheduled card, and unchanged work-item schedules.

Do not migrate through `/api/youtube/[id]/transition`: that legacy transition can create email/snapshot side effects and fabricate `published_at`.

## Backup and rollback

`forward.sql` creates `mission_control_migration_backup.youtube_stage_20260731` in a schema with PUBLIC access revoked. It stores complete pre-change rows plus the exact cutover timestamp.

`rollback.sql` restores only the four fields changed by this migration and only while every target row still has the exact cutover timestamp and expected migrated shape. It refuses delayed/repeated rollback rather than overwriting post-cutover edits. Keep the private backup through verification.

## Invariants

- Never fabricate `published_at`, video IDs, publication history, or public evidence.
- Never modify launch work-item status or schedule during the data cutover.
- `scheduled` requires an active nonpublished launch package and `scheduled_for`.
- `current_url` remains null before public verification; the private/scheduled URL stays in metadata.
- `Learning` remains an analytics/postmortem concept, not `pipeline_items.status`.
- The launch-package command is local-runtime only until cloud completion has an equivalent transactional implementation.
