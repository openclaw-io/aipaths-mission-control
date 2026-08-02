import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

function loadLaunchRoute({ playlists = [], createLaunch = async (input) => ({
  videoItem: { id: input.pipelineItemId },
  communityItem: { id: "community" },
  marketingItem: { id: "marketing" },
  pinnedCommentItem: { id: "pinned" },
  videoId: input.videoId,
  youtubeUrl: input.youtubeUrl,
  playlistId: input.playlistId,
  playlistContextUrl: `https://www.youtube.com/watch?v=${input.videoId}&list=${input.playlistId}`,
  publishAt: input.publishAt,
  targetCommunityPublishAt: input.publishAt,
  targetEmailSendAt: input.publishAt,
  videoItemCreated: false,
  communityItemCreated: true,
  marketingItemCreated: true,
  pinnedCommentItemCreated: true,
  workItems: [],
}) } = {}) {
  const sourcePath = resolve(repoRoot, "src/app/api/youtube/launch-package/route.ts");
  const output = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const calls = { catalog: [], launch: [], launchResult: [] };
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    module: mod,
    exports: mod.exports,
    require(specifier) {
      if (specifier === "next/server") return {
        NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) },
      };
      if (specifier === "@/lib/supabase/server") return { createClient: async () => { throw new Error("unexpected cloud auth"); } };
      if (specifier === "@/lib/auth/local") return {
        isLocalAuthDisabled: () => true,
        getLocalMissionControlUser: () => ({ email: "operator@example.test" }),
      };
      if (specifier === "@/lib/youtube-launch-package") return {
        extractYouTubeVideoId: (url) => typeof url === "string" ? new URL(url).searchParams.get("v") : null,
      };
      if (specifier === "@/lib/youtube-launch-package-local") return {
        createScheduledYouTubeLaunchPackageLocal: async (input) => {
          calls.launch.push(input);
          const result = await createLaunch(input);
          calls.launchResult.push(result);
          return result;
        },
      };
      if (specifier === "@/lib/youtube/playlists") return {
        listYouTubePlaylists: async (filters) => {
          calls.catalog.push(filters);
          return playlists;
        },
        isYouTubeLaunchPlaylistEligible: (playlist) => playlist.status === "active"
          && playlist.kind !== "archive"
          && playlist.kind !== "shorts",
      };
      throw new Error(`Unexpected import ${specifier}`);
    },
    URL,
    Date,
    Number,
    RegExp,
    JSON,
    console,
  }, { filename: sourcePath });
  return { POST: mod.exports.POST, calls };
}

function request(body) {
  return {
    headers: { get: () => null },
    json: async () => body,
  };
}

const baseBody = {
  pipeline_item_id: "11223344-5566-4788-99aa-bbccddeeff00",
  youtube_url: "https://www.youtube.com/watch?v=ExactCard01",
  video_id: "ExactCard01",
  publish_at: "2026-08-01T12:00:00.000Z",
  title: "Exact board card",
};

const eligiblePlaylist = {
  playlist_id: "PL-governed",
  canonical_slug: "governed",
  title: "Governed launches",
  purpose: "Normal long-form launches",
  kind: "hub",
  status: "active",
};

test("operator page passes compact active eligible playlist options into the board", () => {
  const page = read("src/app/youtube/page.tsx");
  assert.match(page, /listYouTubePlaylists/);
  assert.match(page, /status:\s*"active"/);
  assert.match(page, /isYouTubeLaunchPlaylistEligible/);
  assert.match(page, /playlist_id:\s*playlist\.playlist_id/);
  assert.match(page, /title:\s*playlist\.title/);
  assert.match(page, /purpose:\s*playlist\.purpose/);
  assert.match(page, /playlistOptions=\{playlistOptions\}/);
});

test("board blocks an absent Scheduled playlist before POST and sends a selected catalog playlist_id", () => {
  const board = read("src/components/youtube/YouTubeDecisionBoard.tsx");
  assert.match(board, /playlistId:\s*string/);
  assert.match(board, /playlistOptions/);
  assert.match(board, /form\.status === "scheduled"[\s\S]*<select[\s\S]*required/);
  assert.match(board, /option\.title[\s\S]*option\.purpose/);
  assert.match(board, /playlistId:\s*selectedModel\.details\.playlistId/);
  assert.match(board, /launch_package",\s*"playlist_context_url/);
  assert.match(board, /Scheduled requires[\s\S]*playlist/i);
  assert.match(board, /playlist_id:\s*stageForm\.playlistId/);

  const playlistGuard = board.indexOf("!stageForm.playlistId.trim()");
  const post = board.indexOf("await fetch(");
  assert.ok(playlistGuard >= 0 && playlistGuard < post, "missing selection must be rejected before fetch");
});

test("route returns readable 400 for missing playlist_id without reading catalog or starting local transaction", async () => {
  const { POST, calls } = loadLaunchRoute();
  const response = await POST(request(baseBody));
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /playlist_id is required/i);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.launch.length, 0);
});

test("route rejects unknown, ineligible, or non-unique playlist_id with 400 before local implementation", async () => {
  for (const playlists of [
    [],
    [{ ...eligiblePlaylist, kind: "shorts", playlist_id: "PL-shorts" }],
    [eligiblePlaylist, { ...eligiblePlaylist }],
  ]) {
    const { POST, calls } = loadLaunchRoute({ playlists });
    const playlistId = playlists[0]?.playlist_id || "PL-unknown";
    const response = await POST(request({ ...baseBody, playlist_id: playlistId }));
    assert.equal(response.status, 400);
    assert.match(response.payload.error, /active eligible.*catalog/i);
    assert.equal(calls.catalog.length, 1);
    assert.equal(calls.catalog[0].status, "active");
    assert.equal(calls.launch.length, 0);
  }
});

