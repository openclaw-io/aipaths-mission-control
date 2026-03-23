-- Extend agent_tasks for scheduled actions, human tasks, and better status tracking
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS assignee text DEFAULT NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'auto'
  CHECK (task_type IN ('auto', 'approval', 'scheduled'));
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS scheduled_for timestamptz DEFAULT NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS error text DEFAULT NULL;

-- Update status constraint to add 'failed' and 'pending_approval'
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check
  CHECK (status IN ('new', 'in_progress', 'done', 'blocked', 'failed', 'pending_approval'));

-- Index for calendar queries (next 7 days)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_scheduled ON agent_tasks (scheduled_for)
  WHERE scheduled_for IS NOT NULL;

-- Index for assignee queries
CREATE INDEX IF NOT EXISTS idx_agent_tasks_assignee ON agent_tasks (assignee)
  WHERE assignee IS NOT NULL;
