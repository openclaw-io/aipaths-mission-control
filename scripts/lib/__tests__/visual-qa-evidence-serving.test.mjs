import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
const jsonLog = Buffer.from(JSON.stringify({ entries: [{ level: "info", message: "loaded" }] }));
const invalidUtf8Log = Buffer.from([0xc3, 0x28]);

class TestNextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.headers = init.headers || {};
  }
  static json(payload, init = {}) {
    return { payload, status: init.status || 200, headers: init.headers || {} };
  }
}

function transpile(sourcePath, requires = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(output, {
    module: cjs,
    exports: cjs.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected import ${specifier} from ${sourcePath}`);
    },
    Buffer, Date, JSON, Object, Array, Set, Map, String, Number, RegExp, Promise, Error, console,
    process, URL, ...globals,
  }, { filename: sourcePath });
  return cjs.exports;
}

const qaPolicy = transpile(resolve(repoRoot, "src/lib/loops/qa-policy.ts"));
const qaResult = transpile(resolve(repoRoot, "src/lib/qa/result.ts"), {
  "node:crypto": await import("node:crypto"), "@/lib/loops/qa-policy": qaPolicy,
});
const qaEvidence = transpile(resolve(repoRoot, "src/lib/qa/evidence.ts"), {
  "node:crypto": await import("node:crypto"), "node:fs": await import("node:fs"),
  "node:fs/promises": await import("node:fs/promises"), "node:path": await import("node:path"),
  "@/lib/qa/result": qaResult,
});

function request(token = "evidence-key") {
  return { headers: { get: (name) => name === "authorization" ? `Bearer ${token}` : null } };
}

function descriptor(storageRef, body, mediaType) {
  return {
    kind: mediaType === "application/json" ? "log" : "screenshot",
    storage_ref: storageRef,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    media_type: mediaType,
    viewport: "desktop",
    flow: "Open Loop detail",
  };
}

function ownershipRow(item, authoritativeDescriptor = item) {
  const taskId = randomUUID();
  const qaRunId = randomUUID();
  return {
    id: randomUUID(),
    task_id: taskId,
    task_run_id: qaRunId,
    kind: `visual_qa_${item.kind}`,
    uri: `visual-qa://${item.storage_ref}`,
    content: null,
    authoritative_descriptor: authoritativeDescriptor,
    metadata: {
      schema_version: 1,
      qa_execution_id: randomUUID(),
      task_id: taskId,
      qa_run_id: qaRunId,
      work_item_id: randomUUID(),
      execution_attempt_id: randomUUID(),
      policy_hash: "b".repeat(64),
      result_hash: "c".repeat(64),
      tested_sha: "a".repeat(40),
      descriptor: item,
    },
  };
}

test("authenticated local QA evidence route serves only DB-owned safe image refs under artifact root", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-serve-"));
  const previous = {
    AGENT_API_KEY: process.env.AGENT_API_KEY,
    HERMES_VISUAL_QA_ARTIFACT_ROOT: process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT,
  };
  process.env.AGENT_API_KEY = "evidence-key";
  process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT = root;
  try {
    await mkdir(resolve(root, "qa", "exec"), { recursive: true });
    await writeFile(resolve(root, "qa", "exec", "desktop.png"), png);
    await writeFile(resolve(root, "qa", "exec", "desktop.jpg"), jpeg);
    await writeFile(resolve(root, "qa", "exec", "browser-log.json"), jsonLog);
    await writeFile(resolve(root, "qa", "exec", "invalid-log.json"), Buffer.from("{not-json}"));
    await writeFile(resolve(root, "qa", "exec", "invalid-utf8-log.json"), invalidUtf8Log);
    await writeFile(resolve(root, "qa", "exec", "not-image.txt"), "plain text");
    let rows = [];
    const queries = [];
    const route = transpile(resolve(repoRoot, "src/app/api/qa/evidence/[...ref]/route.ts"), {
      "next/server": { NextResponse: TestNextResponse },
      "node:crypto": await import("node:crypto"),
      "node:fs/promises": await import("node:fs/promises"),
      "node:path": await import("node:path"),
      "@/lib/qa/evidence": qaEvidence,
      "@/lib/db/postgres": {
        query: async (sql, params) => {
          queries.push({ sql, params });
          assert.match(sql, /from\s+public\.loop_evidence/i);
          assert.match(sql, /join\s+public\.qa_executions/i);
          assert.match(sql, /jsonb_array_elements\(execution\.result->'evidence'\)/i);
          assert.match(sql, /execution\.result_hash\s*=\s*public\.qa_jsonb_sha256\(execution\.result\)/i);
          assert.match(sql, /evidence\.task_id\s*=\s*execution\.task_id/i);
          assert.match(sql, /evidence\.task_run_id\s*=\s*execution\.qa_run_id/i);
          assert.equal(params.length, 1);
          assert.equal(params[0], `visual-qa://${params[0].slice("visual-qa://".length)}`);
          return { rows };
        },
      },
    });

    rows = [ownershipRow(descriptor("qa/exec/desktop.png", png, "image/png"))];
    let response = await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "desktop.png"] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, png);
    assert.equal(response.headers["Content-Type"], "image/png");
    assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.equal(queries.at(-1).params[0], "visual-qa://qa/exec/desktop.png");

    rows = [ownershipRow(descriptor("qa/exec/desktop.jpg", jpeg, "image/jpeg"))];
    response = await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "desktop.jpg"] }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "image/jpeg");

    rows = [ownershipRow(descriptor("qa/exec/browser-log.json", jsonLog, "application/json"))];
    response = await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "browser-log.json"] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, jsonLog);
    assert.equal(response.headers["Content-Type"], "application/json");
    assert.equal(response.headers["Content-Length"], String(jsonLog.length));
    assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(response.headers["Content-Disposition"], 'attachment; filename="visual-qa-log.json"');

    const invalidLog = Buffer.from("{not-json}");
    rows = [ownershipRow(descriptor("qa/exec/invalid-log.json", invalidLog, "application/json"))];
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "invalid-log.json"] }) })).status, 404);
    rows = [ownershipRow(descriptor("qa/exec/invalid-utf8-log.json", invalidUtf8Log, "application/json"))];
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "invalid-utf8-log.json"] }) })).status, 404);

    assert.equal((await route.GET(request("wrong"), { params: Promise.resolve({ ref: ["qa", "exec", "desktop.png"] }) })).status, 401);
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["..", "secret.png"] }) })).status, 400);
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["qa", ".", "exec", "desktop.png"] }) })).status, 400);
    rows = [ownershipRow(descriptor("qa/exec/not-image.txt", Buffer.from("plain text"), "text/plain"))];
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "not-image.txt"] }) })).status, 415);

    await symlink(resolve(tmpdir()), resolve(root, "qa", "exec", "escape.png"));
    rows = [ownershipRow(descriptor("qa/exec/escape.png", png, "image/png"))];
    assert.equal((await route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "escape.png"] }) })).status, 400);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("QA evidence route fails closed on missing, duplicate, malformed, or byte-mismatched ownership", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mc-visual-qa-owned-"));
  const previous = {
    AGENT_API_KEY: process.env.AGENT_API_KEY,
    HERMES_VISUAL_QA_ARTIFACT_ROOT: process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT,
  };
  process.env.AGENT_API_KEY = "evidence-key";
  process.env.HERMES_VISUAL_QA_ARTIFACT_ROOT = root;
  try {
    const storageRef = "qa/exec/desktop.png";
    await mkdir(resolve(root, "qa", "exec"), { recursive: true });
    await writeFile(resolve(root, storageRef), png);
    const good = descriptor(storageRef, png, "image/png");
    let rows = [];
    const route = transpile(resolve(repoRoot, "src/app/api/qa/evidence/[...ref]/route.ts"), {
      "next/server": { NextResponse: TestNextResponse },
      "node:crypto": await import("node:crypto"),
      "node:fs/promises": await import("node:fs/promises"),
      "node:path": await import("node:path"),
      "@/lib/qa/evidence": qaEvidence,
      "@/lib/db/postgres": { query: async (sql, params) => {
        assert.match(sql, /\$1/);
        assert.equal(params.length, 1);
        assert.equal(params[0], `visual-qa://${storageRef}`);
        return { rows };
      } },
    });
    const invoke = async () => route.GET(request(), { params: Promise.resolve({ ref: ["qa", "exec", "desktop.png"] }) });
    rows = [];
    assert.equal((await invoke()).status, 404);
    rows = [ownershipRow(good), ownershipRow(good)];
    assert.equal((await invoke()).status, 404);
    rows = [{ ...ownershipRow(good), metadata: { descriptor: { ...good, storage_ref: "qa/exec/other.png" } } }];
    assert.equal((await invoke()).status, 404);
    rows = [ownershipRow(good, { ...good, sha256: "0".repeat(64) })];
    assert.equal((await invoke()).status, 404);
    rows = [ownershipRow({ ...good, sha256: "0".repeat(64) })];
    assert.equal((await invoke()).status, 404);
    rows = [ownershipRow({ ...good, bytes: good.bytes + 1 })];
    assert.equal((await invoke()).status, 404);
    rows = [ownershipRow({ ...good, media_type: "image/jpeg" })];
    assert.equal((await invoke()).status, 404);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
