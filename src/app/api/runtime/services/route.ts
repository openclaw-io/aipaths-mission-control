import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

import { directorRoot } from "@/lib/agents-paths";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_TTL_MS = 15_000;

// El collector vive en director-systems, que se muda en GON-71. Mission Control vive en
// repos/, que no. La ruta se declara o se deriva; si no se puede, se falla con la receta
// puesta en vez de ejecutar una ruta muerta y devolver un error que no se parece a la causa.
function resolveCollectorPath(): string {
  const declared = process.env.AIPATHS_RUNTIME_COLLECTOR_PATH?.trim();
  if (declared) return declared;
  const systems = directorRoot("systems");
  if (!systems) {
    throw new Error(
      "No se pudo resolver collect-runtime-status.mjs. Declará AIPATHS_AGENTS_DIR " +
        "(o AIPATHS_RUNTIME_COLLECTOR_PATH) en ~/.config/aipaths/mission-control.env " +
        "y reiniciá com.aipaths.mission-control.",
    );
  }
  return path.join(systems, "scripts", "collect-runtime-status.mjs");
}

type CacheEntry = {
  createdAt: number;
  body: unknown;
};

let cache: CacheEntry | null = null;

async function collectRuntimeStatus() {
  const collectorPath = resolveCollectorPath();
  const { stdout } = await execFileAsync(process.execPath, [collectorPath], {
    timeout: 12_000,
    maxBuffer: 1024 * 1024 * 2,
    env: {
      ...process.env,
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME || homedir(),
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
