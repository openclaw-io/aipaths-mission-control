-- Cron execution logs
CREATE TABLE IF NOT EXISTS cron_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  rows_affected INTEGER DEFAULT 0,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by cron name + time
CREATE INDEX idx_cron_logs_name_started ON cron_logs (cron_name, started_at DESC);

-- RLS
ALTER TABLE cron_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access" ON cron_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Also allow service_role (for cron reporter writing from infra)
CREATE POLICY "Service role full access" ON cron_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
