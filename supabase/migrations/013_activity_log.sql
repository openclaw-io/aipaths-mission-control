-- Migration 013: activity_log table for live feed
-- Run in Supabase SQL Editor
-- ALSO: Enable Realtime on this table (Database > Replication)

CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  detail text,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_agent ON activity_log(agent);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "service all" ON activity_log FOR ALL TO service_role USING (true);
