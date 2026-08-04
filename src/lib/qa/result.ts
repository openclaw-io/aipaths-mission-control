import { createHash } from "node:crypto";
import { parsePersistedQaPolicy, utf8ByteLength, type QaPolicy } from "@/lib/loops/qa-policy";

const LIMITS = {
  // Transport protects JSON.parse; canonicalJsonBytes is the semantic SQL/TS cap.
  transportJsonBytes: 512 * 1024,
  canonicalJsonBytes: 256 * 1024,
  evidence: 64,
  findings: 50,
  text: 2_048,
  storageRef: 1_024,
  mediaType: 120,
  evidenceBytes: 100 * 1024 * 1024,
} as const;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "video/webm", "video/mp4",
  "application/json", "application/zip", "text/plain",
]);

function safeStorageRef(value: string) {
  return STORAGE_REF.test(value) && !value.includes("//")
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

export type QaCheck = { viewport?: string; flow?: string; status: "pass" | "fail"; details: string | null };
export type QaEvidenceDescriptor = {
  kind: "screenshot" | "video" | "trace" | "log";
  storage_ref: string;
  sha256: string;
  bytes: number;
  media_type: string;
  viewport: string | null;
  flow: string | null;
};
export type QaFinding = { title: string; evidence: string; recommendation: string };
export type QaResult = {
  verdict: "pass" | "changes" | "infrastructure_failure";
  tested_sha: string;
  viewport_checks: Array<{ viewport: string; status: "pass" | "fail"; details: string | null }>;
  flow_checks: Array<{ flow: string; status: "pass" | "fail"; details: string | null }>;
  evidence: QaEvidenceDescriptor[];
  findings: QaFinding[];
  error: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function text(value: unknown, max: number = LIMITS.text) {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > max) return null;
  const first = value.charCodeAt(0); const last = value.charCodeAt(value.length - 1);
  return first <= 0x20 || first === 0x7f || last <= 0x20 || last === 0x7f ? null : value;
}
function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

/** RFC-8785-compatible for this JSON-only bounded contract: keys sorted, arrays retained, no non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("qa_canonical_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (!object) throw new Error("qa_canonical_non_json_value");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export function hashQaPolicy(policy: QaPolicy) {
  const parsed = parsePersistedQaPolicy(policy);
  if (!parsed) throw new Error("invalid_persisted_qa_policy");
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}
export function hashQaResult(result: QaResult) {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}

function parseChecks(raw: unknown, kind: "viewport" | "flow", expected: string[]) {
  if (!Array.isArray(raw) || raw.length !== expected.length) throw new Error(`qa_${kind}_checks_incomplete`);
  const seen = new Set<string>();
  return raw.map((entry) => {
    const item = record(entry);
    if (!item || !exact(item, [kind, "status", "details"])) throw new Error(`qa_${kind}_check_shape_invalid`);
    const identity = text(item[kind], 500);
    const status = item.status;
    const details = nullableText(item.details);
    if (!identity || !expected.includes(identity) || seen.has(identity)
      || (status !== "pass" && status !== "fail") || (item.details !== null && !details)) {
      throw new Error(`qa_${kind}_check_invalid`);
    }
    seen.add(identity);
    return { [kind]: identity, status, details };
  });
}

function assertExactVisualEvidenceCoverage(evidence: QaEvidenceDescriptor[], policy: QaPolicy) {
  const expectedFlows: Array<string | null> = policy.flows.length ? policy.flows : [null];
  const expected = new Set<string>();
  for (const viewport of policy.viewports) {
    for (const flow of expectedFlows) {
      for (const kind of ["screenshot", "log"]) expected.add(`${viewport.name}\u0000${flow ?? ""}\u0000${kind}`);
    }
  }
  if (evidence.length !== expected.size) throw new Error("qa_evidence_coverage_incomplete");
  const seen = new Set<string>();
  const storageRefs = new Set<string>();
  for (const descriptor of evidence) {
    const key = `${descriptor.viewport ?? ""}\u0000${descriptor.flow ?? ""}\u0000${descriptor.kind}`;
    const mediaMatchesKind = descriptor.kind === "screenshot"
      ? descriptor.media_type === "image/png"
      : descriptor.kind === "log" && descriptor.media_type === "application/json";
    if (!descriptor.viewport || !expected.has(key) || seen.has(key) || storageRefs.has(descriptor.storage_ref)
      || !mediaMatchesKind) throw new Error("qa_evidence_coverage_invalid");
    seen.add(key);
    storageRefs.add(descriptor.storage_ref);
  }
}

export function parseQaResult(input: string, frozenPolicy: QaPolicy, expectedSha?: string): QaResult {
  if (typeof input !== "string" || utf8ByteLength(input) > LIMITS.transportJsonBytes) throw new Error("qa_result_transport_too_large");
  const policy = parsePersistedQaPolicy(frozenPolicy);
  if (!policy || !policy.required) throw new Error("qa_required_policy_invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(input); } catch { throw new Error("qa_result_json_invalid"); }
  const value = record(decoded);
  const keys = ["verdict", "tested_sha", "viewport_checks", "flow_checks", "evidence", "findings", "error"];
  if (!value || !exact(value, keys)) throw new Error("qa_result_shape_invalid");
  if (!["pass", "changes", "infrastructure_failure"].includes(String(value.verdict))) throw new Error("qa_verdict_invalid");
  const testedSha = text(value.tested_sha, 64);
  if (!testedSha || !SHA.test(testedSha) || (expectedSha && testedSha !== expectedSha)) throw new Error("qa_tested_sha_mismatch");
  if (!Array.isArray(value.evidence) || value.evidence.length > LIMITS.evidence
    || !Array.isArray(value.findings) || value.findings.length > LIMITS.findings) throw new Error("qa_result_bounds_invalid");

  const infrastructure = value.verdict === "infrastructure_failure";
  if (!Array.isArray(value.viewport_checks) || !Array.isArray(value.flow_checks)) {
    throw new Error("qa_result_checks_invalid");
  }
  const viewportChecks = infrastructure ? [] : parseChecks(value.viewport_checks, "viewport", policy.viewports.map((v) => v.name));
  const flowChecks = infrastructure ? [] : parseChecks(value.flow_checks, "flow", policy.flows);
  if (infrastructure && (value.viewport_checks.length || value.flow_checks.length)) {
    throw new Error("qa_infrastructure_checks_forbidden");
  }

  const evidence = value.evidence.map((entry): QaEvidenceDescriptor => {
    const item = record(entry);
    if (!item || !exact(item, ["kind", "storage_ref", "sha256", "bytes", "media_type", "viewport", "flow"])) throw new Error("qa_evidence_shape_invalid");
    const storageRef = text(item.storage_ref, LIMITS.storageRef);
    const mediaType = text(item.media_type, LIMITS.mediaType);
    const viewport = item.viewport === null ? null : text(item.viewport, 80);
    const flow = item.flow === null ? null : text(item.flow, 500);
    if (!storageRef || !safeStorageRef(storageRef) || !mediaType || !MEDIA_TYPES.has(mediaType)
      || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1
      || Number(item.bytes) > LIMITS.evidenceBytes || !["screenshot", "video", "trace", "log"].includes(String(item.kind))
      || (viewport !== null && !policy.viewports.some((candidate) => candidate.name === viewport))
      || (flow !== null && !policy.flows.includes(flow))) throw new Error("qa_evidence_invalid");
    return { kind: item.kind as QaEvidenceDescriptor["kind"], storage_ref: storageRef, sha256: String(item.sha256),
      bytes: Number(item.bytes), media_type: mediaType, viewport, flow };
  });
  const findings = value.findings.map((entry): QaFinding => {
    const item = record(entry);
    if (!item || !exact(item, ["title", "evidence", "recommendation"])) throw new Error("qa_finding_shape_invalid");
    const title = text(item.title, 500); const findingEvidence = text(item.evidence); const recommendation = text(item.recommendation);
    if (!title || !findingEvidence || !recommendation) throw new Error("qa_finding_invalid");
    return { title, evidence: findingEvidence, recommendation };
  });
  const error = nullableText(value.error);
  if (value.error !== null && !error) throw new Error("qa_error_invalid");
  if (value.verdict === "pass" && (findings.length || viewportChecks.some((check) => check.status === "fail")
      || flowChecks.some((check) => check.status === "fail") || error !== null)) throw new Error("qa_pass_incoherent");
  if (value.verdict === "changes" && (findings.length === 0 || error !== null
      || !viewportChecks.some((check) => check.status === "fail") && !flowChecks.some((check) => check.status === "fail"))) {
    throw new Error("qa_changes_findings_required");
  }
  if (infrastructure && (findings.length !== 0 || evidence.length !== 0 || !error)) throw new Error("qa_infrastructure_result_incoherent");
  if (!infrastructure) assertExactVisualEvidenceCoverage(evidence, policy);
  const parsed = { verdict: value.verdict as QaResult["verdict"], tested_sha: testedSha,
    viewport_checks: viewportChecks as QaResult["viewport_checks"], flow_checks: flowChecks as QaResult["flow_checks"],
    evidence, findings, error };
  if (utf8ByteLength(canonicalJson(parsed)) > LIMITS.canonicalJsonBytes) throw new Error("qa_result_too_large");
  return parsed;
}
