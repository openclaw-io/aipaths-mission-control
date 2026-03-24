-- Migration 012: Scheduler config table
-- Run in Supabase SQL Editor

CREATE TABLE scheduler_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE scheduler_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON scheduler_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated write" ON scheduler_config FOR ALL TO authenticated USING (true);
CREATE POLICY "service all" ON scheduler_config FOR ALL TO service_role USING (true);

-- Default config
INSERT INTO scheduler_config (key, value) VALUES
  ('enabled', 'true'),
  ('max_concurrent', '2'),
  ('daily_budget_usd', '50'),
  ('schedule_minutes', '10');
