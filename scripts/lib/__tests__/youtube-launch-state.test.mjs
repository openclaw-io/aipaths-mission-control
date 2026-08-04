import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/youtube-launch-state.ts");

function loadModule() {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;

  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require(specifier) {
      throw new Error(`Unexpected require: ${specifier}`);
    },
    URL,
    Date,
    Number,
    Set,
    JSON,
    String,
    Object,
    Array,
  };

  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const launchState = loadModule();

test("T-30 preflight ignores agent-supplied approvals and requires authoritative approval of every child card", () => {
  const publishAt = "2026-08-04T12:00:00.000Z";
  const generation = `youtube-launch-v1:Approval001:${publishAt}:current`;
  const item = {
    id: "video-approval-parent",
    status: "scheduled",
    scheduled_for: publishAt,
    metadata: {
      youtube_v0: { video_id: "Approval001", playlist_id: "PLabc123" },
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        status: "scheduled",
        launch_generation: generation,
        publish_at: publishAt,
        video_id: "Approval001",
        youtube_url: "https://www.youtube.com/watch?v=Approval001",
        playlist_id: "PLabc123",
      },
    },
  };
  const supplied = {
    status: "pass",
    checked_at: "2026-08-04T11:31:00.000Z",
    approvals: {
      community: { status: "approved" },
      marketing: { status: "approved" },
      pinned_comment: { status: "manual_out_of_scope", manual_out_of_scope: true },
    },
    evidence: {
      video_id: "Approval001",
      canonical_url: "https://www.youtube.com/watch?v=Approval001",
      privacy_status: "private",
      scheduled_publish_at: publishAt,
      playlist: { playlist_id: "PLabc123", contains_video: true },
      runtime_health: { status: "healthy" },
    },
  };

  const untrusted = launchState.validateYouTubeLaunchPreflight({ item, preflight: supplied });
  assert.equal(untrusted.ok, false);
  assert.ok(untrusted.blockers.includes("community_approval_missing"));
  assert.ok(untrusted.blockers.includes("marketing_approval_missing"));
  assert.ok(untrusted.blockers.includes("pinned_comment_approval_missing"));

  const pinnedManualOnly = launchState.validateYouTubeLaunchPreflight({
    item,
    preflight: supplied,
    now: "2026-08-04T11:31:00.000Z",
    authoritativeApprovals: {
      community: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      marketing: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      pinnedComment: { status: "pending", manualPublication: true },
    },
  });
  assert.equal(pinnedManualOnly.ok, false);
  assert.ok(pinnedManualOnly.blockers.includes("pinned_comment_approval_missing"));

  const approved = launchState.validateYouTubeLaunchPreflight({
    item,
    preflight: supplied,
    now: "2026-08-04T11:31:00.000Z",
    authoritativeApprovals: {
      community: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      marketing: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      pinnedComment: { status: "approved", approvedBy: "gonza", launchGeneration: generation, manualPublication: true },
    },
  });
  assert.equal(approved.ok, true);

  const staleApproval = launchState.validateYouTubeLaunchPreflight({
    item,
    preflight: supplied,
    now: "2026-08-04T11:31:00.000Z",
    authoritativeApprovals: {
      community: { status: "approved", approvedBy: "gonza", launchGeneration: `${generation}:stale` },
      marketing: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      pinnedComment: { status: "approved", approvedBy: "gonza", launchGeneration: generation, manualPublication: true },
    },
  });
  assert.equal(staleApproval.ok, false);
  assert.ok(staleApproval.blockers.includes("community_approval_missing"));

  const early = launchState.validateYouTubeLaunchPreflight({
    item,
    preflight: supplied,
    now: "2026-08-04T11:00:00.000Z",
    authoritativeApprovals: {
      community: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      marketing: { status: "approved", approvedBy: "gonza", launchGeneration: generation },
      pinnedComment: { status: "approved", approvedBy: "gonza", launchGeneration: generation, manualPublication: true },
    },
  });
  assert.equal(early.ok, false);
  assert.ok(early.blockers.includes("preflight_executed_before_t30_window"));
  assert.ok(early.blockers.includes("preflight_checked_at_in_future"));
});

