import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db/postgres";
import { QaEvidencePathError, readVerifiedQaEvidence } from "@/lib/qa/evidence";

export const dynamic = "force-dynamic";

const STORAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const HASH = /^[0-9a-f]{64}$/;

function response(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function authorized(request: NextRequest) {
  const expected = process.env.AGENT_API_KEY;
  return !!expected && request.headers.get("authorization") === `Bearer ${expected}`;
}

function safeRef(value: string) {
  return STORAGE_REF.test(value) && !value.includes("//") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type EvidenceOwnershipRow = {
  kind: string;
  uri: string;
  content: string | null;
  metadata: Record<string, unknown>;
  authoritative_descriptor: Record<string, unknown>;
};

type EvidenceDescriptor = {
  kind: string;
  storage_ref: string;
  sha256: string;
  bytes: number;
  media_type: string;
  viewport?: string | null;
  flow?: string | null;
};

function parseDescriptor(value: unknown): EvidenceDescriptor {
  const descriptor = record(value);
  const parsed = {
    kind: typeof descriptor?.kind === "string" ? descriptor.kind : "",
    storage_ref: typeof descriptor?.storage_ref === "string" ? descriptor.storage_ref : "",
    sha256: typeof descriptor?.sha256 === "string" ? descriptor.sha256 : "",
    bytes: typeof descriptor?.bytes === "number" ? descriptor.bytes : Number.NaN,
    media_type: typeof descriptor?.media_type === "string" ? descriptor.media_type : "",
    viewport: typeof descriptor?.viewport === "string" || descriptor?.viewport === null ? descriptor.viewport : undefined,
    flow: typeof descriptor?.flow === "string" || descriptor?.flow === null ? descriptor.flow : undefined,
  };
  if (!["screenshot", "trace", "log", "video"].includes(parsed.kind)
    || !HASH.test(parsed.sha256)
    || !Number.isSafeInteger(parsed.bytes) || parsed.bytes < 1 || parsed.bytes > 100 * 1024 * 1024
    || !["image/png", "image/jpeg", "image/webp", "application/json", "text/plain"].includes(parsed.media_type)) {
    throw new Error("qa_evidence_ownership_malformed");
  }
  return parsed;
}

function parseOwnership(row: EvidenceOwnershipRow, storageRef: string): EvidenceDescriptor {
  if (row.uri !== `visual-qa://${storageRef}` || row.content !== null) throw new Error("qa_evidence_ownership_malformed");
  const metadata = record(row.metadata);
  const descriptor = parseDescriptor(metadata?.descriptor);
  const authoritative = parseDescriptor(row.authoritative_descriptor);
  if (row.kind !== `visual_qa_${descriptor.kind}`
    || descriptor.storage_ref !== storageRef
    || JSON.stringify(descriptor) !== JSON.stringify(authoritative)) {
    throw new Error("qa_evidence_ownership_malformed");
  }
  return authoritative;
}

async function loadEvidenceOwnership(storageRef: string) {
  const result = await query<EvidenceOwnershipRow>(
    `select evidence.kind,evidence.uri,evidence.content,evidence.metadata,
            authoritative.descriptor authoritative_descriptor
       from public.loop_evidence evidence
       join public.qa_executions execution
         on evidence.task_id=execution.task_id
        and evidence.task_run_id=execution.qa_run_id
        and evidence.metadata->>'qa_execution_id'=execution.id::text
        and evidence.metadata->>'task_id'=execution.task_id::text
        and evidence.metadata->>'qa_run_id'=execution.qa_run_id::text
        and evidence.metadata->>'work_item_id'=execution.work_item_id::text
        and evidence.metadata->>'execution_attempt_id'=execution.execution_attempt_id::text
        and evidence.metadata->>'policy_hash'=execution.policy_hash
        and evidence.metadata->>'result_hash'=execution.result_hash
        and evidence.metadata->>'tested_sha'=execution.result->>'tested_sha'
        and evidence.metadata->>'planner_session_id' is not distinct from execution.planner_session_id
       cross join lateral jsonb_array_elements(execution.result->'evidence') authoritative(descriptor)
      where evidence.uri=$1
        and evidence.content is null
        and evidence.kind='visual_qa_'||(authoritative.descriptor->>'kind')
        and evidence.uri='visual-qa://'||(authoritative.descriptor->>'storage_ref')
        and evidence.metadata->'schema_version'='1'::jsonb
        and evidence.metadata->'descriptor'=authoritative.descriptor
        and execution.status in ('succeeded','failed')
        and execution.capability_consumed_at is not null
        and execution.capability_revoked_at is null
        and execution.result is not null
        and execution.result_hash is not null
        and execution.result_hash=public.qa_jsonb_sha256(execution.result)
      order by evidence.id`,
    [`visual-qa://${storageRef}`],
  );
  if (result.rows.length !== 1) throw new Error("qa_evidence_ownership_cardinality");
  return parseOwnership(result.rows[0], storageRef);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ ref: string[] }> }) {
  if (!authorized(request)) return response({ error: "Unauthorized" }, 401);
  const { ref } = await params;
  const storageRef = Array.isArray(ref) ? ref.join("/") : "";
  if (!safeRef(storageRef)) return response({ error: "invalid_qa_evidence_ref" }, 400);
  let descriptor: EvidenceDescriptor;
  try {
    descriptor = await loadEvidenceOwnership(storageRef);
  } catch {
    return response({ error: "qa_evidence_not_found" }, 404);
  }
  if (descriptor.media_type === "text/plain") {
    return response({ error: "unsupported_qa_evidence_media_type" }, 415);
  }
  try {
    const { body, mediaType } = await readVerifiedQaEvidence(descriptor);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": mediaType,
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(mediaType === "application/json"
          ? { "Content-Disposition": 'attachment; filename="visual-qa-log.json"' }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof QaEvidencePathError) return response({ error: "invalid_qa_evidence_ref" }, 400);
    return response({ error: "qa_evidence_not_found" }, 404);
  }
}
