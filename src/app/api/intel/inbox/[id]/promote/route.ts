import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { promoteIntelInboxItem } from "@/lib/intel-inbox";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const comment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const ownerAgent = typeof body?.ownerAgent === "string" ? body.ownerAgent.trim() : "";
  const collaborators = Array.isArray(body?.collaborators)
    ? body.collaborators
        .filter((value: unknown): value is string => typeof value === "string")
        .map((value: string) => value.trim())
        .filter(Boolean)
    : [];

  try {
    const result = await promoteIntelInboxItem({
      enrichedItemId: id,
      reviewer: user.email || user.id,
      notes: comment || undefined,
      ownerAgent: ownerAgent || undefined,
      collaborators,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof (error as { status?: number }).status === "number"
      ? (error as { status: number }).status
      : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to promote intel item" }, { status });
  }
}
