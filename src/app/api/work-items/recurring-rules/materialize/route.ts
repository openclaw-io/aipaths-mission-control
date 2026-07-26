import { NextResponse, type NextRequest } from "next/server";
import {
  listEnabledRecurringWorkRulesLocal,
  materializeRecurringWorkLocal,
  plannedOccurrenceDryRun,
} from "@/lib/work-items/recurring";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const dryRun = request.nextUrl.searchParams.get("dry_run") === "1" || request.nextUrl.searchParams.get("dryRun") === "1";
    if (!dryRun) return NextResponse.json({ error: "Use ?dry_run=1 for non-mutating previews." }, { status: 400 });

    const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get("days") || 14), 1), 120);
    const rules = await listEnabledRecurringWorkRulesLocal();

    const now = new Date();
    const result = rules.map((rule) => ({
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
    const result = await materializeRecurringWorkLocal("dashboard");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : JSON.stringify(error) || "materialize_failed" }, { status: 500 });
  }
}
