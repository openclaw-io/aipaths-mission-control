import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseUrl = requireMissionControlTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const failure = { eventTable: null, armed: false };

function transpileModule(sourcePath, requires = {}, globals = {}) {
  const source = readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
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
    Date, Number, Set, Map, JSON, String, RegExp, Object, Array, Math, URL, Buffer,
    structuredClone, console: { ...console, error() {} },
    process: { env: {} },
    fetch: async () => ({ ok: true, status: 200 }),
    ...globals,
  };
  vm.runInNewContext(output, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const postgres = {
  query: (text, params) => pool.query(text, params),
  withTransaction: async (run) => {
    const client = await pool.connect();
    const proxy = {
      query(text, params) {
        const normalized = String(text).replace(/\s+/g, " ").trim().toLowerCase();
        if (failure.armed && failure.eventTable && normalized.startsWith(`insert into ${failure.eventTable}`)) {
          failure.armed = false;
          throw new Error(`injected ${failure.eventTable} failure`);
        }
        return client.query(text, params);
      },
    };
    try {
      await client.query("begin");
      const result = await run(proxy);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
};

const auth = {
  isLocalAuthDisabled: () => true,
  getLocalMissionControlUser: () => ({ email: "atomic-handler@example.test" }),
};
const nextServer = { NextResponse: { json: (payload, init = {}) => ({ payload, status: init.status || 200 }) } };
const cloudServer = { createClient: async () => { throw new Error("unexpected cloud auth"); } };
const cloudAdmin = { createServiceClient: () => { throw new Error("unexpected cloud db"); } };

const pipelineLocal = transpileModule(resolve(repoRoot, "src/lib/db/pipeline-local.ts"), {
  "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": postgres,
  "@/lib/work-items/pipeline-materializer": {},
});
const youtubeLaunchPackage = transpileModule(resolve(repoRoot, "src/lib/youtube-launch-package.ts"), {
  "node:crypto": { randomUUID },
});
const emailLocal = transpileModule(resolve(repoRoot, "src/lib/email-campaigns/local.ts"), {
  "@/lib/db/mission-control": { normalizeRow: (row) => row, normalizeRows: (rows) => rows },
  "@/lib/db/postgres": postgres,
  "@/lib/youtube-launch-package": youtubeLaunchPackage,
});
const youtubePipeline = transpileModule(resolve(repoRoot, "src/lib/youtube-pipeline.ts"));
const scheduling = transpileModule(resolve(repoRoot, "src/lib/publication/scheduling.ts"));
const schedulingLocal = transpileModule(resolve(repoRoot, "src/lib/publication/scheduling-local.ts"), {
  "@/lib/db/postgres": postgres,
  "@/lib/publication/scheduling": scheduling,
});
function loadRoute(relativePath, extra = {}) {
  return transpileModule(resolve(repoRoot, relativePath), {
    "node:crypto": { createHash, randomUUID },
    "next/server": nextServer,
    "@/lib/auth/local": auth,
    "@/lib/db/postgres": postgres,
    "@/lib/db/pipeline-local": pipelineLocal,
    "@/lib/publication/scheduling": scheduling,
    "@/lib/publication/scheduling-local": schedulingLocal,
    "@/lib/supabase/server": cloudServer,
    "@/lib/supabase/admin": cloudAdmin,
    "@/lib/work-items/pipeline-materializer": { createPipelineWorkItem: async () => { throw new Error("unexpected cloud materializer"); } },
    "@/lib/youtube-launch-package": youtubeLaunchPackage,
    "@/lib/youtube-pipeline": youtubePipeline,
    "@/lib/loops/read-model": {},
    ...extra,
  });
}

const guideRoute = loadRoute("src/app/api/guides/[id]/transition/route.ts");
const youtubeRoute = loadRoute("src/app/api/youtube/[id]/transition/route.ts");
const communityRoute = loadRoute("src/app/api/community/[id]/transition/route.ts");
const emailReviewRoute = loadRoute("src/app/api/email-campaigns/[id]/review/route.ts", {
  "@/lib/email-campaigns/local": emailLocal,
});
const createLoopRoute = loadRoute("src/app/api/loops/create/route.ts");
const submitLoopRoute = loadRoute("src/app/api/loops/[id]/submit-for-approval/route.ts");
const clarifyLoopRoute = loadRoute("src/app/api/loops/[id]/clarify/route.ts");
const approveLoopRoute = loadRoute("src/app/api/loops/[id]/approve/route.ts");

before(async () => { await pool.query("select 1 from pipeline_items limit 1"); });
after(async () => { await pool.end(); });

function request(body) { return { json: async () => body }; }
function context(id) { return { params: Promise.resolve({ id }) }; }
async function cleanupPipeline(id) { await pool.query("delete from pipeline_items where id = $1", [id]); }
async function cleanupLoop(id) { await pool.query("delete from loops where id = $1", [id]); }
function assertPublicationSlot(slot, expectedScheduledFor, expectedSource) {
  assert.equal(slot?.scheduledFor, expectedScheduledFor);
  assert.equal(slot?.source, expectedSource);
}

test("Community publication resolvers keep explicit and existing schedules for content launch", async () => {
  const metadata = { kind: "video_launch_announcement", source: { type: "video" } };
  const explicitTarget = "2099-08-04T13:30:00.000Z";
  const existingTarget = "2099-08-05T13:30:00.000Z";
  const throwingDb = { from() { throw new Error("resolver should not read supabase for content launch explicit schedule"); } };
  const throwingClient = { query() { throw new Error("resolver should not read local postgres for content launch explicit schedule"); } };

  assertPublicationSlot(
    await scheduling.resolveCommunityPublicationSlot(throwingDb, { metadata, explicitScheduledFor: explicitTarget }),
    explicitTarget,
    "explicit",
  );
  assertPublicationSlot(
    await schedulingLocal.resolveCommunityPublicationSlotLocal({ metadata, explicitScheduledFor: explicitTarget, client: throwingClient }),
    explicitTarget,
    "explicit",
  );
  assertPublicationSlot(
    await scheduling.resolveCommunityPublicationSlot(throwingDb, { metadata, existingScheduledFor: existingTarget }),
    existingTarget,
    "existing",
  );
  assertPublicationSlot(
    await schedulingLocal.resolveCommunityPublicationSlotLocal({ metadata, existingScheduledFor: existingTarget, client: throwingClient }),
    existingTarget,
    "existing",
  );
  assert.equal(
    await scheduling.resolveCommunityPublicationSlot(throwingDb, { metadata }),
    null,
  );
  assert.equal(
    await schedulingLocal.resolveCommunityPublicationSlotLocal({ metadata, client: throwingClient }),
    null,
  );
});

test("Community approval route schedules Scheduled Launch content-launch publish work at explicit target", async () => {
  const id = randomUUID();
  const sourceVideoPipelineItemId = randomUUID();
  const target = "2099-08-04T13:30:00.000Z";
  const launchGeneration = `youtube-launch-v1:CommPub0001:${target}:fixture`;
  await pool.query(
    `insert into pipeline_items (id,pipeline_type,title,status,priority,owner_agent,requested_by,source_type,source_id,metadata)
     values ($1,'community_post',$2,'ready_for_review','high','community','strategist','pipeline_item',$3,$4::jsonb)`,
    [id, "Scheduled Launch community approval", `video-${id}`, JSON.stringify({
      kind: "video_launch_announcement",
      source: { type: "video", url: "https://youtu.be/CommPub0001", video_id: "CommPub0001" },
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        source_video_pipeline_item_id: sourceVideoPipelineItemId,
        launch_generation: launchGeneration,
        video_id: "CommPub0001",
        youtube_url: "https://www.youtube.com/watch?v=CommPub0001",
        playlist_context_url: "https://www.youtube.com/watch?v=CommPub0001&list=PLabc123",
        playlist_id: "PLabc123",
        publish_at: target,
      },
      schedule: { target_publish_at: target },
      copy: { text: "Sale el video: https://youtu.be/CommPub0001" },
    })],
  );
  try {
    const response = await communityRoute.POST(request({ action: "approve" }), context(id));
    assert.equal(response.status, 200);
    assert.equal(response.payload.status, "scheduled");
    assert.equal(new Date(response.payload.scheduled_for).toISOString(), target);
    assert.equal(new Date(response.payload.metadata.schedule.scheduled_for).toISOString(), target);
    assert.equal(response.payload.metadata.schedule.source, "explicit");

    const workRows = (await pool.query(
      "select id, status, scheduled_for, payload, instruction from work_items where source_id=$1 and payload->>'action'='publish_community_post' order by created_at",
      [id],
    )).rows;
    assert.equal(workRows.length, 1);
    assert.equal(workRows[0].status, "ready");
    assert.equal(new Date(workRows[0].scheduled_for).toISOString(), target);
    assert.equal(workRows[0].payload.trigger, "community_review_approved_scheduled");
    assert.equal(workRows[0].payload.schedule_kind, "publication");
    assert.equal(workRows[0].payload.launch_state_contract, "scheduled_launch_v2");
    assert.equal(workRows[0].payload.launch_generation, launchGeneration);
    assert.equal(workRows[0].payload.source_video_pipeline_item_id, sourceVideoPipelineItemId);
    assert.equal(workRows[0].payload.requires_preflight_passed, true);
    assert.equal(workRows[0].payload.requires_live_check_passed, true);
    assert.equal(workRows[0].payload.approval_status, "approved");
    assert.equal(workRows[0].payload.notify_project_thread, false);
    assert.equal(workRows[0].payload.suppress_task_router_webhook, true);
    assert.equal(workRows[0].payload.runtime_retry_contract, "scheduled_launch_v2_retry_v1");
    assert.match(workRows[0].instruction, /scheduled Work Queue time/i);
  } finally {
    await pool.query("delete from work_items where source_id=$1", [id]);
    await cleanupPipeline(id);
  }
});

test("Community approval route updates one deduped blocked publish work item to the explicit target without stale live-gate state", async () => {
  const id = randomUUID();
  const workId = randomUUID();
  const target = "2099-08-04T13:30:00.000Z";
  await pool.query(
    `insert into pipeline_items (id,pipeline_type,title,status,priority,owner_agent,requested_by,source_type,source_id,metadata)
     values ($1,'community_post',$2,'ready_for_review','high','community','strategist','pipeline_item',$3,$4::jsonb)`,
    [id, "Scheduled Launch community repair", `video-${id}`, JSON.stringify({
      kind: "video_launch_announcement",
      source: { type: "video", url: "https://youtu.be/testCommunityRepair", video_id: "testCommunityRepair" },
      schedule: { target_publish_at: target },
      copy: { text: "Sale el video: https://youtu.be/testCommunityRepair" },
    })],
  );
  await pool.query(
    `insert into work_items (
       id, kind, source_type, source_id, title, instruction, status, priority,
       owner_agent, target_agent_id, requested_by, scheduled_for, payload
     ) values (
       $1, 'task', 'pipeline_item', $2, 'Publish community post: old', 'old immediate instruction',
       'blocked', 'high', 'community', 'community', 'scheduler', null, $3::jsonb
     )`,
    [workId, id, JSON.stringify({
      trigger: "community_review_approved_immediate",
      pipeline_type: "community_post",
      pipeline_item_id: id,
      relation_type: "publish",
      action: "publish_community_post",
      schedule_kind: "publication",
      dispatch_state: "blocked_live_gate",
      requires_live_check_passed: true,
    })],
  );
  try {
    const response = await communityRoute.POST(request({ action: "approve" }), context(id));
    assert.equal(response.status, 200);
    assert.equal(new Date(response.payload.metadata.schedule.scheduled_for).toISOString(), target);

    const workRows = (await pool.query(
      "select id, title, status, scheduled_for, payload, instruction from work_items where source_id=$1 and payload->>'action'='publish_community_post' order by created_at",
      [id],
    )).rows;
    assert.equal(workRows.length, 1);
    assert.equal(workRows[0].id, workId);
    assert.equal(workRows[0].status, "ready");
    assert.equal(new Date(workRows[0].scheduled_for).toISOString(), target);
    assert.equal(workRows[0].payload.trigger, "community_review_approved_scheduled");
    assert.equal(workRows[0].payload.dispatch_state, "ready_after_explicit_schedule");
    assert.equal(workRows[0].payload.previous_dispatch_state, "blocked_live_gate");
    assert.match(workRows[0].instruction, /scheduled Work Queue time/i);
  } finally {
    await pool.query("delete from work_items where source_id=$1", [id]);
    await cleanupPipeline(id);
  }
});

test("Email approval route auto-schedules Scheduled Launch video announcements atomically and idempotently", async () => {
  const id = randomUUID();
  const sourceVideoPipelineItemId = randomUUID();
  const firstTarget = "2099-04-10T15:30:00.000Z";
  const secondTarget = "2099-04-11T16:45:00.000Z";
  const launchGeneration = `youtube-launch-v1:yz-Dig_3ziQ:${firstTarget}:fixture`;
  await pool.query(
    `insert into pipeline_items (id,pipeline_type,title,status,priority,owner_agent,requested_by,source_type,source_id,scheduled_for,metadata)
     values ($1,'email_campaign',$2,'ready_for_review','high','marketing','strategist','pipeline_item',$3,$4,$5::jsonb)`,
    [id, "Scheduled Launch email yz-Dig_3ziQ", `video-${id}`, secondTarget, JSON.stringify({
      kind: "video_announcement",
      video_id: "yz-Dig_3ziQ",
      launch_package: {
        kind: "scheduled_youtube_launch_package_v1",
        source_video_pipeline_item_id: sourceVideoPipelineItemId,
        launch_generation: launchGeneration,
        video_id: "yz-Dig_3ziQ",
        youtube_url: "https://www.youtube.com/watch?v=yz-Dig_3ziQ",
        playlist_context_url: "https://www.youtube.com/watch?v=yz-Dig_3ziQ&list=PLabc123",
        playlist_id: "PLabc123",
        publish_at: firstTarget,
        target_send_at: firstTarget,
      },
      draft: { subject: "Sale el video", preview_text: "Preview", body_markdown: "Body" },
      review: { previous_note: "keep-me" },
    })],
  );
  try {
    failure.eventTable = "public.pipeline_events";
    failure.armed = true;
    await assert.rejects(() => emailReviewRoute.POST(request({ action: "approve" }), context(id)), /injected public\.pipeline_events failure/);
    assert.equal((await pool.query("select status from pipeline_items where id=$1", [id])).rows[0].status, "ready_for_review");
    assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1", [id])).rows[0].n, 0);

    const first = await emailReviewRoute.POST(request({ action: "approve" }), context(id));
    assert.equal(first.status, 200);
    const afterFirst = (await pool.query("select status, scheduled_for, metadata from pipeline_items where id=$1", [id])).rows[0];
    assert.equal(afterFirst.status, "scheduled");
    assert.equal(new Date(afterFirst.scheduled_for).toISOString(), firstTarget);
    assert.equal(afterFirst.metadata.review.status, "approved");
    assert.equal(afterFirst.metadata.review.launch_generation, launchGeneration);
    assert.equal(afterFirst.metadata.review.previous_note, "keep-me");
    assert.equal(new Date(afterFirst.metadata.schedule.scheduled_for).toISOString(), firstTarget);

    await pool.query(
      "update pipeline_items set metadata = jsonb_set(metadata, '{launch_package,target_send_at}', to_jsonb($2::text), true) where id=$1",
      [id, secondTarget],
    );
    const rerun = await emailReviewRoute.POST(request({ action: "approve" }), context(id));
    assert.equal(rerun.status, 200);

    const workRows = (await pool.query(
      "select id, status, scheduled_for, payload, instruction from work_items where source_id=$1 and payload->>'action'='send_email_campaign' order by created_at",
      [id],
    )).rows;
    assert.equal(workRows.length, 1);
    assert.equal(workRows[0].status, "ready");
    assert.equal(new Date(workRows[0].scheduled_for).toISOString(), secondTarget);
    assert.equal(workRows[0].payload.requires_live_check_passed, true);
    assert.equal(workRows[0].payload.requires_preflight_passed, true);
    assert.equal(workRows[0].payload.requires_gonza_approval, true);
    assert.equal(workRows[0].payload.launch_state_contract, "scheduled_launch_v2");
    assert.equal(workRows[0].payload.launch_generation, launchGeneration);
    assert.equal(workRows[0].payload.source_video_pipeline_item_id, sourceVideoPipelineItemId);
    assert.equal(workRows[0].payload.approval_status, "approved");
    assert.equal(workRows[0].payload.source_video_id, "yz-Dig_3ziQ");
    assert.equal(workRows[0].payload.notify_project_thread, false);
    assert.equal(workRows[0].payload.suppress_task_router_webhook, true);
    assert.equal(workRows[0].payload.runtime_retry_contract, "scheduled_launch_v2_retry_v1");
    assert.match(workRows[0].instruction, /privacyStatus=public\/live/);

    const afterRerun = (await pool.query("select status, scheduled_for, metadata from pipeline_items where id=$1", [id])).rows[0];
    assert.equal(afterRerun.status, "scheduled");
    assert.equal(new Date(afterRerun.scheduled_for).toISOString(), secondTarget);
    assert.equal(afterRerun.metadata.schedule.send_work_item_id, workRows[0].id);
  } finally {
    failure.armed = false;
    await cleanupPipeline(id);
  }
});

for (const config of [
  { label: "Guide", route: guideRoute, type: "guide", status: "draft", body: { action: "promote" }, target: "researching", relation: "investigate" },
  { label: "YouTube", route: youtubeRoute, type: "video", status: "idea", body: { action: "set_stage", stage: "title_thumbnail", note: "atomic" }, target: "title_thumbnail", relation: "youtube_light_research" },
]) {
  test(`${config.label} real local handler rolls back an injected late event failure, then retries and replays idempotently`, async () => {
    const id = randomUUID();
    await pool.query(
      `insert into pipeline_items (id, pipeline_type, title, status, priority, owner_agent, metadata) values ($1,$2,$3,$4,'medium','youtube','{}'::jsonb)`,
      [id, config.type, `Atomic ${config.label}`, config.status],
    );
    try {
      failure.eventTable = "event_log";
      failure.armed = true;
      await assert.rejects(() => config.route.POST(request(config.body), context(id)), /injected event_log failure/);
      assert.equal((await pool.query("select status from pipeline_items where id=$1", [id])).rows[0].status, config.status);
      assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1", [id])).rows[0].n, 0);
      assert.equal((await pool.query("select count(*)::int n from event_log where entity_id=$1", [id])).rows[0].n, 0);

      assert.equal((await config.route.POST(request(config.body), context(id))).status, 200);
      assert.equal((await config.route.POST(request(config.body), context(id))).status, 200);
      assert.equal((await pool.query("select status from pipeline_items where id=$1", [id])).rows[0].status, config.target);
      assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1 and payload->>'relation_type'=$2", [id, config.relation])).rows[0].n, 1);
      assert.equal((await pool.query("select count(*)::int n from event_log where entity_id=$1", [id])).rows[0].n, 1);
    } finally {
      failure.armed = false;
      await cleanupPipeline(id);
    }
  });
}

test("YouTube published handler keeps snapshots, announcement pipeline/work, item update and event in one transaction", async () => {
  const id = randomUUID();
  const body = { action: "set_stage", stage: "published", youtube_url: "https://youtu.be/atomic123", note: "ship" };
  await pool.query(
    `insert into pipeline_items (id,pipeline_type,title,status,priority,owner_agent,metadata) values ($1,'video',$2,'editing','medium','youtube','{}'::jsonb)`,
    [id, "Atomic published video"],
  );
  try {
    failure.eventTable = "event_log";
    failure.armed = true;
    await assert.rejects(() => youtubeRoute.POST(request(body), context(id)), /injected event_log failure/);
    assert.equal((await pool.query("select status from pipeline_items where id=$1", [id])).rows[0].status, "editing");
    assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1", [id])).rows[0].n, 0);
    assert.equal((await pool.query("select count(*)::int n from pipeline_items where source_id=$1", [id])).rows[0].n, 0);

    assert.equal((await youtubeRoute.POST(request(body), context(id))).status, 200);
    assert.equal((await youtubeRoute.POST(request(body), context(id))).status, 200);
    assert.equal((await pool.query("select status from pipeline_items where id=$1", [id])).rows[0].status, "published");
    assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1 and payload->>'action'='collect_youtube_snapshot'", [id])).rows[0].n, 3);
    const email = await pool.query("select id from pipeline_items where source_id=$1 and pipeline_type='email_campaign'", [id]);
    assert.equal(email.rowCount, 1);
    assert.equal((await pool.query("select count(*)::int n from work_items where source_id=$1 and payload->>'action'='draft_video_announcement'", [email.rows[0].id])).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int n from event_log where entity_id=$1", [id])).rows[0].n, 1);
  } finally {
    failure.armed = false;
    await pool.query("delete from pipeline_items where source_id=$1", [id]);
    await cleanupPipeline(id);
  }
});

test("Loop create real handler atomically persists entity+event and deduplicates replay", async () => {
  const input = `Atomic create ${randomUUID()}`;
  failure.eventTable = "loop_events";
  failure.armed = true;
  await assert.rejects(() => createLoopRoute.POST(request({ input })), /injected loop_events failure/);
  assert.equal((await pool.query("select count(*)::int n from loops where name=$1", [input])).rows[0].n, 0);

  const first = await createLoopRoute.POST(request({ input }));
  const replay = await createLoopRoute.POST(request({ input }));
  assert.equal(first.payload.loop.id, replay.payload.loop.id);
  try {
    assert.equal((await pool.query("select count(*)::int n from loops where name=$1", [input])).rows[0].n, 1);
    assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1 and event_type='loop.created'", [first.payload.loop.id])).rows[0].n, 1);
  } finally { await cleanupLoop(first.payload.loop.id); }
});

for (const config of [
  { label: "submit", route: submitLoopRoute, initial: "planning", body: {}, target: "needs_approval", event: "loop.ready_for_approval" },
  { label: "clarify", route: clarifyLoopRoute, initial: "needs_clarification", body: { response: "Use the safe option" }, target: "needs_approval", event: "loop.ready_for_approval" },
  { label: "approve", route: approveLoopRoute, initial: "needs_approval", body: { decision_id: randomUUID(), action: "approve", queue: true }, target: "queued", event: "loop.queued" },
]) {
  test(`Loop ${config.label} real handler locks state, rolls back event failure, and replays once`, async () => {
    const id = randomUUID();
    await pool.query(
      `insert into loops (id,key,name,status,clarification_questions,metadata,approval_scope) values ($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,'{}'::jsonb)`,
      [id, `atomic-${id}`, `Atomic ${config.label}`, config.initial, JSON.stringify(config.initial === "needs_clarification" ? [{ id: "q1", status: "open", question: "Which?" }] : [])],
    );
    try {
      failure.eventTable = "loop_events";
      failure.armed = true;
      await assert.rejects(() => config.route.POST(request(config.body), context(id)), /injected loop_events failure/);
      assert.equal((await pool.query("select status from loops where id=$1", [id])).rows[0].status, config.initial);
      assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1", [id])).rows[0].n, 0);

      assert.equal((await config.route.POST(request(config.body), context(id))).status, 200);
      assert.equal((await config.route.POST(request(config.body), context(id))).status, 200);
      assert.equal((await pool.query("select status from loops where id=$1", [id])).rows[0].status, config.target);
      assert.equal((await pool.query("select count(*)::int n from loop_events where loop_id=$1 and event_type=$2", [id, config.event])).rows[0].n, 1);
    } finally {
      failure.armed = false;
      await cleanupLoop(id);
    }
  });
}
