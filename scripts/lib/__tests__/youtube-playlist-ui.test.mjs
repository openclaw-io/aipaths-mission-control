import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jsxRuntime = await import("react/jsx-runtime");
function loadComponent() {
  const path = resolve(repoRoot, "src/components/youtube/YouTubePlaylistCatalog.tsx");
  const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports, require(specifier) {
    if (specifier === "react/jsx-runtime") return jsxRuntime;
    throw new Error(`Unexpected import ${specifier}`);
  }, console });
  return mod.exports.YouTubePlaylistCatalog;
}

test("read-only playlist UI renders purpose, use cases, canonical URL, and ordered memberships", () => {
  const Catalog = loadComponent();
  const html = renderToStaticMarkup(React.createElement(Catalog, { playlists: [{
    playlist_id: "PL-1", canonical_slug: "start-here", title: "Empezá Acá", description: "Canonical description",
    url: "https://www.youtube.com/playlist?list=PL-1", kind: "hub", purpose: "Guide a new viewer",
    audience: "Business owners", status: "active", featured: true, home_order: 1, aliases: ["Old"],
    use_cases: ["onboarding", "business-system"], tags: ["ai"], videos: [
      { video_id: "v1", title: "First membership", position: 1, membership_reason: "observed_in_source_snapshot", membership_role: "existing_membership" },
    ],
  }] }));
  assert.match(html, /YouTube Playlist Catalog/);
  assert.match(html, /Guide a new viewer/);
  assert.match(html, /onboarding/);
  assert.match(html, /https:\/\/www\.youtube\.com\/playlist\?list=PL-1/);
  assert.match(html, /1\. First membership/);
  assert.doesNotMatch(html, /<input|<textarea|contenteditable/i, "initial catalog UI must be read-only");
});

test("navigation and page expose /youtube/playlists", () => {
  const sidebar = readFileSync(resolve(repoRoot, "src/components/Sidebar.tsx"), "utf8");
  const page = readFileSync(resolve(repoRoot, "src/app/youtube/playlists/page.tsx"), "utf8");
  assert.match(sidebar, /\/youtube\/playlists/);
  assert.match(page, /YouTubePlaylistCatalog/);
});
