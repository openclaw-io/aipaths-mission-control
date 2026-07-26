import { NextResponse } from "next/server";
import { getLocalMissionControlUser } from "@/lib/auth/local";
import { getOfficeState } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = getLocalMissionControlUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const state = await getOfficeState();
    return NextResponse.json({ tasks: state.tasks, memory: state.memory });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}
