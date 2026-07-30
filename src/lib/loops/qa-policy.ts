export const QA_POLICY_LIMITS = {
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

function usefulText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function validTargetUrl(value: string) {
  if (value.length > QA_POLICY_LIMITS.url || !/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function parsePolicy(value: unknown, persisted: boolean): QaPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (!hasExactKeys(policy, POLICY_KEYS, persisted ? POLICY_KEYS : ["required"])
    || typeof policy.required !== "boolean") return null;

  if (policy.target_url !== undefined && policy.target_url !== null && typeof policy.target_url !== "string") return null;
  const targetUrl = policy.target_url === undefined || policy.target_url === null
    ? null
    : usefulText(policy.target_url, QA_POLICY_LIMITS.url);
  if (typeof policy.target_url === "string" && (targetUrl === null || (persisted && targetUrl !== policy.target_url))) return null;

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
    const name = usefulText(viewport.name, QA_POLICY_LIMITS.viewportName);
    if (!name || (persisted && name !== viewport.name)) return null;
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
    const flow = usefulText(rawFlow, QA_POLICY_LIMITS.flow);
    if (!flow || (persisted && flow !== rawFlow) || flowValues.has(flow)) return null;
    flowValues.add(flow);
    flows.push(flow);
  }

  if (!policy.required) {
    if (targetUrl !== null || viewports.length > 0 || flows.length > 0) return null;
    return { required: false, target_url: null, viewports: [], flows: [] };
  }
  if (!targetUrl || !validTargetUrl(targetUrl) || (persisted && viewports.length === 0)) return null;
  return {
    required: true,
    target_url: targetUrl,
    viewports: viewports.length > 0
      ? viewports
      : DEFAULT_QA_VIEWPORTS.map((viewport) => ({ ...viewport })),
    flows,
  };
}

/** Parses the create API shape and returns its canonical persisted representation. */
export function parseQaPolicyInput(value: unknown): QaPolicy | null {
  return parsePolicy(value, false);
}

/** Accepts only the exact canonical representation persisted by the create API. */
export function parsePersistedQaPolicy(value: unknown): QaPolicy | null {
  return parsePolicy(value, true);
}
