import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(gatewayUrl, { signal: controller.signal });
    clearTimeout(timeout);

    return NextResponse.json({
      status: res.ok ? "healthy" : "unhealthy",
      code: res.status,
    });
  } catch {
    return NextResponse.json({
      status: "down",
      code: 0,
    });
  }
}
