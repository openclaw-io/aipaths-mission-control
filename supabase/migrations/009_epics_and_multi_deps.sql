-- Migration 009: Epics system + multi-dependency support
-- Run manually in Supabase SQL Editor

-- 1. Add parent_id for epic → sub-task relationship
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_id);

-- 2. Convert depends_on from single uuid to uuid array
-- First add the new array column
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS depends_on_arr uuid[] DEFAULT '{}';

-- Copy existing single dependency into array
UPDATE agent_tasks 
SET depends_on_arr = ARRAY[depends_on] 
WHERE depends_on IS NOT NULL;

-- Drop old column and rename
ALTER TABLE agent_tasks DROP COLUMN IF EXISTS depends_on;
ALTER TABLE agent_tasks RENAME COLUMN depends_on_arr TO depends_on;

-- 3. Add 'draft' to allowed statuses (no enum — status is text, just documenting)
-- Status values: new, in_progress, done, blocked, failed, pending_approval, draft
-- draft = planned but not activated (part of an epic that hasn't started)

-- 4. Replace cascade trigger to handle array depends_on
DROP TRIGGER IF EXISTS trg_cascade_task_completion ON agent_tasks;
DROP FUNCTION IF EXISTS cascade_task_completion();

CREATE OR REPLACE FUNCTION cascade_task_completion()
RETURNS TRIGGER AS $$
DECLARE
  dependent RECORD;
  all_deps_done BOOLEAN;
  dep_id uuid;
BEGIN
  -- Only fire when status changes to 'done'
  IF NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status <> 'done') THEN
    -- Find all tasks that depend on this task (check if NEW.id is in their depends_on array)
    FOR dependent IN
      SELECT id, depends_on, assignee, status
      FROM agent_tasks
      WHERE NEW.id = ANY(depends_on)
        AND status IN ('blocked', 'draft')
    LOOP
      -- Check if ALL dependencies are done
      all_deps_done := TRUE;
      FOREACH dep_id IN ARRAY dependent.depends_on LOOP
        IF dep_id <> NEW.id THEN
          IF NOT EXISTS (
            SELECT 1 FROM agent_tasks WHERE id = dep_id AND status = 'done'
          ) THEN
            all_deps_done := FALSE;
            EXIT;
          END IF;
        END IF;
      END LOOP;

      IF all_deps_done THEN
        -- Promote: draft tasks stay draft (scheduler activates them), blocked → new or pending_approval
        IF dependent.status = 'blocked' THEN
          IF dependent.assignee = 'gonza' THEN
            UPDATE agent_tasks SET status = 'pending_approval' WHERE id = dependent.id;
          ELSE
            UPDATE agent_tasks SET status = 'new' WHERE id = dependent.id;
          END IF;
        END IF;
        -- draft tasks: don't auto-promote (scheduler handles activation)
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cascade_task_completion
  AFTER UPDATE ON agent_tasks
  FOR EACH ROW
  EXECUTE FUNCTION cascade_task_completion();

-- 5. Add epic-level fields
-- description: longer text for epic overview/plan
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS description text;
-- auto_dispatch: whether scheduler should auto-activate sub-tasks
-- (stored on the epic/parent task)
