import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

async function checkGateway(): Promise<"healthy" | "down"> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(gatewayUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok ? "healthy" : "down";
  } catch {
    return "down";
  }
}

async function checkDispatch(): Promise<"healthy" | "down"> {
  try {
    const { stdout } = await execAsync("launchctl list ai.openclaw.dispatch 2>&1", { timeout: 3000 });
    // Dispatch runs every 10 min (not always-on). Check last exit status = 0
    const exitMatch = stdout.match(/"LastExitStatus"\s*=\s*(\d+)/);
    if (exitMatch) {
      return exitMatch[1] === "0" ? "healthy" : "down";
    }
    // If loaded in launchctl at all, it's configured
    return stdout.includes('"Label"') ? "healthy" : "down";
  } catch {
    return "down";
  }
}

export async function GET() {
  const [gateway, dispatch] = await Promise.all([checkGateway(), checkDispatch()]);

  return NextResponse.json({
    gateway,
    dispatch,
    overall: gateway === "healthy" && dispatch === "healthy" ? "healthy" : "degraded",
  });
}
