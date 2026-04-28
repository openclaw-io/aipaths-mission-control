# Intel Community Tool/Startup Promotion

Date: 2026-04-28

## Goal

Extend Intel Inbox so Gonza can promote emerging AI tools and startups into Community Director drafts, distinct from normal News/radar promotion.

## Flow

1. Strategist enrichment tags trend/raw items with `metadata_json.suggested_destinations` when a signal looks like:
   - `tool`: Product Hunt, new AI tools, agent/coding tools, workflow/product launches.
   - `startup`: Launch HN, founder/startup/project/funding/operator signals.
2. Mission Control Intel Inbox renders two extra promotion destinations:
   - `Tool` → Community pipeline item, `kind=tool_of_day`.
   - `Startup` → Community pipeline item, `kind=startup_of_day`.
3. Promotion creates a Community work item for the Community Director:
   - `draft_community_tool`
   - `draft_community_startup`
4. Community Director saves final copy back into the Community pipeline card for review; it must not publish directly.
5. After approval, publication routing uses the community segment:
   - Tool → `#🦿_ai_tools` (`1284277202073948181`)
   - Startup → `#📢_presenta_tu_proyecto` (`1445800588561486007`)
   - News remains → `#🛰️_radar_ia`

## Scheduling

Community publication scheduling recognizes:

- `tool_of_day`: Tue/Thu 12:00 London, max 2/week.
- `startup_of_day`: Wed/Fri 12:00 London, max 2/week.

Content launches still publish to announcements; radar/news keeps its own cadence.

## Safety notes

- Intel promotion only creates drafts/work items, never direct Discord posts.
- The target channel is stored in the Community pipeline item metadata so downstream publish work items do not need to infer from text alone.
- Link-preview suppression remains enforced in publish instructions.
