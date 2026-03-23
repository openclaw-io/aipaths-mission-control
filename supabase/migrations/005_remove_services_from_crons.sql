-- Remove gateway and dispatch from cron_health (they're now in the top-right services indicator)
DELETE FROM cron_health WHERE cron_name IN ('gateway', 'dispatch');
