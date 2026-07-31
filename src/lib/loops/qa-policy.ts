export const QA_POLICY_LIMITS = {
  canonicalJsonBytes: 64 * 1024,
  viewports: 8,
  flows: 20,
  url: 2_048,
  viewportName: 80,
  flow: 500,
  dimensionMin: 320,
  dimensionMax: 2_560,
} as const;

export type QaViewport = { name: string; width: number; height: number };
export type QaPolicy = {
  required: boolean;
  target_url: string | null;
  viewports: QaViewport[];
  flows: string[];
};

const POLICY_KEYS = ["required", "target_url", "viewports", "flows"] as const;
const VIEWPORT_KEYS = ["name", "width", "height"] as const;
const DEFAULT_QA_VIEWPORTS: QaViewport[] = [
  { name: "desktop", width: 1_440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ASCII_EDGE = /^(?:[\u0000-\u0020\u007f])|(?:[\u0000-\u0020\u007f])$/;

export function utf8ByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return Number.POSITIVE_INFINITY;
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return Number.POSITIVE_INFINITY;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return Number.POSITIVE_INFINITY;
    else bytes += 3;
  }
  return bytes;
}

/** Rejects JSON values containing strings/keys PostgreSQL UTF-8/jsonb cannot represent. */
export function containsInvalidUtf8String(value: unknown): boolean {
  if (typeof value === "string") return !Number.isFinite(utf8ByteLength(value));
  if (Array.isArray(value)) return value.some(containsInvalidUtf8String);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => containsInvalidUtf8String(key) || containsInvalidUtf8String(child));
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
) {
  const keys = Object.keys(value);
  return keys.length <= allowed.length
    && keys.every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

/** Text bounds are UTF-8 bytes; only ASCII whitespace/control is special at the edges. */
function usefulText(value: unknown, maxBytes: number, persisted: boolean) {
  if (typeof value !== "string") return null;
  const normalized = persisted ? value : value.trim();
  if (normalized.length === 0 || ASCII_EDGE.test(normalized)) return null;
  return utf8ByteLength(normalized) <= maxBytes ? normalized : null;
}

/**
 * Conservative target grammar shared byte-for-byte in spirit with qa_target_url_is_valid:
 * lowercase http(s), ASCII DNS/localhost or canonical IPv4, optional port 1..65535,
 * and an optional visible-ASCII path/query. Userinfo, fragments, and IPv6 are excluded.
 */
export function validQaTargetUrl(value: string) {
  if (utf8ByteLength(value) > QA_POLICY_LIMITS.url || !/^[\x21-\x7e]+$/.test(value)) return false;
  const match = value.match(/^https?:\/\/([^/?#:]+)(?::([0-9]+))?([/?][^#]*)?$/);
  if (!match) return false;
  const [, host, rawPort] = match;
  if (host.length > 253 || host !== host.toLowerCase()) return false;
  if (rawPort !== undefined && (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65_535)) return false;
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split(".");
    return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
  }
  return host.split(".").every((label) => HOST_LABEL.test(label));
}

function canonicalPolicyBytes(policy: QaPolicy) {
  // This shape has deterministic insertion order. SQL applies the same cap to its
  // sorted-key canonical JSON; key order does not change encoded byte length.
  return utf8ByteLength(JSON.stringify(policy));
}

function parsePolicy(value: unknown, persisted: boolean): QaPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (!hasExactKeys(policy, POLICY_KEYS, persisted ? POLICY_KEYS : ["required"])
    || typeof policy.required !== "boolean") return null;

  if (policy.target_url !== undefined && policy.target_url !== null && typeof policy.target_url !== "string") return null;
  const targetUrl = policy.target_url === undefined || policy.target_url === null
    ? null
    : usefulText(policy.target_url, QA_POLICY_LIMITS.url, persisted);
  if (typeof policy.target_url === "string" && targetUrl === null) return null;

  const rawViewports = policy.viewports === undefined ? [] : policy.viewports;
  const rawFlows = policy.flows === undefined ? [] : policy.flows;
  if (!Array.isArray(rawViewports) || rawViewports.length > QA_POLICY_LIMITS.viewports
    || !Array.isArray(rawFlows) || rawFlows.length > QA_POLICY_LIMITS.flows) return null;

  const viewports: QaViewport[] = [];
  const viewportNames = new Set<string>();
  for (const rawViewport of rawViewports) {
    if (!rawViewport || typeof rawViewport !== "object" || Array.isArray(rawViewport)) return null;
    const viewport = rawViewport as Record<string, unknown>;
    if (!hasExactKeys(viewport, VIEWPORT_KEYS)) return null;
    const name = usefulText(viewport.name, QA_POLICY_LIMITS.viewportName, persisted);
    if (!name) return null;
    const normalizedName = name.toLowerCase();
    if (viewportNames.has(normalizedName)
      || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
      || Number(viewport.width) < QA_POLICY_LIMITS.dimensionMin
      || Number(viewport.width) > QA_POLICY_LIMITS.dimensionMax
      || Number(viewport.height) < QA_POLICY_LIMITS.dimensionMin
      || Number(viewport.height) > QA_POLICY_LIMITS.dimensionMax) return null;
    viewportNames.add(normalizedName);
    viewports.push({ name, width: Number(viewport.width), height: Number(viewport.height) });
  }

  const flows: string[] = [];
  const flowValues = new Set<string>();
  for (const rawFlow of rawFlows) {
    const flow = usefulText(rawFlow, QA_POLICY_LIMITS.flow, persisted);
    if (!flow || flowValues.has(flow)) return null;
    flowValues.add(flow);
    flows.push(flow);
  }

  let parsed: QaPolicy;
  if (!policy.required) {
    if (targetUrl !== null || viewports.length > 0 || flows.length > 0) return null;
    parsed = { required: false, target_url: null, viewports: [], flows: [] };
  } else {
    if (!targetUrl || !validQaTargetUrl(targetUrl) || (persisted && viewports.length === 0)) return null;
    parsed = {
      required: true,
      target_url: targetUrl,
      viewports: viewports.length > 0 ? viewports : DEFAULT_QA_VIEWPORTS.map((viewport) => ({ ...viewport })),
      flows,
    };
  }
  return canonicalPolicyBytes(parsed) <= QA_POLICY_LIMITS.canonicalJsonBytes ? parsed : null;
}

/** Parses the create API shape and returns its canonical persisted representation. */
export function parseQaPolicyInput(value: unknown): QaPolicy | null {
  return parsePolicy(value, false);
}

/** Accepts only the exact canonical representation persisted by the create API. */
export function parsePersistedQaPolicy(value: unknown): QaPolicy | null {
  return parsePolicy(value, true);
}
