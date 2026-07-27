-- Canonical work-item scheduler control lives in scheduler_config.
-- Deployed launchd StartInterval is 300 seconds; schedule_minutes=5 is the
-- versioned display/validation contract. The application never reloads launchd.
-- cron_health is observation only and is seeded before the first worker report.

INSERT INTO scheduler_config (key, value) VALUES
  ('enabled', 'true'),
  ('max_concurrent', '2'),
  ('daily_budget_usd', '50'),
  ('schedule_minutes', '5')
ON CONFLICT (key) DO UPDATE SET
  value = CASE EXCLUDED.key
    WHEN 'enabled' THEN CASE
      WHEN lower(trim(scheduler_config.value)) IN ('true', 'false')
        THEN lower(trim(scheduler_config.value))
      ELSE 'false'
    END
    WHEN 'max_concurrent' THEN CASE
      WHEN trim(scheduler_config.value) ~ '^[0-9]+$' THEN CASE
        WHEN scheduler_config.value::numeric BETWEEN 1 AND 10 THEN trim(scheduler_config.value)
        ELSE '2'
      END
      ELSE '2'
    END
    WHEN 'daily_budget_usd' THEN CASE
      WHEN trim(scheduler_config.value) ~ '^[0-9]+$' THEN CASE
        WHEN scheduler_config.value::numeric BETWEEN 1 AND 100000 THEN trim(scheduler_config.value)
        ELSE '50'
      END
      ELSE '50'
    END
    WHEN 'schedule_minutes' THEN '5'
    ELSE scheduler_config.value
  END,
  updated_at = now();

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
  'every 5 min',
  'DB-native Mission Control work-item scheduler (launchd StartInterval job)',
  'scheduled',
  CASE
    WHEN (SELECT lower(trim(value)) FROM scheduler_config WHERE key = 'enabled') = 'true' THEN true
    ELSE false
  END,
  'unknown'
)
ON CONFLICT (cron_name) DO UPDATE SET
  schedule = EXCLUDED.schedule,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled;
