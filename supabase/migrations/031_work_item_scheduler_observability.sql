-- Canonical work-item scheduler control lives in scheduler_config.
-- cron_health is an observability snapshot only; it must exist before the first
-- worker report so Mission Control can render a 200 status instead of a 404.

INSERT INTO scheduler_config (key, value) VALUES
  ('enabled', 'true'),
  ('max_concurrent', '2'),
  ('daily_budget_usd', '50'),
  ('schedule_minutes', '10')
ON CONFLICT (key) DO NOTHING;

INSERT INTO cron_health (
  cron_name,
  schedule,
  description,
  category,
  enabled,
  last_status
)
VALUES (
  'work-item-scheduler',
  'every ' || COALESCE((SELECT value FROM scheduler_config WHERE key = 'schedule_minutes'), '10') || ' min',
  'DB-native Mission Control work-item scheduler (interval job)',
  'scheduled',
  COALESCE((SELECT value::boolean FROM scheduler_config WHERE key = 'enabled'), true),
  'unknown'
)
ON CONFLICT (cron_name) DO UPDATE SET
  schedule = EXCLUDED.schedule,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled;