test("reschedule A to B rejects copied preflight evidence until B is checked", () => {
  const publishA = "2026-08-04T12:00:00.000Z";
  const publishB = "2026-08-05T12:00:00.000Z";
  const generationA = `youtube-launch-v1:Resched0001:${publishA}:A`;
  const generationB = `youtube-launch-v1:Resched0001:${publishB}:B`;
  const item = {
    id: "video-reschedule-parent",
    status: "published",
    metadata: {
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        status: "activated",
        launch_generation: generationB,
        publish_at: publishB,
        preflight: { status: "pass", launch_generation: generationA, publish_at: publishA },
        public_verified: true,
      },
    },
  };
  const workItem = {
    id: "work-reschedule-b",
    status: "ready",
    payload: {
      launch_state_contract: "scheduled_launch_v2",
      relation_type: "send_email_campaign",
      source_video_pipeline_item_id: item.id,
      launch_generation: generationB,
      publish_at: publishB,
      requires_preflight_passed: true,
      requires_live_check_passed: true,
    },
  };

  const stale = launchState.evaluateYouTubeLaunchActionReadiness({ item, workItem });
  assert.equal(stale.ok, false);
  assert.ok(stale.failures.includes("preflight_generation_stale"));
  assert.ok(stale.failures.includes("preflight_publish_time_stale"));

  item.metadata.launch_package.preflight = { status: "pass", launch_generation: generationB, publish_at: publishB };
  const current = launchState.evaluateYouTubeLaunchActionReadiness({ item, workItem });
  assert.equal(current.ok, true);
});

test("scheduled launch readiness rejects stale public-action generations", () => {
  const item = {
    id: "video-parent-1",
    status: "published",
    metadata: {
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        status: "activated",
        launch_generation: "youtube-launch-v1:VideoState1:2026-08-04T12:00:00.000Z:current",
        publish_at: "2026-08-04T12:00:00.000Z",
        preflight: {
          status: "pass",
          launch_generation: "youtube-launch-v1:VideoState1:2026-08-04T12:00:00.000Z:current",
          publish_at: "2026-08-04T12:00:00.000Z",
        },
        public_verified: true,
      },
    },
  };
  const workItem = {
    id: "work-stale",
    status: "ready",
    payload: {
      launch_state_contract: "scheduled_launch_v2",
      relation_type: "send_email_campaign",
      action: "send_email_campaign",
      source_video_pipeline_item_id: item.id,
      launch_generation: "youtube-launch-v1:VideoState1:2026-08-04T12:00:00.000Z:old",
      publish_at: "2026-08-04T12:00:00.000Z",
      requires_preflight_passed: true,
      requires_live_check_passed: true,
      requires_gonza_approval: true,
      approval_status: "approved",
    },
  };

  const result = launchState.evaluateYouTubeLaunchActionReadiness({ item, workItem });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result.failures), JSON.stringify(["launch_generation_stale"]));
});

test("scheduled launch status view exposes blockers, evidence, and remediation", () => {
  const item = {
    id: "video-parent-2",
    status: "scheduled",
    metadata: {
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        launch_state: "blocked",
        preflight: {
          status: "blocked",
          blockers: ["runtime_health_not_confirmed"],
          evidence: { summary: "Scheduler heartbeat missing" },
          remediation: "Restart scheduler, then rerun T-30 preflight.",
        },
      },
    },
  };
  const view = launchState.buildLaunchStatusViewModel(item, []);
  assert.equal(view.state, "blocked");
  assert.equal(view.evidence, "Scheduler heartbeat missing");
  assert.equal(view.remediation, "Restart scheduler, then rerun T-30 preflight.");
  assert.equal(JSON.stringify(view.blockers), JSON.stringify(["runtime_health_not_confirmed"]));
});

test("scheduled launch status view prefers authoritative child-card approval", () => {
  const item = {
    id: "video-parent-authoritative",
    status: "scheduled",
    metadata: { launch_package: { kind: "scheduled_youtube_launch_package_v1", launch_state: "awaiting_approval" } },
  };
  const workItem = {
    id: "community-draft-authoritative",
    source_id: "video-parent-authoritative",
    status: "done",
    payload: {
      launch_state_contract: "scheduled_launch_v2",
      relation_type: "launch_community_draft",
      requires_gonza_approval: true,
      approval_status: "pending",
      authoritative_approval: {
        pipeline_item_id: "community-card-1",
        status: "approved",
        approved_by: "gonza",
      },
    },
  };

  const view = launchState.buildLaunchStatusViewModel(item, [workItem]);
  assert.equal(view.artifacts[0].approval, "approved");
});
