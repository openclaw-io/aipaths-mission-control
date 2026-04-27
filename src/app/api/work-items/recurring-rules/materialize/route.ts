import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { materializeRecurringWork } from "@/lib/work-items/recurring";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await materializeRecurringWork(supabaseAdmin, "dashboard");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "materialize_failed" }, { status: 500 });
  }
}
