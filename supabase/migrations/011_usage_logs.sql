-- Migration 011: usage_logs table for cost tracking
-- Run in Supabase SQL Editor

CREATE TABLE usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  date date NOT NULL,
  model text NOT NULL,
  input_tokens bigint DEFAULT 0,
  output_tokens bigint DEFAULT 0,
  cost_usd numeric(10,4) DEFAULT 0,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  session_key text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_usage_agent_date ON usage_logs(agent, date);
CREATE INDEX idx_usage_date ON usage_logs(date);

ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON usage_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "service insert" ON usage_logs FOR ALL TO service_role USING (true);
