-- Add category column to cron_health
ALTER TABLE cron_health ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'scheduled'
  CHECK (category IN ('services', 'scheduled', 'heartbeats'));

-- Update existing crons with categories
UPDATE cron_health SET category = 'services' WHERE cron_name IN ('gateway', 'dispatch');
UPDATE cron_health SET category = 'heartbeats' WHERE cron_name LIKE 'heartbeat-%';
UPDATE cron_health SET category = 'scheduled' WHERE category = 'scheduled';
