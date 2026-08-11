import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadRoute(processEnv) {
  const sourcePath = resolve(repoRoot, "src/app/api/runtime/services/route.ts");
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const mod = { exports: {} };
  let invocation;
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require(specifier) {
      if (specifier === "node:child_process") return { execFile() {} };
      if (specifier === "node:os") return { homedir: () => "/fallback-home" };
      if (specifier === "node:path") return { join: (...parts) => parts.join("/") };
      if (specifier === "node:util") return {
        promisify: () => async (...args) => {
          invocation = args;
          return { stdout: JSON.stringify({ services: [], summary: { total: 0 } }) };
        },
      };
      if (specifier === "next/server") return {
        NextResponse: { json: (body, init = {}) => ({ body, status: init.status || 200 }) },
      };
      if (specifier === "@/lib/agents-paths") return {
        directorRoot: () => "/agents/director-systems",
      };
      throw new Error(`Unexpected import ${specifier}`);
    },
    process: { env: processEnv, execPath: "/opt/homebrew/bin/node" },
    Date,
    JSON,
    Error,
    String,
    Object,
    Array,
    console,
  }, { filename: sourcePath });
  return { route: mod.exports, invocation: () => invocation };
}

test("runtime collector receives a minimal operational environment without Mission Control secrets or Node hooks", async () => {
  const { route, invocation } = loadRoute({
    HOME: "/Users/joaco",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    USER: "joaco",
    LOGNAME: "joaco",
    TMPDIR: "/private/tmp/runtime/",
    LANG: "en_GB.UTF-8",
    AIPATHS_AGENTS_DIR: "/Users/joaco/Documents/Repos/agents",
    AIPATHS_SERVICES_ROOT: "/Users/joaco/openclaw",
    NODE_OPTIONS: "--require=/tmp/keep-process-alive.cjs",
    MISSION_CONTROL_DATABASE_URL: "postgresql://secret",
    OPENAI_API_KEY: "secret",
    DISCORD_TASK_ROUTER_WEBHOOK: "secret",
  });

  const response = await route.GET();
  assert.equal(response.status, 200);

  const childEnv = invocation()[2].env;
  assert.deepEqual(JSON.parse(JSON.stringify(childEnv)), {
    HOME: "/Users/joaco",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    USER: "joaco",
    LOGNAME: "joaco",
    TMPDIR: "/private/tmp/runtime/",
    LANG: "en_GB.UTF-8",
    AIPATHS_AGENTS_DIR: "/Users/joaco/Documents/Repos/agents",
    AIPATHS_SERVICES_ROOT: "/Users/joaco/openclaw",
  });
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.MISSION_CONTROL_DATABASE_URL, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.DISCORD_TASK_ROUTER_WEBHOOK, undefined);
});
