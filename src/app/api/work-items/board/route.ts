import { NextResponse } from "next/server";
import { getLocalMissionControlUser } from "@/lib/auth/local";
import { getWorkItemsBoard } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getLocalMissionControlUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const includeRules = searchParams.get("includeRules") === "1";

  try {
    return NextResponse.json(await getWorkItemsBoard(includeRules));
  } catch (error) {
    console.error("[api/work-items/board] local Postgres query failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}
