import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadAgentsPaths() {
  const sourcePath = resolve(repoRoot, "src/lib/agents-paths.ts");
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const mod = { exports: {} };

  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require(specifier) {
      if (specifier === "node:fs") return { existsSync: (candidate) => candidate === "/workspace/director-content" };
      if (specifier === "node:path") return path;
      throw new Error(`Unexpected import ${specifier}`);
    },
    process: {
      cwd: () => "/workspace/repos/aipaths-mission-control-live",
      env: { AIPATHS_AGENTS_DIR: "/workspace/agents" },
    },
    Error,
    String,
    Object,
    Array,
  }, { filename: sourcePath });

  return mod.exports;
}

function loadRoute() {
  const sourcePath = resolve(repoRoot, "src/app/api/blogs/[id]/hero-image/route.ts");
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;

  const mod = { exports: {} };
  let observedRoots;

  class FakeNextResponse {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status || 200;
      this.headers = init.headers || {};
    }

    static json(body, init = {}) {
      return new FakeNextResponse(body, init);
    }
  }

  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require(specifier) {
      if (specifier === "node:os") return { homedir: () => "/Users/test" };
      if (specifier === "node:path") return path;
      if (specifier === "next/server") return { NextResponse: FakeNextResponse };
      if (specifier === "@/lib/blogs/hero-image-roots") return {
        allowedBlogHeroImageRoots: () => [
          "/Users/test/.openclaw/media",
          "/workspace/agents/director-content/work/localizations",
          "/workspace-legacy/director-content/work/localizations",
        ],
      };
      if (specifier === "@/lib/agents-paths") return {
        directorRoot: () => "/workspace/agents/director-content",
        legacyDirectorRoot: () => "/workspace-legacy/director-content",
      };
      if (specifier === "@/lib/supabase/admin") return {
        createServiceClient: () => { throw new Error("unexpected cloud client"); },
      };
      if (specifier === "@/lib/auth/local") return { isLocalAuthDisabled: () => true };
      if (specifier === "@/lib/db/pipeline-local") return {
        getPipelineItemLocal: async () => ({
          metadata: { hero_image: { media_path: "/workspace-legacy/director-content/work/localizations/blog/hero.png" } },
        }),
      };
      if (specifier === "./local-image") return {
        LocalImageError: class LocalImageError extends Error {},
        readLocalImageFile: async (_candidate, roots) => {
          observedRoots = roots;
          return { data: Buffer.from("image"), size: 5, contentType: "image/png" };
        },
      };
      throw new Error(`Unexpected import ${specifier}`);
    },
    Buffer,
    Promise,
    Error,
    String,
    Object,
    Array,
    console,
  }, { filename: sourcePath });

  return { route: mod.exports, observedRoots: () => observedRoots };
}

test("hero image allowlist preserves the surviving legacy content root after agents move", async () => {
  const { route, observedRoots } = loadRoute();
  const response = await route.GET({}, { params: Promise.resolve({ id: "blog-id" }) });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(observedRoots())), [
    "/Users/test/.openclaw/media",
    "/workspace/agents/director-content/work/localizations",
    "/workspace-legacy/director-content/work/localizations",
  ]);
});

test("legacy director root is derived from the service layout and only returned when it exists", () => {
  const agentsPaths = loadAgentsPaths();

  assert.equal(agentsPaths.directorRoot("content"), "/workspace/agents/director-content");
  assert.equal(agentsPaths.legacyDirectorRoot("content"), "/workspace/director-content");
  assert.equal(agentsPaths.legacyDirectorRoot("missing"), null);
});
