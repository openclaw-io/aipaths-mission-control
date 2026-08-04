import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";
import { lockQaExecution, failQaExecution } from "@/lib/qa/execution";
import {
  qaRunnerProcessGroupAlive,
  terminateQaRunnerProcessGroup,
  verifyQaRunnerProcessIdentity,
} from "@/lib/qa/dispatch";

export const dynamic = "force-dynamic";
const STALE_MS = 10 * 60_000;
function response(body: object, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function authorized(request: NextRequest) {
  const expected = process.env.AGENT_API_KEY;
  return !!expected && request.headers.get("authorization") === `Bearer ${expected}`;
}
export async function POST(request: NextRequest) {
  if (!authorized(request)) return response({ error: "Unauthorized" }, 401);
  const candidates = await query<{ id: string }>(`select id from qa_executions where status='running'
    and heartbeat_at<now()-interval '10 minutes' order by heartbeat_at,id limit 5`);
  const executionIds: string[] = [];
  const cleanupFailedIds: string[] = [];
  for (const candidate of candidates.rows) {
    let outcome: "reconciled" | "cleanup_failed" | "skipped";
    try {
      outcome = await withTransaction(async (client): Promise<"reconciled" | "cleanup_failed" | "skipped"> => {
        const execution = await lockQaExecution(client,candidate.id);
        if (!execution || execution.status!=="running" || new Date(execution.heartbeat_at).getTime()>=Date.now()-STALE_MS) {
          return "skipped";
        }
        const stalePid = typeof execution.pid === "number" && Number.isInteger(execution.pid) && execution.pid > 1
          ? execution.pid : -1;
        const birthToken = typeof execution.runner_birth_token === "string" ? execution.runner_birth_token : "";
        if (stalePid < 2 || !birthToken) return "cleanup_failed";
        const runnerIdentity = { pid: stalePid, birth_token: birthToken };
        try {
          if (qaRunnerProcessGroupAlive(stalePid)) {
            if (!(await verifyQaRunnerProcessIdentity(runnerIdentity, candidate.id))) return "cleanup_failed";
            await terminateQaRunnerProcessGroup(runnerIdentity, candidate.id, { termWaitMs: 30_000, killWaitMs: 10_000 });
          }
          if (qaRunnerProcessGroupAlive(stalePid)) return "cleanup_failed";
        } catch {
          return "cleanup_failed";
        }
        const reason="qa_execution_stale_timeout";
        await failQaExecution(client,execution,reason);
        const now=new Date().toISOString();
        const closed=await client.query<{ reconciled: boolean }>(
          "select reconcile_visual_qa_execution($1,$2,$3) reconciled", [candidate.id,reason,now]);
        if (closed.rows[0]?.reconciled !== true) throw new Error("visual_qa_reconcile_authority_conflict");
        return "reconciled";
      });
    } catch {
      outcome = "cleanup_failed";
    }
    if (outcome === "reconciled") executionIds.push(candidate.id);
    if (outcome === "cleanup_failed") cleanupFailedIds.push(candidate.id);
  }
  const body = {
    reconciled:executionIds.length,
    execution_ids:executionIds,
    cleanup_failed:cleanupFailedIds.length,
    cleanup_failed_execution_ids:cleanupFailedIds,
  };
  return response(body, cleanupFailedIds.length > 0 ? 503 : 200);
}
