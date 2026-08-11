-- GON-124 schema parity. Runtime rollout is local Postgres via ops/migrations/20260811_repository_roots_allowlist.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.review_repositories
  DROP CONSTRAINT IF EXISTS review_repositories_canonical_root_check;
ALTER TABLE public.review_repositories
  ADD CONSTRAINT review_repositories_canonical_root_check CHECK (
    canonical_root LIKE '/%'
    AND canonical_root <> '/'
    AND canonical_root !~ '[[:cntrl:]]'
  );
COMMIT;
