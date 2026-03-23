import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function POST() {
  // Auth check — only authenticated users can restart
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { stdout, stderr } = await execAsync("openclaw gateway restart", {
      timeout: 15000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });

    return NextResponse.json({
      ok: true,
      output: (stdout + stderr).trim().slice(0, 500),
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
