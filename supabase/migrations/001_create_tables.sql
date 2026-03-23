-- Agent Tasks
CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  instruction text,
  agent text NOT NULL,
  created_by text DEFAULT 'gonza',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'done', 'blocked')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  result text,
  tags text[] DEFAULT '{}',
  depends_on uuid REFERENCES agent_tasks(id),
  due_date timestamptz,
  created_at timestamptz DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON agent_tasks
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Cron Health
CREATE TABLE cron_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name text NOT NULL UNIQUE,
  schedule text,
  description text,
  last_run_at timestamptz,
  last_status text DEFAULT 'unknown' CHECK (last_status IN ('ok', 'error', 'unknown')),
  last_duration_ms integer,
  last_error text,
  rows_affected integer DEFAULT 0
);

ALTER TABLE cron_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON cron_health
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Agent Memory
CREATE TABLE agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  date date NOT NULL DEFAULT CURRENT_DATE,
  content text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (agent, date)
);

ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON agent_memory
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
