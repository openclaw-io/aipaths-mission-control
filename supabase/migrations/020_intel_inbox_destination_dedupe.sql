-- Migration 020: dedupe Intel Inbox promotions by enriched item + destination
-- This keeps promote idempotent across retries/double-clicks once applied.

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_items_intel_inbox_destination_unique
ON pipeline_items (
  ((metadata ->> 'intel_source_type')),
  ((metadata ->> 'intel_enriched_item_id')),
  ((metadata ->> 'intel_destination_key'))
)
WHERE (metadata ->> 'intel_source_type') = 'intel_inbox'
  AND metadata ? 'intel_enriched_item_id'
  AND metadata ? 'intel_destination_key';
