import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

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
];

function configuredLabels() {
  return (process.env.HERMES_GATEWAY_LABELS || "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .concat(process.env.HERMES_GATEWAY_LABELS ? [] : DEFAULT_HERMES_GATEWAY_LABELS);
}

type LaunchctlRow = {
  pid: string;
  status: string;
  label: string;
};

function parseLaunchctlList(output: string) {
  const rows = new Map<string, LaunchctlRow>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, status, label] = match;
    rows.set(label, { pid, status, label });
  }
  return rows;
}

export async function GET() {
  const labels = configuredLabels();

  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["list"], { timeout: 5000 });
    const rows = parseLaunchctlList(stdout);
    const services = labels.map((label) => {
      const row = rows.get(label);
      return {
        label,
        pid: row?.pid || null,
        running: !!row && row.pid !== "-",
        lastExitStatus: row?.status ?? null,
      };
    });
    const down = services.filter((service) => !service.running).map((service) => service.label);

    return NextResponse.json({
      gateway: down.length === 0 ? "healthy" : "down",
      runtime: "hermes",
      healthy: down.length === 0,
      total: services.length,
      running: services.length - down.length,
      down,
      services,
    });
  } catch (err) {
    return NextResponse.json({
      gateway: "down",
      runtime: "hermes",
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
