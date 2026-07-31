import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

function loadYoutubePipeline() {
  const path = resolve(repoRoot, "src/lib/youtube-pipeline.ts");
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const cjsModule = { exports: {} };
  vm.runInNewContext(output, {
    module: cjsModule,
    exports: cjsModule.exports,
    require() { throw new Error("Unexpected require"); },
    Set, Number, Math, Object, Array, String,
  }, { filename: path });
  return cjsModule.exports;
}

test("YouTube board exposes Scheduled between Editing and Published and retires Learning as a stage", () => {
  const source = read("src/components/youtube/YouTubeDecisionBoard.tsx");
  assert.match(source, /key:\s*"scheduled"[\s\S]*title:\s*"Scheduled"/);
  assert.match(source, /Editing → Scheduled → Published/);
  assert.match(source, /status:\s*"scheduled",\s*label:\s*"Scheduled"/);
  assert.doesNotMatch(source, /key:\s*"learning"/);
  assert.doesNotMatch(source, /status:\s*"learning",\s*label:\s*"Learning"/);
  assert.doesNotMatch(source, /learning:\s*"border-lime/);
  assert.match(source, /item\.status === "published"/);
  assert.doesNotMatch(source, /\["published",\s*"learning"\]\.includes\(item\.status\)/);
  assert.doesNotMatch(source, /item\.published_at \|\| item\.current_url/);
});

test("Scheduled board command requires launch context and reconciles the exact returned video item", () => {
  const source = read("src/components/youtube/YouTubeDecisionBoard.tsx");
  assert.match(source, /datetime-local/);
  assert.match(source, /pipeline_item_id:\s*selectedModel\.item\.id/);
  assert.match(source, /"\/api\/youtube\/launch-package"/);
  assert.match(source, /video_item/);
  assert.match(source, /form\.status === "scheduled"/);
});

test("launch route parses both exact-parent key styles, is local-only, and returns the updated row", () => {
  const source = read("src/app/api/youtube/launch-package/route.ts");
  assert.match(source, /\["pipeline_item_id", "pipelineItemId"\]/);
  assert.match(source, /pipelineItemId,/);
  assert.match(source, /video_item:\s*result\.videoItem/);
  assert.match(source, /cloud_youtube_launch_package_not_supported/);
  assert.doesNotMatch(source, /createScheduledYouTubeLaunchPackage\(createServiceClient/);
});

test("generic transition blocks every legacy transition for an active launch package regardless of card status", () => {
  const source = read("src/app/api/youtube/[id]/transition/route.ts");
  const whitelist = source.match(/const YOUTUBE_V0_STAGE_STATUSES = \[([\s\S]*?)\] as const/)?.[1] || "";
  assert.doesNotMatch(whitelist, /"learning"/);
  assert.doesNotMatch(whitelist, /"scheduled"/);
  assert.match(source, /launchPackage\.kind === "scheduled_youtube_launch_package_v1"/);
  assert.match(source, /launchPackage\.status === "scheduled"/);
  assert.match(source, /cannot use legacy transitions[\s\S]*activation live-check/i);
  assert.match(source, /status:\s*409/);
  assert.doesNotMatch(source, /item\.status === "scheduled"/);
  assert.match(source, /save_learning_review/);
});

test("statistics consumers require publication evidence rather than current_url alone", () => {
  const readModel = read("src/lib/youtube/statistics-read-model.ts");
  const dashboard = read("src/components/youtube/YouTubeLearningDashboard.tsx");
  assert.doesNotMatch(readModel, /Boolean\(row\.item\.published_at \|\| row\.item\.current_url/);
  assert.doesNotMatch(dashboard, /Boolean\(item\.published_at \|\| item\.current_url/);
});

test("scheduled and published statuses cannot be regressed by legacy gate derivation", () => {
  const { derivePipelineItemStatus } = loadYoutubePipeline();
  const metadata = { gates: { strategic_fit: { status: "not_started" } } };
  assert.equal(derivePipelineItemStatus(metadata, { currentStatus: "scheduled" }), "scheduled");
  assert.equal(derivePipelineItemStatus(metadata, { currentStatus: "published", publishedAt: "2026-07-31T12:00:00Z" }), "published");
});
