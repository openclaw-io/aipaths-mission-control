import { NextResponse } from "next/server";
import { getIntelInboxDetail } from "@/lib/intel-inbox";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const detail = await getIntelInboxDetail(id);

    if (!detail) {
      return NextResponse.json({ error: "Intel item not found" }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load intel item" }, { status: 500 });
  }
}
