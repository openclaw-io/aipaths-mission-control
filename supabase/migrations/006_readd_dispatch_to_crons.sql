-- Re-add dispatch as a scheduled cron (runs every 10 min, not always-on)
INSERT INTO cron_health (cron_name, schedule, description, last_status, category)
VALUES ('dispatch', 'every 10 min', 'OpenClaw Comment Dispatcher — scans Notion for #openclaw comments', 'unknown', 'scheduled')
ON CONFLICT DO NOTHING;
