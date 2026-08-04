BEGIN;

CREATE TABLE IF NOT EXISTS public.external_delivery_attempts (
  idempotency_key text PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES public.work_items(id) ON DELETE RESTRICT,
  scope jsonb NOT NULL,
  status text NOT NULL,
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_attempt integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL,
  provider_accepted_at timestamptz,
  provider_delivery_id text,
  result jsonb,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_delivery_attempts_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$'),
  CONSTRAINT external_delivery_attempts_status_check CHECK (status IN ('pending','failed_pre_delivery','accepted','ambiguous')),
  CONSTRAINT external_delivery_attempts_claim_attempt_check CHECK (claim_attempt > 0),
  CONSTRAINT external_delivery_attempts_accepted_shape_check CHECK (
    (status = 'accepted' AND provider_accepted_at IS NOT NULL AND nullif(btrim(provider_delivery_id), '') IS NOT NULL)
    OR (status <> 'accepted' AND provider_accepted_at IS NULL AND provider_delivery_id IS NULL)
  )
);

ALTER TABLE public.external_delivery_attempts
  DROP CONSTRAINT IF EXISTS external_delivery_attempts_work_item_id_fkey;
ALTER TABLE public.external_delivery_attempts
  ADD CONSTRAINT external_delivery_attempts_work_item_id_fkey
  FOREIGN KEY (work_item_id) REFERENCES public.work_items(id) ON DELETE RESTRICT;

ALTER TABLE public.external_delivery_attempts
  DROP CONSTRAINT IF EXISTS external_delivery_attempts_accepted_shape_check;
ALTER TABLE public.external_delivery_attempts
  ADD CONSTRAINT external_delivery_attempts_accepted_shape_check CHECK (
    (status = 'accepted' AND provider_accepted_at IS NOT NULL AND nullif(btrim(provider_delivery_id), '') IS NOT NULL)
    OR (status <> 'accepted' AND provider_accepted_at IS NULL AND provider_delivery_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_external_delivery_attempts_work_item
  ON public.external_delivery_attempts(work_item_id);
CREATE INDEX IF NOT EXISTS idx_external_delivery_attempts_status_updated
  ON public.external_delivery_attempts(status, updated_at);

ALTER TABLE public.external_delivery_attempts ENABLE ROW LEVEL SECURITY;

COMMIT;
