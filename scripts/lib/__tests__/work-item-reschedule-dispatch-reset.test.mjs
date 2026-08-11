import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const routePath = resolve(repoRoot, "src/app/api/work-items/[id]/reschedule/route.ts");

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
      throw new Error(`Unexpected import ${specifier}`);
    },
    Date, JSON, Object, Array, String, Number, Error,
    ...globals,
  }, { filename: sourcePath });
  return cjs.exports;
}

function acceptedDispatch(generation, attempt) {
  return {
    publish_blog_dispatch: {
      version: "publish_blog_dispatch_v1",
      generation,
      attempt,
      idempotency_key: `publish-blog:work-175:attempt-${attempt}`,
      outcome: "accepted",
      leased_at: "2026-08-11T14:56:00.000Z",
      expires_at: "2026-08-11T14:57:00.000Z",
      outcome_at: "2026-08-11T14:56:01.000Z",
      retry_not_before: null,
      error: null,
    },
    generic_notify_lease: {
      version: "generic_notify_lease_v1",
      key: `publish-blog:work-175:attempt-${attempt}`,
      outcome: "accepted",
      leased_at: "2026-08-11T14:56:00.000Z",
      expires_at: "2026-08-11T14:57:00.000Z",
      outcome_at: "2026-08-11T14:56:01.000Z",
      mode: "hermes_cli_spawn",
      session_key: "accepted-session",
      error: null,
    },
  };
}

function initialRow() {
  return {
    id: "work-175",
    title: "Publish approved blog",
    status: "ready",
    owner_agent: "dev",
    target_agent_id: "dev",
    source_type: "service",
    source_id: "blog-175",
    scheduled_for: "2026-08-11T15:00:00.000Z",
    payload: {
      action: "publish_blog",
      pipeline_type: "blog",
      dedupe_key: "blog-175:publish_blog",
      preserved_business_field: { nested: true },
      ...acceptedDispatch("blog-175:publish_blog@2026-08-11T15:00:00.000Z", 7),
    },
  };
}

function createLocalHarness() {
  let row = initialRow();
  const route = transpile(routePath, {
    "next/server": { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } },
    "@/lib/supabase/admin": { supabaseAdmin: {} },
    "@/lib/auth/local": { isLocalAuthDisabled: () => true },
    "@/lib/db/mission-control": { normalizeRow: (value) => value },
    "@/lib/db/postgres": {
      withTransaction: async (run) => run({
        query: async (sql, params = []) => {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (normalized.includes("from public.work_items") && normalized.includes("for update")) {
            return { rows: [structuredClone(row)] };
          }
          if (normalized.startsWith("update public.work_items")) {
            row.scheduled_for = params[0];
            row.payload = JSON.parse(params[2]);
            return { rows: [structuredClone(row)] };
          }
          if (normalized.startsWith("update public.pipeline_items") || normalized.startsWith("insert into public.event_log")) {
            return { rows: [] };
          }
          throw new Error(`Unexpected local query: ${normalized}`);
        },
      }),
    },
  }, { structuredClone });
  return {
    route,
    getRow: () => structuredClone(row),
    seedAccepted: (generation, attempt) => { row.payload = { ...row.payload, ...acceptedDispatch(generation, attempt) }; },
  };
}

function createSupabaseHarness() {
  let row = initialRow();
  const supabaseAdmin = {
    from(table) {
      if (table === "work_items") {
        return {
          select() {
            return { eq: () => ({ single: async () => ({ data: structuredClone(row), error: null }) }) };
          },
          update(patch) {
            return {
              eq() {
                row = { ...row, ...structuredClone(patch) };
                return {
                  select: () => ({ single: async () => ({ data: structuredClone(row), error: null }) }),
                };
              },
            };
          },
        };
      }
      if (table === "event_log") return { insert: async () => ({ error: null }) };
      if (table === "pipeline_items") return { update: () => ({ eq: async () => ({ error: null }) }) };
      throw new Error(`Unexpected Supabase table: ${table}`);
    },
  };
  const route = transpile(routePath, {
    "next/server": { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } },
    "@/lib/supabase/admin": { supabaseAdmin },
    "@/lib/auth/local": { isLocalAuthDisabled: () => false },
    "@/lib/db/mission-control": { normalizeRow: (value) => value },
    "@/lib/db/postgres": { withTransaction: async () => { throw new Error("local transaction must not run"); } },
  }, { structuredClone });
  return {
    route,
    getRow: () => structuredClone(row),
    seedAccepted: (generation, attempt) => { row.payload = { ...row.payload, ...acceptedDispatch(generation, attempt) }; },
  };
}

async function reschedule(harness, scheduledFor) {
  return harness.route.POST(
    { json: async () => ({ scheduled_for: scheduledFor, reason: "P1 regression" }) },
    { params: Promise.resolve({ id: "work-175" }) },
  );
}

for (const [mode, createHarness] of [["local", createLocalHarness], ["Supabase", createSupabaseHarness]]) {
  test(`${mode} reschedule resets publish and notify claims/retries across A→B→A`, async () => {
    const harness = createHarness();
    const a = "2026-08-11T15:00:00.000Z";
    const b = "2026-08-12T15:00:00.000Z";

    const toB = await reschedule(harness, b);
    assert.equal(toB.status, 200);
    assert.equal(harness.getRow().scheduled_for, b);
    assert.equal(harness.getRow().payload.publish_blog_dispatch, undefined);
    assert.equal(harness.getRow().payload.generic_notify_lease, undefined);
    assert.equal(harness.getRow().payload.previous_scheduled_for, a);
    assert.equal(harness.getRow().payload.preserved_business_field.nested, true);

    harness.seedAccepted("blog-175:publish_blog@2026-08-12T15:00:00.000Z", 3);
    const backToA = await reschedule(harness, a);
    assert.equal(backToA.status, 200);
    assert.equal(harness.getRow().scheduled_for, a);
    assert.equal(harness.getRow().payload.publish_blog_dispatch, undefined);
    assert.equal(harness.getRow().payload.generic_notify_lease, undefined);
    assert.equal(harness.getRow().payload.previous_scheduled_for, b);
    assert.equal(harness.getRow().payload.preserved_business_field.nested, true);
  });
}
