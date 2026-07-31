import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";
import { lockQaExecution, failQaExecution } from "@/lib/qa/execution";

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
    and heartbeat_at<now()-interval '10 minutes' order by heartbeat_at,id limit 50`);
  const executionIds: string[] = [];
  for (const candidate of candidates.rows) {
    const applied = await withTransaction(async (client) => {
      const execution = await lockQaExecution(client,candidate.id);
      if (!execution || execution.status!=="running" || new Date(execution.heartbeat_at).getTime()>=Date.now()-STALE_MS) return false;
      const reason="qa_execution_stale_timeout";
      await failQaExecution(client,execution,reason);
      const now=new Date().toISOString();
      const closed=await client.query<{ reconciled: boolean }>(
        "select reconcile_visual_qa_execution($1,$2,$3) reconciled", [candidate.id,reason,now]);
      return closed.rows[0]?.reconciled === true;
    });
    if(applied) executionIds.push(candidate.id);
  }
  return response({reconciled:executionIds.length,execution_ids:executionIds});
}
