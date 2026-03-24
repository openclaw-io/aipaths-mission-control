-- Migration 014: Add enabled flag + config to cron_health
-- Run in Supabase SQL Editor

ALTER TABLE cron_health ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT true;
ALTER TABLE cron_health ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}';

-- Seed the task-scheduler cron
INSERT INTO cron_health (cron_name, schedule, category, enabled, config)
VALUES ('task-scheduler', 'every 10 min', 'scheduled', true, '{"max_concurrent": 2, "daily_budget_usd": 50}')
ON CONFLICT (cron_name) DO UPDATE SET 
  enabled = EXCLUDED.enabled,
  config = EXCLUDED.config;
