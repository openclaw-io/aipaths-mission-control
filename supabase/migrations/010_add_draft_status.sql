-- Migration 010: Add 'draft' to status check constraint
-- Run in Supabase SQL Editor

-- Drop existing constraint and recreate with draft
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check 
  CHECK (status IN ('new', 'in_progress', 'done', 'blocked', 'failed', 'pending_approval', 'draft'));
