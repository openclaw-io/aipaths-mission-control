import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function loadCatalog(query = async () => ({ rows: [] })) {
  const path = resolve(repoRoot, "src/lib/youtube/playlists.ts");
  const source = readFileSync(path, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports, require(specifier) {
    if (specifier === "@/lib/db/postgres") return { query };
    if (specifier === "@/lib/db/mission-control") return { normalizeRows: (rows) => rows };
    throw new Error(`Unexpected import ${specifier}`);
  }, URL, console });
  return mod.exports;
}

const rows = [
  { playlist_id: "PL-agent", canonical_slug: "agentes-ia-negocios", title: "Agentes", aliases: ["openclaw"], status: "active" },
  { playlist_id: "PL-archive", canonical_slug: "ia-local", title: "IA local", aliases: ["llms", "openclaw"], status: "archived" },
];

test("query parsing validates filters and normalizes repeated/comma-separated values", () => {
  const { parsePlaylistQuery, PlaylistQueryError } = loadCatalog();
  const parsed = parsePlaylistQuery(new URL("https://mc.test/api?use_case=onboarding,tutorial&tag=agents&tag=business&status=active&include_videos=true").searchParams);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    useCases: ["onboarding", "tutorial"], tags: ["agents", "business"], status: "active", includeVideos: true, resolve: null,
  });
  assert.throws(() => parsePlaylistQuery(new URL("https://mc.test/api?status=deleted").searchParams), PlaylistQueryError);
  assert.throws(() => parsePlaylistQuery(new URL("https://mc.test/api?include_videos=maybe").searchParams), /include_videos/);
});

test("resolver uses exact ID, slug, or alias only and reports ambiguity instead of guessing", () => {
  const { resolvePlaylistReference } = loadCatalog();
  assert.equal(resolvePlaylistReference(rows, "PL-agent").playlist.playlist_id, "PL-agent");
  assert.equal(resolvePlaylistReference(rows, "AGENTES-IA-NEGOCIOS").playlist.playlist_id, "PL-agent");
  assert.equal(resolvePlaylistReference(rows, "llms").playlist.playlist_id, "PL-archive");
  assert.equal(resolvePlaylistReference(rows, "agent").state, "not_found", "partial/fuzzy references must never resolve");
  const ambiguous = resolvePlaylistReference(rows, "openclaw");
  assert.equal(ambiguous.state, "ambiguous");
  assert.deepEqual(Array.from(ambiguous.candidates), ["PL-agent", "PL-archive"]);
});

test("catalog read model applies array filters with parameters and deterministically nests memberships", async () => {
  const calls = [];
  const { listYouTubePlaylists } = loadCatalog(async (sql, params) => {
    calls.push({ sql, params });
    if (/from public\.youtube_playlists p/i.test(sql)) return { rows: [{ ...rows[0], featured: true, home_order: 3 }] };
    if (/from public\.youtube_playlist_videos/i.test(sql)) return { rows: [
      { playlist_id: "PL-agent", video_id: "v2", title: "Second", position: 2 },
      { playlist_id: "PL-agent", video_id: "v1", title: "First", position: 1 },
    ] };
    throw new Error(sql);
  });
  const result = await listYouTubePlaylists({ useCases: ["tutorial"], tags: ["agents"], status: "active", includeVideos: true, resolve: null });
  assert.deepEqual(Array.from(result[0].videos, (video) => video.video_id), ["v1", "v2"]);
  assert.match(calls[0].sql, /use_cases\s*@>\s*\$\d+::text\[\]/i);
  assert.match(calls[0].sql, /tags\s*@>\s*\$\d+::text\[\]/i);
  assert.match(calls[0].sql, /featured desc, p\.home_order asc nulls last, p\.canonical_slug asc/i);
  assert.deepEqual(Array.from(calls[0].params), ["active", ["tutorial"], ["agents"]]);
});
