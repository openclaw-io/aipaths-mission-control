import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { hashQaResult, type QaEvidenceDescriptor, type QaResult } from "@/lib/qa/result";

const DEFAULT_ROOT = "/Users/joaco/openclaw/artifacts/visual-qa";
const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;
const STORAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;

export class QaEvidencePathError extends Error {}
type QaEvidenceFileDescriptor = Pick<QaEvidenceDescriptor, "storage_ref" | "sha256" | "bytes" | "media_type">;

function safeStorageRef(value: string) {
  return STORAGE_REF.test(value) && !value.includes("//") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function inside(root: string, child: string) {
  const path = relative(root, child);
  return path === "" || (!!path && !path.startsWith("..") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path));
}

function strictUtf8(bytes: Buffer) {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function sniffMediaType(bytes: Buffer) {
  if (bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08))) return "application/zip";
  const text = strictUtf8(bytes);
  if (text === null) return null;
  try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
}

function sameFile(before: Stats, after: Stats) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export async function readVerifiedQaEvidence(descriptor: QaEvidenceFileDescriptor) {
  if (!safeStorageRef(descriptor.storage_ref)) throw new QaEvidencePathError("qa_evidence_path_invalid");
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > MAX_EVIDENCE_BYTES) {
    throw new Error("qa_evidence_size_invalid");
  }
  const root = await realpath(process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT || DEFAULT_ROOT);
  const target = resolve(root, descriptor.storage_ref);
  if (!inside(root, target)) throw new QaEvidencePathError("qa_evidence_path_invalid");
  let targetReal: string;
  try { targetReal = await realpath(target); } catch { throw new Error("qa_evidence_unavailable"); }
  // Requiring lexical and canonical paths to match rejects symlinks in every
  // path component, not just a final-component escape.
  if (targetReal !== target || !inside(root, targetReal)) throw new QaEvidencePathError("qa_evidence_path_invalid");

  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("qa_evidence_unavailable"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_EVIDENCE_BYTES || before.size !== descriptor.bytes) {
      throw new Error("qa_evidence_size_mismatch");
    }
    // Hash and serve bytes read from the already-opened regular-file handle;
    // never stat one pathname and then trust a later pathname read.
    const body = await handle.readFile();
    const after = await handle.stat();
    const targetAfter = await realpath(target).catch(() => "");
    if (!sameFile(before, after) || targetAfter !== target || body.length !== descriptor.bytes) {
      throw new Error("qa_evidence_changed_during_read");
    }
    const mediaType = sniffMediaType(body);
    if (mediaType !== descriptor.media_type
      || createHash("sha256").update(body).digest("hex") !== descriptor.sha256) {
      throw new Error("qa_evidence_descriptor_mismatch");
    }
    return { body, mediaType };
  } finally {
    await handle.close();
  }
}

export async function verifyQaEvidence(result: QaResult, resultHash: string) {
  if (hashQaResult(result) !== resultHash) throw new Error("qa_evidence_result_hash_mismatch");
  for (const descriptor of result.evidence) await readVerifiedQaEvidence(descriptor);
}
