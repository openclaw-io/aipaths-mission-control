BEGIN;
SET TRANSACTION READ ONLY;
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid='public.review_repositories'::regclass
    AND conname='review_repositories_canonical_root_check';

  IF definition IS NULL
     OR definition LIKE '%/Users/%'
     OR definition NOT LIKE '%canonical_root <> ''/''%'
     OR definition NOT LIKE '%[:cntrl:]%' THEN
    RAISE EXCEPTION 'GON-124 verify: portable canonical_root constraint is missing: %', definition;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.review_repositories
    WHERE canonical_root NOT LIKE '/%'
       OR canonical_root = '/'
       OR canonical_root ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'GON-124 verify: a registered repository violates the portable path contract';
  END IF;
END $$;
COMMIT;
