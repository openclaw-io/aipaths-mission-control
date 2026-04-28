# Work Queue

Mission Control `/work-items` is the canonical operator surface for executable `work_items`.

## Tabs

- **Live Board**: current operational queue. Shows running work, ready work, blocked work, failed work, and compact Work activity.
- **Calendar**: scheduled work by day. Past/completed work remains visible but visually muted. Director ownership is shown via subtle pastel left borders.
- **Recurring Tasks**: recurring rule controls for work that should appear on the calendar.

Launchd/cron runtime health does **not** belong in Work Queue activity. Keep that in `/crons` and launchd diagnostics.

## Calendar UI rules

- Calendar cells show day numbers pinned top-left.
- Today uses a subtle red marker; selected day uses a neutral gray marker.
- Work cards are chronologically ordered by `scheduled_for`.
- Completed/canceled scheduled work is muted but keeps the director color family.
- Failed/pending past work should remain visually distinct and not look completed.

Director color accents:

| Director | Accent |
|---|---|
| content | cyan |
| dev | green |
| community | violet |
| marketing | yellow |
| strategist | orange |
| systems | sky |
| youtube | rose |

## Work activity

Live Board includes **Work activity** at the bottom:

- shows useful Work Queue `event_log` entries only;
- hides noisy `recurring_work.materialized` events;
- starts with 10 events and expands via **View more**;
- does not use scrollbars;
- opens the linked work item when available.

## Recurring Tasks

Recurring Tasks cards are intentionally compact:

- description and metrics are collapsed by default;
- click a card to expand/collapse details;
- the Apple-style switch toggles `recurring_work_rules.enabled`.

Pause/resume behavior:

- Pausing (`enabled:false`) stops future materialization and deletes only future generated occurrences whose linked work item is still `ready`, unstarted, and uncompleted.
- Resuming (`enabled:true`) re-runs the recurring materializer to refill the rolling horizon.
- The API logs `recurring_work.rule_paused` and `recurring_work.rule_resumed` events.

Current Systems recurring rules are intentionally interleaved:

- `Systems repo hygiene check`: every 2 days at 02:30 Europe/London, starting 2026-04-27.
- `Systems backup all agents`: every 2 days at 03:00 Europe/London, starting 2026-04-28.
