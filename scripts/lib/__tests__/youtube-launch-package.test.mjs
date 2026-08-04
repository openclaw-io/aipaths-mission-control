import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/youtube-launch-package.ts");

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
      if (specifier === "node:crypto") return { randomUUID };
      if (specifier === "@supabase/supabase-js") return {};
      throw new Error(`Unexpected require: ${specifier}`);
    },
    URL,
    Date,
    Number,
    Set,
    JSON,
    String,
    RegExp,
  };

  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const launchPackage = loadModule();

function baseContext(overrides = {}) {
  return {
    title: "Cómo construí un equipo usando IA",
    youtubeUrl: "https://www.youtube.com/watch?v=Dn1pJz5fq-w",
    videoId: "Dn1pJz5fq-w",
    publishAt: "2026-07-07T14:00:00.000Z",
    playlistContextUrl: "https://www.youtube.com/watch?v=Dn1pJz5fq-w&list=PLabc123",
    targetCommunityPublishAt: "2026-07-07T14:30:00.000Z",
    targetEmailSendAt: "2026-07-07T17:00:00.000Z",
    emailTrackingRef: "email-youtube-Dn1pJz5fq-w",
    optionalDiagnosticCta: "https://aipaths.academy/es/diagnostico-ia?ref=email-youtube-Dn1pJz5fq-w",
    cta: "Ver el video y responder con tu caso",
    preparedAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  };
}

test("buildScheduledYouTubeLaunchWorkSpecs includes immediate drafts, preflight, external gates, and snapshots", () => {
  assert.equal(typeof launchPackage.buildScheduledYouTubeLaunchWorkSpecs, "function");
  const specs = launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext());
  const byRelation = new Map(specs.map((spec) => [spec.relationType, spec]));

  assert.deepEqual([...byRelation.keys()], [
    "youtube_launch_preflight",
    "video_launch_activate",
    "launch_community_draft",
    "community_approval_reminder",
    "youtube_pinned_comment_draft",
    "pinned_comment_approval_reminder",
    "website_publish_video",
    "marketing_email_campaign",
    "marketing_approval_reminder",
    "youtube_snapshot_24h",
    "youtube_snapshot_7d",
    "youtube_snapshot_28d",
  ]);
  assert.equal(byRelation.get("youtube_launch_preflight").scheduledFor, "2026-07-07T13:30:00.000Z");
  assert.equal(byRelation.get("video_launch_activate").scheduledFor, "2026-07-07T14:02:00.000Z");
  assert.equal(byRelation.get("launch_community_draft").scheduledFor, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("community_approval_reminder").scheduledFor, "2026-07-07T13:00:00.000Z");
  assert.equal(byRelation.get("youtube_pinned_comment_draft").scheduledFor, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("pinned_comment_approval_reminder").scheduledFor, "2026-07-07T13:00:00.000Z");
  assert.equal(byRelation.get("website_publish_video").scheduledFor, "2026-07-07T14:15:00.000Z");
  assert.equal(byRelation.get("marketing_email_campaign").scheduledFor, "2026-07-07T10:00:00.000Z");
  assert.equal(byRelation.get("marketing_approval_reminder").scheduledFor, "2026-07-07T13:00:00.000Z");
  assert.equal(byRelation.get("youtube_snapshot_28d").scheduledFor, "2026-08-04T14:00:00.000Z");
});

test("preflight runs immediately when a launch is already inside the T-30m window", () => {
  const specs = launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({
    preparedAt: "2026-07-07T13:45:00.000Z",
  }));
  const preflight = specs.find((spec) => spec.relationType === "youtube_launch_preflight");
  assert.equal(preflight.scheduledFor, "2026-07-07T13:45:00.000Z");
});

