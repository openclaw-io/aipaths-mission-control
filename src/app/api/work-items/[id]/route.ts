import { NextResponse } from "next/server";
import { getLocalMissionControlUser } from "@/lib/auth/local";
import { getWorkItem } from "@/lib/db/mission-control";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getLocalMissionControlUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const item = await getWorkItem(id);
    if (!item) return NextResponse.json({ error: "Work item not found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) {
    console.error("[api/work-items/:id] local Postgres query failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "local_postgres_query_failed" }, { status: 500 });
  }
}
