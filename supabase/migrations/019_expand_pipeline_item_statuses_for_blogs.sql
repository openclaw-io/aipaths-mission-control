-- Migration 019: expand pipeline_items status constraint for blog workflow
-- Run in Supabase SQL Editor if your environment is not applying local migrations automatically.

ALTER TABLE pipeline_items DROP CONSTRAINT IF EXISTS pipeline_items_status_check;

ALTER TABLE pipeline_items
ADD CONSTRAINT pipeline_items_status_check
CHECK (
  status IN (
    'draft',
    'idea',
    'in_review',
    'live',
    'preparing_production',
    'published',
    'publishing',
    'ready_to_record',
    'archived',
    'parked',
    'rejected',
    'researching',
    'ready_for_review',
    'changes_requested',
    'approved',
    'localizing',
    'scheduled'
  )
);