test("prepublication drafts are authorized before the video is public and gate only external actions", () => {
  const specs = launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext());
  const community = specs.find((spec) => spec.relationType === "launch_community_draft");
  const pinned = specs.find((spec) => spec.relationType === "youtube_pinned_comment_draft");
  const marketing = specs.find((spec) => spec.relationType === "marketing_email_campaign");
  const website = specs.find((spec) => spec.relationType === "website_publish_video");

  assert.equal(community.ownerAgent, "community");
  assert.equal(community.payloadExtra.playlist_context_url, "https://www.youtube.com/watch?v=Dn1pJz5fq-w&list=PLabc123");
  assert.equal(community.payloadExtra.suppress_link_previews, false);
  assert.equal(community.payloadExtra.prepublication_draft_authorized, true);
  assert.equal(community.payloadExtra.public_gate_applies_to, "publish_or_send_only");
  assert.equal(community.payloadExtra.requires_gonza_approval, true);
  assert.equal(community.payloadExtra.notify_project_thread, false);
  assert.equal(community.payloadExtra.suppress_task_router_webhook, true);
  assert.equal(community.payloadExtra.private_director_channel_id, "1473373793375490058");
  assert.equal(community.payloadExtra.log_channel_id, "1473373793375490058");
  assert.equal(community.payloadExtra.customer_facing_guard, false);
  assert.equal(community.payloadExtra.validation_requirements.playlist_context_url_required, true);
  assert.match(community.instruction, /structured launch context/i);
  assert.match(community.instruction, /Ready for Review/i);
  assert.match(community.instruction, /Private\/scheduled YouTube videos are allowed for this draft/i);
  assert.doesNotMatch(community.instruction, /Before any customer-facing publish\/draft\/activation/);
  assert.doesNotMatch(community.instruction, /Newsletter\/email: out of scope/);

  assert.equal(pinned.ownerAgent, "youtube");
  assert.equal(pinned.action, "draft_youtube_pinned_comment");
  assert.equal(pinned.payloadExtra.prepublication_draft_authorized, true);
  assert.equal(pinned.payloadExtra.public_gate_applies_to, "publish_or_send_only");
  assert.equal(pinned.payloadExtra.requires_gonza_approval, true);
  assert.equal(pinned.payloadExtra.youtube_pinned_comment_publishing, "manual_out_of_scope");
  assert.equal(pinned.payloadExtra.auto_publish_forbidden, true);
  assert.equal(pinned.payloadExtra.private_director_channel_id, "1473373627750682664");
  assert.match(pinned.instruction, /pinned comment draft/i);
  assert.match(pinned.instruction, /do not publish/i);

  assert.equal(marketing.ownerAgent, "marketing");
  assert.equal(marketing.pipelineType, "email_campaign");
  assert.equal(marketing.action, "draft_video_announcement");
  assert.equal(marketing.payloadExtra.target_send_at, "2026-07-07T17:00:00.000Z");
  assert.equal(marketing.payloadExtra.email_tracking_ref, "email-youtube-Dn1pJz5fq-w");
  assert.equal(marketing.payloadExtra.requires_gonza_approval, true);
  assert.equal(marketing.payloadExtra.prepublication_draft_authorized, true);
  assert.equal(marketing.payloadExtra.public_gate_applies_to, "publish_or_send_only");
  assert.equal(marketing.payloadExtra.customer_facing_guard, false);
  assert.equal(marketing.payloadExtra.private_director_channel_id, "1473373756557623481");
  assert.match(marketing.instruction, /Marketing owns copy/i);
  assert.match(marketing.instruction, /do not send/i);

  assert.equal(website.payloadExtra.customer_facing_guard, true);
  assert.equal(website.payloadExtra.requires_preflight_passed, true);
  assert.equal(website.payloadExtra.requires_live_check_passed, true);
  assert.equal(website.payloadExtra.public_gate_applies_to, "activation_only");
  assert.equal(website.payloadExtra.runtime_retry_contract, "scheduled_launch_v2_retry_v1");
  assert.equal(website.payloadExtra.notify_project_thread, false);
  assert.equal(website.payloadExtra.suppress_task_router_webhook, true);
  assert.equal(website.payloadExtra.private_director_channel_id, "1473373777755639982");
  assert.match(website.instruction, /privacyStatus must be public/i);
});

test("approval reminders route only to responsible private director channels", () => {
  const specs = launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext());
  const byRelation = new Map(specs.map((spec) => [spec.relationType, spec]));

  for (const [relation, channelId] of [
    ["community_approval_reminder", "1473373793375490058"],
    ["pinned_comment_approval_reminder", "1473373627750682664"],
    ["marketing_approval_reminder", "1473373756557623481"],
  ]) {
    const spec = byRelation.get(relation);
    assert.equal(spec.action, "launch_approval_reminder");
    assert.equal(spec.payloadExtra.private_director_channel_id, channelId);
    assert.equal(spec.payloadExtra.log_channel_id, channelId);
    assert.equal(spec.payloadExtra.notify_project_thread, false);
    assert.equal(spec.payloadExtra.suppress_task_router_webhook, true);
    assert.match(spec.instruction, new RegExp(`<#${channelId}>`));
    assert.match(spec.instruction, /Never post this reminder to the project thread/i);
  }
});

