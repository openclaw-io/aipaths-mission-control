import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(gatewayUrl, { signal: controller.signal });
    clearTimeout(timeout);

    // Gateway returns 503 when UI assets are missing but is still functional
    // Accept any non-error response (200, 503 with body) as "gateway is running"
    return NextResponse.json({
      gateway: res.status < 500 || res.status === 503 ? "healthy" : "down",
    });
  } catch {
    return NextResponse.json({
      gateway: "down",
    });
  }
}
