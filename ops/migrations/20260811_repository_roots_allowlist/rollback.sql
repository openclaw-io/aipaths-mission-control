BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.review_repositories IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.review_repositories
    WHERE canonical_root NOT LIKE '/Users/joaco/openclaw/%'
  ) THEN
    RAISE EXCEPTION 'GON-124 rollback refused: repository identity exists outside the legacy root';
  END IF;
END $$;

ALTER TABLE public.review_repositories
  DROP CONSTRAINT IF EXISTS review_repositories_canonical_root_check;
ALTER TABLE public.review_repositories
  ADD CONSTRAINT review_repositories_canonical_root_check CHECK (
    canonical_root LIKE '/Users/joaco/openclaw/%'
  );
COMMIT;
