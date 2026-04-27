-- Migration 023: Drop retired pipeline_items.origin_idea_id
-- Context: content_ideas V1 was retired on 2026-04-27. The FK was dropped before content_ideas was dropped.
-- Verification before this migration: active code has no origin_idea_id references and all pipeline_items.origin_idea_id values are null.

begin;

alter table if exists pipeline_items
  drop column if exists origin_idea_id;

commit;
