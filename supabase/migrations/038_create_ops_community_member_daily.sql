-- Daily Discord community member growth snapshots.
-- Aggregates only: no usernames, messages, or member identifiers are persisted.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.ops_community_member_daily (
  date date NOT NULL,
  guild_id text NOT NULL,
  new_human_members integer NOT NULL,
  total_members_at_check integer,
  human_members_at_check integer,
  bot_members_at_check integer,
  checked_at timestamptz NOT NULL,
  coverage text NOT NULL,
  source text NOT NULL DEFAULT 'discord_list_guild_members',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, guild_id),
  CONSTRAINT ops_community_member_daily_new_human_members_check
    CHECK (new_human_members >= 0),
  CONSTRAINT ops_community_member_daily_snapshot_counts_check
    CHECK (
      (
        total_members_at_check IS NULL
        AND human_members_at_check IS NULL
        AND bot_members_at_check IS NULL
      )
      OR (
        total_members_at_check IS NOT NULL
        AND human_members_at_check IS NOT NULL
        AND bot_members_at_check IS NOT NULL
        AND total_members_at_check >= 0
        AND human_members_at_check >= 0
        AND bot_members_at_check >= 0
        AND total_members_at_check = human_members_at_check + bot_members_at_check
      )
    ),
  CONSTRAINT ops_community_member_daily_coverage_check
    CHECK (coverage IN ('daily_member_list_snapshot', 'current_member_list_backfill')),
  CONSTRAINT ops_community_member_daily_source_check
    CHECK (source = 'discord_list_guild_members'),
  CONSTRAINT ops_community_member_daily_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_ops_community_member_daily_checked_at
  ON public.ops_community_member_daily (checked_at DESC);

COMMENT ON TABLE public.ops_community_member_daily IS
  'Reconciliation-based daily Discord joins by London calendar date. Backfill counts only members still present at check time; current totals belong to checked_at.';

ALTER TABLE public.ops_community_member_daily ENABLE ROW LEVEL SECURITY;

DO $policies$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aipaths_mc_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.ops_community_member_daily TO aipaths_mc_app;
    DROP POLICY IF EXISTS "ops_community_member_daily app access" ON public.ops_community_member_daily;
    EXECUTE 'CREATE POLICY "ops_community_member_daily app access" ON public.ops_community_member_daily FOR ALL TO aipaths_mc_app USING (true) WITH CHECK (true)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.ops_community_member_daily TO authenticated;
    DROP POLICY IF EXISTS "ops_community_member_daily authenticated read" ON public.ops_community_member_daily;
    EXECUTE 'CREATE POLICY "ops_community_member_daily authenticated read" ON public.ops_community_member_daily FOR SELECT TO authenticated USING (true)';
  END IF;
END
$policies$;

COMMIT;
