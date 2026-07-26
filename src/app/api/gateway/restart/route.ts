import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "@/lib/auth/local";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_HERMES_GATEWAY_LABELS = [
  "ai.hermes.gateway-systems",
  "ai.hermes.gateway-strategist",
  "ai.hermes.gateway-youtube",
  "ai.hermes.gateway-content",
  "ai.hermes.gateway-marketing",
  "ai.hermes.gateway-dev",
  "ai.hermes.gateway-community",
  "ai.hermes.gateway-editor",
  "ai.hermes.gateway-legal",
];

function configuredLabels() {
  return (process.env.HERMES_GATEWAY_LABELS || "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .concat(process.env.HERMES_GATEWAY_LABELS ? [] : DEFAULT_HERMES_GATEWAY_LABELS);
}

function launchdDomain() {
  const uid = typeof process.getuid === "function" ? process.getuid() : Number(process.env.UID || 501);
  return `gui/${uid}`;
}

export async function POST() {
  const useLocalMode = isLocalAuthDisabled();
  const localUser = useLocalMode ? getLocalMissionControlUser() : null;
  const supabase = useLocalMode ? null : await createClient();
  const user = localUser || (await supabase!.auth.getUser()).data.user;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const labels = configuredLabels();
  const domain = launchdDomain();
  const results: Array<{ label: string; ok: boolean; output?: string; error?: string }> = [];

  for (const label of labels) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/launchctl",
        ["kickstart", "-k", `${domain}/${label}`],
        { timeout: 15000 }
      );
      results.push({ label, ok: true, output: (stdout + stderr).trim().slice(0, 500) });
    } catch (err) {
      results.push({ label, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const failed = results.filter((result) => !result.ok);
  return NextResponse.json({
    ok: failed.length === 0,
    runtime: "hermes",
    restarted: results.filter((result) => result.ok).length,
    failed: failed.length,
    results,
  }, { status: failed.length === 0 ? 200 : 500 });
}