test("route maps governed transaction validation and existing-state conflicts to readable client errors", async () => {
  for (const [status, message] of [
    [400, "playlist_id must reference exactly one active eligible playlist in the governed YouTube catalog"],
    [409, "Existing scheduled launch conflicts with governed playlist_id PL-governed"],
  ]) {
    const error = new Error(message);
    error.status = status;
    const { POST } = loadLaunchRoute({
      playlists: [eligiblePlaylist],
      createLaunch: async () => { throw error; },
    });
    const response = await POST(request({ ...baseBody, playlist_id: eligiblePlaylist.playlist_id }));
    assert.equal(response.status, status);
    assert.equal(response.payload.error, message);
  }
});

test("route accepts simultaneous playlist context aliases when their normalized values match", async () => {
  const playlistContextUrl = `${baseBody.youtube_url}&list=${eligiblePlaylist.playlist_id}`;
  const { POST, calls } = loadLaunchRoute({ playlists: [eligiblePlaylist] });
  const response = await POST(request({
    ...baseBody,
    playlist_id: eligiblePlaylist.playlist_id,
    playlist_context_url: `  ${playlistContextUrl}`,
    playlistContextUrl: playlistContextUrl,
    playlist_url: `${playlistContextUrl}  `,
    playlistUrl: ` ${playlistContextUrl} `,
  }));

  assert.equal(response.status, 200);
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].playlistContextUrl, playlistContextUrl);
});

test("route rejects contradictory simultaneous playlist context aliases before catalog or local transaction", async () => {
  const governedContext = `${baseBody.youtube_url}&list=${eligiblePlaylist.playlist_id}`;
  const { POST, calls } = loadLaunchRoute({ playlists: [eligiblePlaylist] });
  const response = await POST(request({
    ...baseBody,
    playlist_id: eligiblePlaylist.playlist_id,
    playlist_context_url: governedContext,
    playlistContextUrl: ` ${governedContext} `,
    playlist_url: `${baseBody.youtube_url}&list=PL-contradictory`,
    playlistUrl: `${baseBody.youtube_url}&list=PL-contradictory`,
  }));

  assert.equal(response.status, 400);
  assert.match(response.payload.error, /playlist_context_url aliases.*same value/i);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.launch.length, 0);
});

test("route accepts simultaneous playlist_id aliases when their normalized values match", async () => {
  const { POST, calls } = loadLaunchRoute({ playlists: [eligiblePlaylist] });
  const response = await POST(request({
    ...baseBody,
    playlist_id: ` ${eligiblePlaylist.playlist_id} `,
    playlistId: eligiblePlaylist.playlist_id,
  }));

  assert.equal(response.status, 200);
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].playlistId, eligiblePlaylist.playlist_id);
});

test("route rejects contradictory simultaneous playlist_id aliases before catalog or local transaction", async () => {
  const { POST, calls } = loadLaunchRoute({ playlists: [eligiblePlaylist] });
  const response = await POST(request({
    ...baseBody,
    playlist_id: eligiblePlaylist.playlist_id,
    playlistId: "PL-contradictory",
  }));

  assert.equal(response.status, 400);
  assert.match(response.payload.error, /playlist_id aliases.*same value/i);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.launch.length, 0);
});

test("contradictory playlist context aliases reach governed validation and return readable 400 without a local result", async () => {
  for (const alias of ["playlist_context_url", "playlistContextUrl", "playlist_url", "playlistUrl"]) {
    const contradictoryContext = `${baseBody.youtube_url}&list=PL-untrusted-raw-input`;
    const error = new Error(`playlist_context_url conflicts with governed playlist_id ${eligiblePlaylist.playlist_id}`);
    error.status = 400;
    const { POST, calls } = loadLaunchRoute({
      playlists: [eligiblePlaylist],
      createLaunch: async (input) => {
        assert.equal(input.playlistContextUrl, contradictoryContext);
        throw error;
      },
    });
    const response = await POST(request({
      ...baseBody,
      playlist_id: eligiblePlaylist.playlist_id,
      [alias]: contradictoryContext,
    }));

    assert.equal(response.status, 400, alias);
    assert.match(response.payload.error, /playlist_context_url conflicts with governed playlist_id PL-governed/i);
    assert.equal(calls.catalog.length, 1);
    assert.equal(calls.launch.length, 1, `${alias} must reach the governed local validator`);
    assert.equal(calls.launchResult.length, 0, `${alias} must not produce a committed local launch result`);
  }
});

test("valid selected playlist without supplied context reaches the local implementation as the exact governed playlist ID", async () => {
  const { POST, calls } = loadLaunchRoute({ playlists: [eligiblePlaylist] });
  const response = await POST(request({
    ...baseBody,
    playlist_id: eligiblePlaylist.playlist_id,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.playlist_id, eligiblePlaylist.playlist_id);
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].playlistId, eligiblePlaylist.playlist_id);
  assert.equal(calls.launch[0].requireGovernedPlaylist, true);
  assert.equal(calls.launch[0].playlistContextUrl, null);
  assert.equal(calls.launchResult.length, 1);
  assert.equal(calls.launch[0].pipelineItemId, baseBody.pipeline_item_id);
  assert.equal(calls.launch[0].videoId, baseBody.video_id);
  assert.equal(calls.launch[0].publishAt, baseBody.publish_at);
});
