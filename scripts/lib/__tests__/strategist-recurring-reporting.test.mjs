import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function transpileModule(sourcePath, requires = {}) {
  const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      if (specifier in requires) return requires[specifier];
      throw new Error(`Unexpected require from ${sourcePath}: ${specifier}`);
    },
    Date,
    Intl,
    Number,
    Set,
    Map,
    JSON,
    String,
    RegExp,
    Object,
    Array,
    Math,
    Promise,
    Error,
    console,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const recurring = transpileModule(resolve(repoRoot, "src/lib/work-items/recurring.ts"), {
  "@/lib/db/postgres": {
    query: async () => {
      throw new Error("unexpected database query");
    },
    withTransaction: async () => {
      throw new Error("unexpected transaction");
    },
  },
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function strategistRule(overrides = {}) {
  return {
    id: "e9fa4aa5-7c88-4241-a4e2-d08b8164f460",
    title: "Strategist reporting review",
    instruction: "seed",
    owner_agent: "strategist",
    target_agent_id: "strategist",
    requested_by: "systems",
    priority: "medium",
    cadence_unit: "days",
    cadence_interval: 1,
    time_of_day: "07:00",
    timezone: "Europe/London",
    start_date: "2026-08-01",
    end_date: null,
    horizon_days: 7,
    enabled: true,
    metadata: {
      mode: "cadence_router",
      category: "strategist_reporting",
      monthly_day: 1,
      weekly_weekday: 1,
    },
    last_materialized_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: null,
    ...overrides,
  };
}

test("strategist cadence router keeps monthly day 1, weekly Monday, daily otherwise", () => {
  const occurrences = recurring.plannedOccurrences(
    strategistRule({ horizon_days: 4 }),
    new Date("2026-07-31T00:00:00.000Z"),
  );

  assert.equal(occurrences[0].payload.report_type, "monthly_review");
  assert.equal(occurrences[0].payload.month, "2026-07");
  assert.equal(occurrences[0].title, "Monthly review — 2026-07");

  assert.equal(occurrences[1].payload.report_type, "daily_review");
  assert.equal(occurrences[1].title, "Daily review — 2026-08-02");

  assert.equal(occurrences[2].payload.report_type, "weekly_review");
  assert.equal(occurrences[2].payload.week_start, "2026-07-27");
  assert.equal(occurrences[2].payload.week_end, "2026-08-02");
  assert.equal(occurrences[2].title, "Weekly review — 2026-08-03");

  assert.equal(occurrences[3].payload.report_type, "daily_review");
  assert.equal(occurrences[3].title, "Daily review — 2026-08-04");
});

test("strategist report work items use only the live-class reporting contract", () => {
  const [occurrence] = recurring.plannedOccurrences(strategistRule({ horizon_days: 1 }), new Date("2026-07-31T00:00:00.000Z"));

  assert.equal(occurrence.payload.contract_version, "live_class_reporting_v1_2026_08_04");
  assert.deepEqual(plain(occurrence.payload.report_sections), [
    "edition_live_registrations",
    "top_3_acquisition_channels_by_signups",
    "global_funnel_views_clicks_signups_ventas",
    "community_new_members",
  ]);
  assert.deepEqual(plain(occurrence.payload.source_tables), [
    "academy.live_events",
    "academy.events",
    "academy.live_registrations",
    "academy.orders",
    "mission_control.ops_community_member_daily",
  ]);
  assert.equal(occurrence.payload.canonical_fields.views.event_type, "live_landing_view");
  assert.equal(occurrence.payload.canonical_fields.cta_clicks.event_type, "live_registration_started");
  assert.equal(
    occurrence.payload.canonical_fields.community_new_members.table,
    "mission_control.ops_community_member_daily",
  );
  assert.equal(occurrence.payload.canonical_fields.community_new_members.metric, "sum(new_human_members)");
  assert.equal(occurrence.payload.acquisition_attribution.primary, "academy.live_registrations.first_ref normalized with derive_attribution_source");
  assert.equal(occurrence.payload.missing_coverage_policy.value, "N/D");

  assert.match(occurrence.instruction, /live-class reporting contract/i);
  assert.match(occurrence.instruction, /Views -> Clicks -> Signups -> Ventas/);
  assert.match(occurrence.instruction, /first_ref normalized/i);
  assert.match(occurrence.instruction, /Use N\/D when source coverage or tracking is missing/i);
  assert.doesNotMatch(occurrence.instruction, /diagnostic-first|Diagnostico|academy_json\.diagnostic|ops_youtube|intel_items_raw|intel_trend_daily/i);
});

test("dry run exposes daily weekly and monthly contract read-back fields", () => {
  const dryRun = recurring.plannedOccurrenceDryRun(strategistRule({ horizon_days: 4 }), new Date("2026-07-31T00:00:00.000Z"));

  assert.deepEqual(plain(dryRun.map((entry) => entry.reportType)), [
    "monthly_review",
    "daily_review",
    "weekly_review",
    "daily_review",
  ]);

  for (const entry of dryRun) {
    assert.equal(entry.contract_version, "live_class_reporting_v1_2026_08_04");
    assert.equal(entry.contract_decision_date, "2026-08-04");
    assert.match(entry.contract_path, /live-class-reporting-contract-2026-08-04\.md$/);
    assert.deepEqual(plain(entry.report_sections), [
      "edition_live_registrations",
      "top_3_acquisition_channels_by_signups",
      "global_funnel_views_clicks_signups_ventas",
      "community_new_members",
    ]);
    assert.equal(entry.canonical_fields.views.event_type, "live_landing_view");
    assert.equal(entry.missing_coverage_policy.value, "N/D");
    assert.doesNotMatch(entry.instruction, /diagnostic-first|Diagnostico|academy_json\.diagnostic|ops_youtube/i);
  }
});

test("materialized strategist payload strips stale diagnostic metadata from existing rule rows", () => {
  const rule = strategistRule({
    horizon_days: 1,
    metadata: {
      mode: "cadence_router",
      category: "strategist_reporting",
      monthly_day: 1,
      weekly_weekday: 1,
      channel_reports: "1474386202835685457",
      channel_agent_log: "1473660854800224316",
      daily_primary_field: "ops_daily_snapshots.academy_json.diagnostic",
      excluded_routine_sources: ["intel_items_raw", "intel_trend_daily"],
      diagnostic_reporting_mode: "from_cutoff_when_window_overlaps",
      reporting_contract_version: "diagnostic_first_v0",
      diagnostic_tracking_cutoff_at: "2026-06-18T12:14:00Z",
    },
  });
  const [occurrence] = recurring.plannedOccurrences(rule, new Date("2026-07-31T00:00:00.000Z"));
  const payload = recurring.buildRecurringWorkPayload(rule, occurrence);

  assert.equal(payload.contract_version, "live_class_reporting_v1_2026_08_04");
  assert.equal(payload.channel_reports, "1474386202835685457");
  assert.equal(payload.reporting_contract_version, undefined);
  assert.equal(payload.daily_primary_field, undefined);
  assert.equal(payload.diagnostic_reporting_mode, undefined);
  assert.equal(payload.diagnostic_tracking_cutoff_at, undefined);
  assert.equal(payload.excluded_routine_sources, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /diagnostic_first_v0|academy_json\.diagnostic|intel_items_raw|intel_trend_daily/);
});
