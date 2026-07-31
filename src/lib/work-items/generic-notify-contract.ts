import { createHash } from "node:crypto";

export const GENERIC_NOTIFY_CLASSIFICATION_IDENTITY_VERSION = "generic_notify_classification_v1" as const;

export type GenericNotifyClassificationIdentity = {
  version: typeof GENERIC_NOTIFY_CLASSIFICATION_IDENTITY_VERSION;
  sha256: string;
};

export type GenericNotifyClassificationRow = {
  id: string;
  status?: unknown;
  updated_at?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  owner_agent?: unknown;
  target_agent_id?: unknown;
  payload?: unknown;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(Number.isFinite(value) ? value : null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function canonicalTimestamp(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function buildGenericNotifyClassificationIdentity(
  row: GenericNotifyClassificationRow,
): GenericNotifyClassificationIdentity {
  const projection = {
    id: row.id,
    status: row.status ?? null,
    updated_at: canonicalTimestamp(row.updated_at ?? null),
    source_type: row.source_type ?? null,
    source_id: row.source_id ?? null,
    owner_agent: row.owner_agent ?? null,
    target_agent_id: row.target_agent_id ?? null,
    payload: row.payload ?? null,
  };
  return {
    version: GENERIC_NOTIFY_CLASSIFICATION_IDENTITY_VERSION,
    sha256: createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex"),
  };
}

export function parseGenericNotifyClassificationIdentity(value: unknown): GenericNotifyClassificationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "sha256,version") return null;
  if (record.version !== GENERIC_NOTIFY_CLASSIFICATION_IDENTITY_VERSION) return null;
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return null;
  return { version: GENERIC_NOTIFY_CLASSIFICATION_IDENTITY_VERSION, sha256: record.sha256 };
}

export function genericNotifyIdentityMatches(
  expected: GenericNotifyClassificationIdentity,
  current: GenericNotifyClassificationRow,
): boolean {
  const actual = buildGenericNotifyClassificationIdentity(current);
  return expected.version === actual.version && expected.sha256 === actual.sha256;
}

export function isVisualQaLikeWorkItem(row: Pick<GenericNotifyClassificationRow, "source_type" | "payload">): boolean {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : null;
  if (!payload) return false;

  const runtime = payload.runtime_contract;
  const role = payload.run_role;
  if (runtime === "fresh_review_v1" && role === "review") return false;
  if (runtime === "visual_qa_v1" || role === "qa") return true;

  const runtimeText = typeof runtime === "string" ? runtime.toLowerCase() : "";
  const roleText = typeof role === "string" ? role.toLowerCase() : "";
  if (runtimeText.includes("visual_qa") || roleText === "qa") return true;

  const hasTargetIdentity = typeof payload.target_run_id === "string"
    && typeof payload.target_sha === "string"
    && typeof payload.execution_attempt_id === "string"
    && Number.isInteger(payload.quality_cycle);
  const hasPolicyIdentity = typeof payload.qa_policy_hash === "string"
    || (typeof payload.policy_hash === "string" && payload.qa_policy !== undefined);
  return hasTargetIdentity && hasPolicyIdentity;
}
