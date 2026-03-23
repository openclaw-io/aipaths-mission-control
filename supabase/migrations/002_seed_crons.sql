-- Seed data for cron_health table: 12 LaunchAgent crons
INSERT INTO cron_health (cron_name, schedule, description, last_status)
VALUES
  ('task-runner', 'every 15 min', 'Picks up pending dev task cards and spawns workers', 'unknown'),
  ('scheduled-sender', 'every 30 min', 'Sends scheduled email campaigns', 'unknown'),
  ('pipeline-poller', 'every 5 min', 'Checks content pipeline for new approved/deployed cards', 'unknown'),
  ('inbox-router', 'every 5 min', 'Routes new Agent Inbox tasks to directors', 'unknown'),
  ('strategist-scheduler', 'weekly', 'Triggers weekly strategy reports', 'unknown'),
  ('daily-scrape', 'daily 2 AM', 'Scrapes analytics data into Supabase tables', 'unknown'),
  ('gateway', 'always-on', 'OpenClaw gateway daemon', 'unknown'),
  ('dispatch', 'always-on', 'OpenClaw message dispatch service', 'unknown'),
  ('heartbeat-youtube', 'every 1 hour', 'YouTube director heartbeat check', 'unknown'),
  ('heartbeat-community', 'disabled', 'Community director heartbeat', 'unknown'),
  ('heartbeat-content', 'disabled', 'Content director heartbeat', 'unknown'),
  ('heartbeat-dev', 'disabled', 'Dev director heartbeat', 'unknown')
ON CONFLICT DO NOTHING;
