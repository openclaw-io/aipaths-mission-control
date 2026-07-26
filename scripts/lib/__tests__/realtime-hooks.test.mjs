import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hookPaths = [
  "src/hooks/useRealtimeActivity.ts",
  "src/hooks/useRealtimeBlogs.ts",
  "src/hooks/useRealtimeCommunity.ts",
  "src/hooks/useRealtimeGuides.ts",
  "src/hooks/useRealtimeWorkItems.ts",
  "src/hooks/useRealtimeYouTube.ts",
];

function loadHook(relativePath, { realtimeEnabled, createClient }) {
  const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText;
  const effects = [];
  const react = {
    useEffect(effect, dependencies) {
      effects.push({ effect, dependencies });
    },
    useState(initialValue) {
      return [initialValue, () => {}];
    },
  };
  const moduleRecord = { exports: {} };
  const sandboxProcess = {
    env: {
      NEXT_PUBLIC_ENABLE_SUPABASE_REALTIME: realtimeEnabled ? "true" : undefined,
    },
  };
  const require = (specifier) => {
    if (specifier === "react") return react;
    if (specifier === "@/lib/supabase/client") return { createClient };
    throw new Error(`Unexpected runtime import from ${relativePath}: ${specifier}`);
  };

  const wrapper = vm.runInNewContext(
    `(function (require, module, exports, process) { ${output}\n })`,
    {},
    { filename: relativePath },
  );
  wrapper(require, moduleRecord, moduleRecord.exports, sandboxProcess);

  const hook = Object.values(moduleRecord.exports).find((value) => typeof value === "function");
  assert.equal(typeof hook, "function", `${relativePath} must export a hook`);
  hook([]);
  return effects;
}

for (const hookPath of hookPaths) {
  test(`${hookPath} does not initialize Supabase when Realtime is not opted in`, () => {
    let createCalls = 0;
    const effects = loadHook(hookPath, {
      realtimeEnabled: false,
      createClient() {
        createCalls += 1;
        throw new Error("Supabase must stay uninitialized");
      },
    });

    assert.equal(effects.length, 2);
    const cleanups = effects.map(({ effect }) => effect());
    assert.equal(createCalls, 0);
    assert.deepEqual(cleanups, [undefined, undefined]);
    assert.deepEqual(Array.from(effects[1].dependencies), []);
  });

  test(`${hookPath} initializes once and removes its channel when Realtime is opted in`, () => {
    let createCalls = 0;
    let subscribedChannel;
    let removedChannel;
    const channel = {
      on() {
        return channel;
      },
      subscribe() {
        subscribedChannel = channel;
        return channel;
      },
    };
    const client = {
      channel() {
        return channel;
      },
      removeChannel(value) {
        removedChannel = value;
      },
    };
    const effects = loadHook(hookPath, {
      realtimeEnabled: true,
      createClient() {
        createCalls += 1;
        return client;
      },
    });

    const cleanups = effects.map(({ effect }) => effect());
    assert.equal(createCalls, 1);
    assert.equal(subscribedChannel, channel);
    assert.equal(typeof cleanups[1], "function");
    cleanups[1]();
    assert.equal(removedChannel, channel);
    assert.deepEqual(Array.from(effects[1].dependencies), []);
  });
}
