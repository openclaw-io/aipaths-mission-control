BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE public.review_repositories IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.review_repositories
    WHERE canonical_root NOT LIKE '/%'
       OR canonical_root = '/'
       OR canonical_root ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'GON-124 forward: existing canonical_root violates the portable path contract';
  END IF;
END $$;

ALTER TABLE public.review_repositories
  DROP CONSTRAINT IF EXISTS review_repositories_canonical_root_check;
ALTER TABLE public.review_repositories
  ADD CONSTRAINT review_repositories_canonical_root_check CHECK (
    canonical_root LIKE '/%'
    AND canonical_root <> '/'
    AND canonical_root !~ '[[:cntrl:]]'
  );
COMMIT;
