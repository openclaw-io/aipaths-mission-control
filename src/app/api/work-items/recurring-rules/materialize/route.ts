import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { materializeRecurringWork, plannedOccurrenceDryRun, type RecurringWorkRule } from "@/lib/work-items/recurring";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const dryRun = request.nextUrl.searchParams.get("dry_run") === "1" || request.nextUrl.searchParams.get("dryRun") === "1";
    if (!dryRun) return NextResponse.json({ error: "Use ?dry_run=1 for non-mutating previews." }, { status: 400 });

    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get("days") || 14), 1), 120);
    const { data: rules, error } = await supabaseAdmin
      .from("recurring_work_rules")
      .select("*")
      .eq("enabled", true)
      .order("created_at", { ascending: true });

    if (error) throw error;

    const now = new Date();
    const result = ((rules || []) as RecurringWorkRule[]).map((rule) => ({
      rule_id: rule.id,
      title: rule.title,
      occurrences: plannedOccurrenceDryRun({ ...rule, horizon_days: days }, now).slice(0, days),
    }));

    return NextResponse.json({ dry_run: true, days, rules: result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : JSON.stringify(error) || "dry_run_failed" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await materializeRecurringWork(supabaseAdmin, "dashboard");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : JSON.stringify(error) || "materialize_failed" }, { status: 500 });
  }
}
