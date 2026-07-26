import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_COLLECTOR_PATH = "/Users/joaco/openclaw/director-systems/scripts/collect-runtime-status.mjs";
const CACHE_TTL_MS = 15_000;

type CacheEntry = {
  createdAt: number;
  body: unknown;
};

let cache: CacheEntry | null = null;

async function collectRuntimeStatus() {
  const collectorPath = process.env.AIPATHS_RUNTIME_COLLECTOR_PATH || DEFAULT_COLLECTOR_PATH;
  const { stdout } = await execFileAsync(process.execPath, [collectorPath], {
    timeout: 12_000,
    maxBuffer: 1024 * 1024 * 2,
    env: {
      ...process.env,
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME || "/Users/joaco",
    },
  });
  return JSON.parse(stdout);
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.createdAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.body, {
      headers: { "Cache-Control": "no-store", "X-Runtime-Cache": "hit" },
    });
  }

  try {
    const body = await collectRuntimeStatus();
    cache = { createdAt: now, body };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store", "X-Runtime-Cache": "miss" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        generated_at: new Date().toISOString(),
        summary: {
          total: 0,
          running: 0,
          unhealthy: 1,
          stopped: 0,
          planned: 0,
          external: 0,
          warnings: 1,
          public_exposure: 0,
          unregistered_listeners: 0,
        },
        services: [],
        tailscale: { serve: [], funnel_public: false },
        unregistered_listeners: [],
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
