import { createHash } from "node:crypto";
import { execFileChecked, type RegisteredRepository } from "@/lib/work-items/git-artifact";

export const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_PACKAGE_BYTES = 3 * 1024 * 1024;

export type ReviewerPackageInput = {
  executionId: string;
  reviewRunId: string;
  workItemId: string;
  executionAttemptId: string;
  repository: RegisteredRepository & { key: string; max_diff_bytes: number; max_package_bytes: number };
  baseSha: string;
  targetSha: string;
  plan: unknown;
  approval: unknown;
  task: { key: string; title: string; description: string | null; acceptance_criteria: string[] };
  untrustedAgentTests?: unknown;
};

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonical(value));
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function gitArgs(repositoryRoot: string, args: string[]) {
  return [
    "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
    "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
    "-C", repositoryRoot, ...args,
  ];
}

async function boundedGit(repositoryRoot: string, args: string[], maxBytes: number, oversizeError: string) {
  try {
    const result = await execFileChecked("git", gitArgs(repositoryRoot, args), { maxBuffer: maxBytes + 1 });
    if (Buffer.byteLength(result.stdout) > maxBytes) throw new Error(oversizeError);
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && (error.message === oversizeError || /maxBuffer|stdout maxBuffer/i.test(error.message))) {
      throw new Error(oversizeError);
    }
    throw error;
  }
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github_token", /\bgh[opusr]_[A-Za-z0-9]{20,}\b/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["credential_assignment", /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\n]{12,}["']/i],
];

export function detectSecrets(text: string) {
  const finding = SECRET_PATTERNS.find(([, pattern]) => pattern.test(text));
  if (finding) throw new Error(`review_package_secret_detected:${finding[0]}`);
}

function parseNameStatus(raw: string) {
  const values = raw.split("\0").filter(Boolean);
  const manifest: Array<{ status: string; path: string; old_path?: string }> = [];
  for (let index = 0; index < values.length;) {
    const status = values[index++];
    if (/^[RC]/.test(status)) {
      const oldPath = values[index++];
      const path = values[index++];
      manifest.push({ status, path, old_path: oldPath });
    } else {
      manifest.push({ status, path: values[index++] });
    }
  }
  return manifest;
}

export async function buildReviewerPackage(input: ReviewerPackageInput) {
  const maxDiff = input.repository.max_diff_bytes || DEFAULT_MAX_DIFF_BYTES;
  const maxPackage = input.repository.max_package_bytes || DEFAULT_MAX_PACKAGE_BYTES;
  const range = `${input.baseSha}..${input.targetSha}`;
  const [diff, names] = await Promise.all([
    boundedGit(input.repository.canonical_root, ["diff", "--no-ext-diff", "--binary", range, "--"], maxDiff, "review_package_diff_oversize"),
    boundedGit(input.repository.canonical_root, ["diff", "--no-ext-diff", "--name-status", "-z", range, "--"], maxDiff, "review_package_manifest_oversize"),
  ]);
  detectSecrets(diff);
  const value = canonical({
    schema_version: 1,
    execution: {
      id: input.executionId,
      review_run_id: input.reviewRunId,
      work_item_id: input.workItemId,
      execution_attempt_id: input.executionAttemptId,
    },
    repository: { key: input.repository.key, object_format: input.repository.object_format },
    artifact: {
      base_sha: input.baseSha,
      target_sha: input.targetSha,
      diff_sha256: sha256(diff),
      diff_bytes: Buffer.byteLength(diff),
      manifest: parseNameStatus(names),
      diff,
    },
    approved_plan: input.plan,
    approval_scope: input.approval,
    task: input.task,
    agent_reported_tests_untrusted: input.untrustedAgentTests ?? null,
  });
  const json = JSON.stringify(value);
  detectSecrets(json);
  if (Buffer.byteLength(json) > maxPackage) throw new Error("review_package_oversize_manual_review_required");
  return { value, json, sha256: sha256(json), bytes: Buffer.byteLength(json) };
}

export type ReviewerFinding = {
  severity: "blocker" | "major" | "minor" | "suggestion";
  title: string;
  evidence: string;
  recommendation: string;
};
export type ReviewerResult = {
  verdict: "approved" | "changes_requested";
  feedback: string | null;
  findings: ReviewerFinding[];
};

function usefulText(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

/** Strict, no-repair result parser: exact top-level and finding schemas only. */
export function parseReviewerResult(stdout: string): ReviewerResult {
  if (Buffer.byteLength(stdout) > 256 * 1024) throw new Error("reviewer_stdout_oversize");
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("reviewer_stdout_invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer_result_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "feedback,findings,verdict") throw new Error("reviewer_result_unknown_or_missing_fields");
  if (record.verdict !== "approved" && record.verdict !== "changes_requested") throw new Error("reviewer_verdict_invalid");
  if (record.feedback !== null && typeof record.feedback !== "string") throw new Error("reviewer_feedback_invalid");
  const feedback = typeof record.feedback === "string" ? record.feedback.trim() || null : null;
  if (feedback !== null && feedback.length > 20_000) throw new Error("reviewer_feedback_invalid");
  if (!Array.isArray(record.findings) || record.findings.length > 100) throw new Error("reviewer_findings_invalid");
  const findings = record.findings.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("reviewer_finding_invalid");
    const finding = raw as Record<string, unknown>;
    if (Object.keys(finding).sort().join(",") !== "evidence,recommendation,severity,title") throw new Error("reviewer_finding_unknown_or_missing_fields");
    if (!["blocker", "major", "minor", "suggestion"].includes(String(finding.severity))) throw new Error("reviewer_finding_severity_invalid");
    const title = usefulText(finding.title, 500);
    const evidence = usefulText(finding.evidence, 5_000);
    const recommendation = usefulText(finding.recommendation, 5_000);
    if (!title || !evidence || !recommendation) throw new Error("reviewer_finding_not_semantically_useful");
    return { severity: finding.severity, title, evidence, recommendation } as ReviewerFinding;
  });
  if (record.verdict === "approved" && findings.some((finding) => finding.severity === "blocker" || finding.severity === "major")) {
    throw new Error("reviewer_approval_has_blocking_findings");
  }
  if (record.verdict === "changes_requested" && (!feedback || findings.length === 0)) {
    throw new Error("reviewer_changes_require_feedback_and_finding");
  }
  return { verdict: record.verdict, feedback, findings };
}