test("generated public actions inherit Scheduled Launch V2 gates and Systems retry contract", () => {
  const payload = launchPackage.buildScheduledLaunchPublicActionPayload({
    ownerAgent: "marketing",
    action: "send_email_campaign",
    destination: "ai_paths_email",
    metadata: {
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        source_video_pipeline_item_id: "20000000-0000-4000-8000-000000000010",
        launch_generation: "youtube-launch-v1:Dn1pJz5fq-w:2026-07-07T14:00:00.000Z:fixture",
        video_id: "Dn1pJz5fq-w",
        youtube_url: "https://www.youtube.com/watch?v=Dn1pJz5fq-w",
        playlist_context_url: "https://www.youtube.com/watch?v=Dn1pJz5fq-w&list=PLabc123",
        playlist_id: "PLabc123",
        publish_at: "2026-07-07T14:00:00.000Z",
      },
    },
  });

  assert.equal(payload.launch_state_contract, "scheduled_launch_v2");
  assert.equal(payload.requires_preflight_passed, true);
  assert.equal(payload.requires_live_check_passed, true);
  assert.equal(payload.requires_gonza_approval, true);
  assert.equal(payload.notify_project_thread, false);
  assert.equal(payload.suppress_task_router_webhook, true);
  assert.equal(payload.private_director_channel_id, "1473373756557623481");
  assert.equal(payload.runtime_retry_contract, "scheduled_launch_v2_retry_v1");
  assert.match(payload.external_delivery_idempotency_key, /^ytlaunch:Dn1pJz5fq-w:[a-f0-9]{8}$/);
  assert.equal(JSON.stringify(payload.retry_policy.retryable_delays_minutes), JSON.stringify([1, 5, 15]));
});

test("buildScheduledYouTubeLaunchWorkSpecs rejects community launch work without a playlist URL", () => {
  assert.throws(
    () => launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({ playlistContextUrl: null })),
    /playlist_context_url.*required/i,
  );
  assert.throws(
    () => launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({
      playlistContextUrl: "https://www.youtube.com/watch?v=Dn1pJz5fq-w",
    })),
    /playlist_context_url.*list=/i,
  );
  assert.throws(
    () => launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({
      playlistContextUrl: "https://notyoutube.com/watch?v=Dn1pJz5fq-w&list=PLabc123",
    })),
    /playlist_context_url.*YouTube watch URL/i,
  );
  assert.throws(
    () => launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({
      playlistContextUrl: "http://www.youtube.com/watch?v=Dn1pJz5fq-w&list=PLabc123",
    })),
    /playlist_context_url.*YouTube watch URL/i,
  );
  assert.throws(
    () => launchPackage.buildScheduledYouTubeLaunchWorkSpecs(baseContext({
      playlistContextUrl: "https://www.youtube.com/watch?v=Different01&list=PLabc123",
    })),
    /playlist_context_url.*YouTube watch URL/i,
  );
});

test("validateCommunityLaunchDraftOutput rejects review when playlist context is missing", () => {
  const context = baseContext({ playlistContextUrl: null });
  const result = launchPackage.validateCommunityLaunchDraftOutput({
    finalCopy: `Nuevo video\n${context.youtubeUrl}`,
    status: "ready_for_review",
    playlistContextUrl: null,
    watchUrl: context.youtubeUrl,
    suppressLinkPreviews: false,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /playlist_context_url.*required/i);
});

test("validateCommunityLaunchDraftOutput enforces playlist context and raw YouTube embed requirements", () => {
  assert.equal(typeof launchPackage.validateCommunityLaunchDraftOutput, "function");
  const context = baseContext();
  const validCopy = `Nuevo video de AIPaths:\n\n${context.playlistContextUrl}`;

  const valid = launchPackage.validateCommunityLaunchDraftOutput({
    finalCopy: validCopy,
    status: "ready_for_review",
    playlistContextUrl: context.playlistContextUrl,
    watchUrl: context.youtubeUrl,
    suppressLinkPreviews: false,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual([...valid.errors], []);

  const bareWatch = launchPackage.validateCommunityLaunchDraftOutput({
    finalCopy: `Nuevo video\n${context.youtubeUrl}`,
    status: "ready_for_review",
    playlistContextUrl: context.playlistContextUrl,
    watchUrl: context.youtubeUrl,
    suppressLinkPreviews: false,
  });
  assert.equal(bareWatch.ok, false);
  assert.match(bareWatch.errors.join("\n"), /playlist_context_url/);

  const wrapped = launchPackage.validateCommunityLaunchDraftOutput({
    finalCopy: `Nuevo video\n<${context.playlistContextUrl}>`,
    status: "ready_for_review",
    playlistContextUrl: context.playlistContextUrl,
    watchUrl: context.youtubeUrl,
    suppressLinkPreviews: false,
  });
  assert.equal(wrapped.ok, false);
  assert.match(wrapped.errors.join("\n"), /raw\/unwrapped/);

  const draftStatus = launchPackage.validateCommunityLaunchDraftOutput({
    finalCopy: validCopy,
    status: "draft",
    playlistContextUrl: context.playlistContextUrl,
    watchUrl: context.youtubeUrl,
    suppressLinkPreviews: false,
  });
  assert.equal(draftStatus.ok, false);
  assert.match(draftStatus.errors.join("\n"), /ready_for_review/);
});
