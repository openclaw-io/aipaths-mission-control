# YouTube Pipeline V0

Mission Control `/youtube` is the current operating surface for AIPaths long-form YouTube work.

## Canonical storage

- Table: `pipeline_items`
- Filter: `pipeline_type = 'video'`
- Owner: `owner_agent = 'youtube'`
- Most YouTube-specific fields live in `pipeline_items.metadata`.
- Historical Notion imports use:
  - `source_type = 'manual'`
  - `source_id = <notion_page_id>`
  - `metadata.imported_from = 'notion_video_pipeline'`

## V0 stages

The UI is intentionally simpler than the old gate/scoring model.

Main stages:

1. `idea` / `draft` — Ideas
2. `title_thumbnail` — Title / Thumbnail
3. `research` / `researching` — Research
4. `bullets` — Chapter bullets / recording structure
5. `ready_to_record` — Ready to record
6. `recorded` / `editing` — Editing
7. `scheduled` — Launch package prepared; waiting for the scheduled public release
8. `published` — Public URL verified
9. `parked` / `rejected` / `archived` — inactive

`learning` is no longer a workflow stage. Postmortems, manual review, and performance learning remain attached to Published videos through metadata and `/statistics`.

## UI layout

The `/youtube` board has three working views:

1. **Ideas → Titles → Research**
   - Top row: Title / Thumbnail and Research queues.
   - Bottom: Ideas full-width, because Ideas can have much higher volume.
2. **Bullets → Ready**
   - Production preparation view.
3. **Editing → Scheduled → Published**
   - Scheduling, public verification, release, and post-publication measurement.

Parked/archived items appear in a collapsed section below the main board.

## Item drawer MVP

Clicking an item opens a drawer focused on the current decision, not a full metadata dump.

Always shown:

- item title
- current status
- source label if available
- stage transition control

Primary section: **Ahora importa**

This section changes by stage:

- `idea` / `draft`: summary, why it matters, source, tags
- `title_thumbnail`: selected title, title candidates, thumbnail direction
- `research`: hypothesis, evidence, research/report
- `bullets`: intro and chapter/recording bullets
- `ready_to_record`: final title, hook/intro, locked bullets, CTA
- `recorded` / `editing`: edit status, assets, production notes
- `scheduled`: launch time, URL/video ID, preflight, drafts, approvals, and pending live-check
- `published`: YouTube URL, video ID, published date, publication notes

Learning notes remain visible in the metadata and Statistics surfaces for Published videos.

Collapsed by default:

- Work Items
- Full metadata

## Stage transition API

Endpoint:

`POST /api/youtube/[id]/transition`

V0 action:

```json
{
  "action": "set_stage",
  "stage": "title_thumbnail",
  "note": "optional note",
  "youtube_url": "optional publication URL",
  "video_id": "optional YouTube video ID"
}
```

Behavior:

- updates `pipeline_items.status`
- updates `metadata.youtube_v0.stage`
- appends lightweight `metadata.youtube_v0.history[]`
- preserves older transition actions for compatibility

`scheduled` is intentionally not accepted by the generic stage transition. Scheduling is an orchestration command because it must reconcile the exact card and its launch package:

`POST /api/youtube/launch-package`

```json
{
  "pipeline_item_id": "exact video pipeline UUID",
  "youtube_url": "https://youtube.com/watch?v=...",
  "publish_at": "2026-08-04T13:00:00Z"
}
```

The command moves a nonpublished video to `scheduled`, creates or reconciles the nine launch work items, and keeps `current_url`/`published_at` empty until the live-check proves the video public. Completion of `video_launch_activate` is the canonical `scheduled → published` transition. Manual Published is blocked for scheduled launch packages to prevent duplicate email/snapshot fan-out.

Stage transitions also create deduped YouTube Director work items for the main automation handoffs:

- moving to `title_thumbnail` creates `youtube_light_research`
  - short `Video Opportunity Brief` in markdown for prioritization
  - category/pillar, target persona, persona fit against `director-youtube/context/persona.md`, promise, why it could work, risks, initial 0-10 score, recommendation
  - contrast against AIPaths channel patterns: concrete problem/object, clear promise, clear viewer, simple tension, and fit with proven topics
  - title candidates and thumbnail directions
- moving to `research` / `researching` creates `youtube_deep_research`
  - competitor/transcript scan where available
  - demand, supply gap, AIPaths angle, risks, recommendation
- moving to `bullets` creates `youtube_bullet_points`
  - chronological chapters and recording bullets
  - not a full script

For legacy videos without a launch package, transitioning to `published` can create scheduled follow-up work items for:

- `youtube_snapshot_24h`
- `youtube_snapshot_7d`
- `youtube_snapshot_28d`

These are for views/likes/comments/top-comment learning. CTR and retention remain manual/optional unless a reliable source is added later.

## Notion import snapshot

On 2026-05-01, historical Notion Video Pipeline rows were imported into `pipeline_items`.

- Source DB: `NOTION_VIDEO_PIPELINE_DB`
- Imported rows: 35
- Skipped rows: 0
- Resulting video total: 39 rows
- Status totals after import:
  - `published`: 19
  - `idea`: 15
  - `draft`: 1
  - `ready_to_record`: 1
  - `learning`: 2 (historical import value; migrated to `published` in the 2026-07-31 stage cutover)
  - `title_thumbnail`: 1

Notion DB access found during import:

- Video Pipeline: accessible, 35 rows
- Post-Mortems: accessible, 0 rows
- Ideas Bank: not shared with the current Notion integration
