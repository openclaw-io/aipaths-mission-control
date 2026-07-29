import { NextResponse, type NextRequest } from "next/server";
import { query, withTransaction } from "@/lib/db/postgres";
import { lockReviewerExecution } from "@/lib/reviewer/execution-context";
import { failReviewerExecution } from "@/lib/reviewer/review-completion";

export const dynamic = "force-dynamic";
const STALE_MS = 10 * 60_000;

function authorized(request: NextRequest) {
  const expected = process.env.AGENT_API_KEY;
  return !!expected && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const candidates = await query<{ id: string }>(
    `select id from reviewer_executions where status='running'
      and heartbeat_at < now()-interval '10 minutes' order by heartbeat_at,id limit 50`,
  );
  const reconciled: string[] = [];
  for (const candidate of candidates.rows) {
    const applied = await withTransaction(async (client) => {
      const execution = await lockReviewerExecution(client, candidate.id);
      if (!execution || execution.status !== "running"
        || new Date(execution.heartbeat_at).getTime() >= Date.now() - STALE_MS) return false;
      const reason = "reviewer_execution_stale_timeout";
      await failReviewerExecution(client, execution, reason);
      const now = new Date().toISOString();
      const closed = await client.query(
        `update reviewer_executions set status='failed',error=$2,finished_at=$3,
           capability_revoked_at=$3,heartbeat_at=$3,updated_at=$3
         where id=$1 and status='running' returning id`,
        [candidate.id, reason, now],
      );
      return closed.rowCount === 1;
    });
    if (applied) reconciled.push(candidate.id);
  }
  return NextResponse.json({ reconciled: reconciled.length, execution_ids: reconciled });
}
