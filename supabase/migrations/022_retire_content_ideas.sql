-- Migration 022: Retire unused content_ideas V1 tables
-- Context: Content runtime now uses pipeline_items plus intel inbox/materializer flows.
-- 2026-04-27: content_ideas/content_idea_signals/content_feedback had no active code references; rows were exported and deleted before this drop.

begin;

-- Remove the empty legacy FK from pipeline_items before dropping content_ideas.
alter table if exists pipeline_items
  drop constraint if exists pipeline_items_origin_idea_id_fkey;

-- Keep the scalar column for now as inert historical schema; active rows have origin_idea_id = null.
-- The column can be dropped later in a broader pipeline_items schema cleanup if desired.

drop table if exists content_feedback;
drop table if exists content_idea_signals;
drop table if exists content_ideas;

commit;
