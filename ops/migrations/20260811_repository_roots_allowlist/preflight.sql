BEGIN;
SET TRANSACTION READ ONLY;
DO $$
BEGIN
  IF to_regclass('public.review_repositories') IS NULL THEN
    RAISE EXCEPTION 'GON-124 preflight: review_repositories is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.review_repositories
    WHERE canonical_root NOT LIKE '/%'
       OR canonical_root = '/'
       OR canonical_root ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'GON-124 preflight: existing canonical_root violates the portable path contract';
  END IF;
END $$;
COMMIT;
