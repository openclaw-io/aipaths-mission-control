-- Migration 027: add final_check pipeline status for blog final approval
-- Context: approved blog drafts now need a second review gate after EN localization
-- and hero/thumbnail preparation, before moving to scheduled/publish work.

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
    'final_check',
    'scheduled'
  )
);
