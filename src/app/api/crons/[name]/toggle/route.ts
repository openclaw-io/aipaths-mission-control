import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "Cron toggles are read-only in Mission Control. Change launchd jobs directly and refresh cron_health inventory." },
    { status: 410 },
  );
}
