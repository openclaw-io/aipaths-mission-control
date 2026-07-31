import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function loadRoute({ list }) {
  const path = resolve(repoRoot, "src/app/api/agent/youtube/playlists/route.ts");
  const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  const json = (payload, init = {}) => ({ payload, status: init.status || 200 });
  vm.runInNewContext(output, { module: mod, exports: mod.exports, require(specifier) {
    if (specifier === "next/server") return { NextResponse: { json } };
    if (specifier === "@/lib/youtube/playlists") return {
      PlaylistQueryError: class PlaylistQueryError extends Error {},
      parsePlaylistQuery: (params) => ({ status: params.get("status") || "active", useCases: [], tags: [], includeVideos: params.get("include_videos") === "true", resolve: params.get("resolve") }),
      listYouTubePlaylists: list,
      resolvePlaylistReference: (rows, reference) => rows.find((row) => row.canonical_slug === reference)
        ? { state: "resolved", playlist: rows.find((row) => row.canonical_slug === reference) }
        : { state: "not_found", candidates: [] },
    };
    throw new Error(`Unexpected import ${specifier}`);
  }, process: { env: { AGENT_API_KEY: "test-agent-key" } }, console });
  return mod.exports;
}
function request(url, token) {
  return { headers: { get: (name) => name === "authorization" ? token : null }, nextUrl: new URL(url) };
}

test("agent playlist API fails closed without configured Bearer authentication", async () => {
  let calls = 0;
  const { GET } = loadRoute({ list: async () => { calls += 1; return []; } });
  assert.equal((await GET(request("https://mc.test/api/agent/youtube/playlists", null))).status, 401);
  assert.equal((await GET(request("https://mc.test/api/agent/youtube/playlists", "test-agent-key"))).status, 401);
  assert.equal(calls, 0);
});

test("agent playlist API returns filtered catalog and deterministic exact resolution", async () => {
  const playlist = { playlist_id: "PL-1", canonical_slug: "tutoriales", videos: [{ video_id: "v1" }] };
  let received;
  const { GET } = loadRoute({ list: async (filters) => { received = filters; return [playlist]; } });
  const response = await GET(request("https://mc.test/api/agent/youtube/playlists?status=active&include_videos=true", "Bearer test-agent-key"));
  assert.equal(response.status, 200);
  assert.equal(response.payload.count, 1);
  assert.equal(response.payload.playlists[0].videos[0].video_id, "v1");
  assert.equal(received.includeVideos, true);

  const resolved = await GET(request("https://mc.test/api/agent/youtube/playlists?resolve=tutoriales", "Bearer test-agent-key"));
  assert.equal(resolved.payload.resolution, "resolved");
  assert.equal(resolved.payload.playlist.playlist_id, "PL-1");
  const missing = await GET(request("https://mc.test/api/agent/youtube/playlists?resolve=tutorial", "Bearer test-agent-key"));
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.resolution, "not_found");
});
