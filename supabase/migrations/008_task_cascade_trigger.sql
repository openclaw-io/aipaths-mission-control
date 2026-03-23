-- Auto-cascade: when a task completes, unblock its dependents
CREATE OR REPLACE FUNCTION cascade_task_completion()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire when status changes to 'done'
  IF NEW.status = 'done' AND (OLD.status IS NULL OR OLD.status != 'done') THEN
    -- Unblock tasks that depend on this one
    UPDATE agent_tasks
    SET status = CASE
      -- If it has an assignee of 'gonza', go to pending_approval
      WHEN assignee = 'gonza' THEN 'pending_approval'
      -- Otherwise, mark as new (ready to execute)
      ELSE 'new'
    END,
    started_at = NULL
    WHERE depends_on = NEW.id
      AND status = 'blocked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_cascade_task_completion ON agent_tasks;
CREATE TRIGGER trg_cascade_task_completion
  AFTER UPDATE ON agent_tasks
  FOR EACH ROW
  EXECUTE FUNCTION cascade_task_completion();

-- Also handle approval: when a pending_approval task is set to done,
-- cascade to its dependents too (already handled by the same trigger)
