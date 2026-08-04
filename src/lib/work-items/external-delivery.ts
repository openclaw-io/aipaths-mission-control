export type JsonRecord = Record<string, unknown>;

type QueryClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type ExternalDeliveryStatus = "pending" | "failed_pre_delivery" | "accepted" | "ambiguous";

type DeliveryRow = {
  idempotency_key: string;
  work_item_id: string;
  scope: JsonRecord;
  status: ExternalDeliveryStatus;
  claim_token: string;
  claim_attempt: number;
  claimed_at: string | Date;
  provider_accepted_at: string | Date | null;
  provider_delivery_id: string | null;
  result: JsonRecord | null;
  last_error: string | null;
};

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;

function iso(value: string | Date, name: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name}_invalid`);
  return date.toISOString();
}

function assertKey(value: string) {
  if (!KEY_PATTERN.test(value)) throw new Error("external_delivery_idempotency_key_invalid");
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]));
}

function resultFor(row: DeliveryRow, kind: "acquired" | "accepted_replay" | "pending_fail_closed" | "scope_conflict") {
  return {
    kind,
    key: row.idempotency_key,
    status: row.status,
    claimToken: row.claim_token,
    claimAttempt: Number(row.claim_attempt),
    workItemId: row.work_item_id,
    providerDeliveryId: row.provider_delivery_id,
    providerAcceptedAt: row.provider_accepted_at ? new Date(row.provider_accepted_at).toISOString() : null,
    result: row.result,
    lastError: row.last_error,
  };
}

export async function claimExternalDelivery(client: QueryClient, input: {
  key: string;
  workItemId: string;
  scope: JsonRecord;
  now: string | Date;
}) {
  assertKey(input.key);
  const claimedAt = iso(input.now, "external_delivery_claimed_at");
  const inserted = await client.query<DeliveryRow>(
    `insert into public.external_delivery_attempts (
       idempotency_key,work_item_id,scope,status,claimed_at,updated_at
     ) values ($1,$2,$3::jsonb,'pending',$4::timestamptz,$4::timestamptz)
     on conflict (idempotency_key) do nothing
     returning *`,
    [input.key, input.workItemId, JSON.stringify(input.scope), claimedAt],
  );
  if (inserted.rows[0]) return resultFor(inserted.rows[0], "acquired");

  const locked = await client.query<DeliveryRow>(
    `select * from public.external_delivery_attempts
      where idempotency_key=$1
      for update`,
    [input.key],
  );
  const row = locked.rows[0];
  if (!row) throw new Error("external_delivery_claim_conflict_missing");
  if (!sameJson(row.scope, input.scope)) return resultFor(row, "scope_conflict");
  if (row.status === "accepted") return resultFor(row, "accepted_replay");
  if (row.status === "pending" || row.status === "ambiguous") return resultFor(row, "pending_fail_closed");

  const reclaimed = await client.query<DeliveryRow>(
    `update public.external_delivery_attempts
        set work_item_id=$2,status='pending',claim_token=gen_random_uuid(),
            claim_attempt=claim_attempt+1,claimed_at=$3::timestamptz,
            provider_accepted_at=null,provider_delivery_id=null,result=null,last_error=null,
            updated_at=$3::timestamptz
      where idempotency_key=$1 and status='failed_pre_delivery'
      returning *`,
    [input.key, input.workItemId, claimedAt],
  );
  if (!reclaimed.rows[0]) throw new Error("external_delivery_reclaim_conflict");
  return resultFor(reclaimed.rows[0], "acquired");
}

export async function markExternalDeliveryPreDeliveryFailure(client: QueryClient, input: {
  key: string;
  claimToken: string;
  workItemId: string;
  failedAt: string | Date;
  error: string;
}) {
  assertKey(input.key);
  const failedAt = iso(input.failedAt, "external_delivery_failed_at");
  const updated = await client.query<DeliveryRow>(
    `update public.external_delivery_attempts
        set status='failed_pre_delivery',last_error=$4,result=$5::jsonb,updated_at=$3::timestamptz
      where idempotency_key=$1 and work_item_id=$2 and claim_token=$6::uuid and status='pending'
      returning *`,
    [input.key, input.workItemId, failedAt, input.error.slice(0, 1000), JSON.stringify({ status: "not_attempted", error: input.error }), input.claimToken],
  );
  if (!updated.rows[0]) throw new Error("external_delivery_pre_delivery_failure_conflict");
  return resultFor(updated.rows[0], "pending_fail_closed");
}

export async function markExternalDeliveryAccepted(client: QueryClient, input: {
  key: string;
  claimToken: string;
  workItemId: string;
  acceptedAt: string | Date;
  providerDeliveryId: string;
  result: JsonRecord;
}) {
  assertKey(input.key);
  const acceptedAt = iso(input.acceptedAt, "external_delivery_accepted_at");
  const providerDeliveryId = input.providerDeliveryId.trim();
  if (!providerDeliveryId) throw new Error("external_delivery_provider_id_required");
  const locked = await client.query<DeliveryRow>(
    "select * from public.external_delivery_attempts where idempotency_key=$1 for update",
    [input.key],
  );
  const row = locked.rows[0];
  if (!row) throw new Error("external_delivery_claim_missing");
  if (row.status === "accepted") return resultFor(row, "accepted_replay");
  if (row.status !== "pending" || row.work_item_id !== input.workItemId || row.claim_token !== input.claimToken) {
    throw new Error("external_delivery_accept_conflict");
  }
  const updated = await client.query<DeliveryRow>(
    `update public.external_delivery_attempts
        set status='accepted',provider_accepted_at=$3::timestamptz,
            provider_delivery_id=$4,result=$5::jsonb,last_error=null,updated_at=$3::timestamptz
      where idempotency_key=$1 and work_item_id=$2 and claim_token=$6::uuid and status='pending'
      returning *`,
    [input.key, input.workItemId, acceptedAt, providerDeliveryId, JSON.stringify(input.result), input.claimToken],
  );
  if (!updated.rows[0]) throw new Error("external_delivery_accept_conflict");
  return resultFor(updated.rows[0], "accepted_replay");
}

export async function markExternalDeliveryAmbiguous(client: QueryClient, input: {
  key: string;
  claimToken: string;
  workItemId: string;
  observedAt: string | Date;
  error: string;
  result?: JsonRecord;
}) {
  assertKey(input.key);
  const observedAt = iso(input.observedAt, "external_delivery_ambiguous_at");
  const updated = await client.query<DeliveryRow>(
    `update public.external_delivery_attempts
        set status='ambiguous',last_error=$4,result=$5::jsonb,updated_at=$3::timestamptz
      where idempotency_key=$1 and work_item_id=$2 and claim_token=$6::uuid and status='pending'
      returning *`,
    [input.key, input.workItemId, observedAt, input.error.slice(0, 1000), JSON.stringify(input.result || { status: "ambiguous", error: input.error }), input.claimToken],
  );
  if (!updated.rows[0]) throw new Error("external_delivery_ambiguous_conflict");
  return resultFor(updated.rows[0], "pending_fail_closed");
}
