import { NextResponse, type NextRequest } from "next/server";
import { listIntelInbox } from "@/lib/intel-inbox";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "new";
    const lane = searchParams.get("primaryAssetType") || null;
    const owner = searchParams.get("ownerAgent") || null;

    const result = await listIntelInbox({
      status: status === "all" ? "all" : (status as "new" | "saved" | "dismissed" | "promoted"),
      lane: lane === "all" ? null : lane,
      owner: owner === "all" ? null : owner,
      limit: 50,
      offset: 0,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to list intel inbox" }, { status: 500 });
  }
}
