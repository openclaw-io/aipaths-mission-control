import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import pg from "pg";
import ts from "typescript";
import { requireMissionControlTestDatabaseUrl } from "../test-postgres-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const completionSource = resolve(repoRoot, "src/lib/work-items/completion-orchestration.ts");
const agentCompletionSource = resolve(repoRoot, "src/lib/work-items/agent-completion-local.ts");
const youtubeSource = resolve(repoRoot, "src/lib/youtube-pipeline.ts");
const youtubeLaunchSource = resolve(repoRoot, "src/lib/youtube-launch-package.ts");
const youtubeLaunchStateSource = resolve(repoRoot, "src/lib/youtube-launch-state.ts");
const externalDeliverySource = resolve(repoRoot, "src/lib/work-items/external-delivery.ts");
const scheduledLaunchRuntimeSource = resolve(repoRoot, "src/lib/work-items/scheduled-launch-runtime.ts");
const spanishFinalPackageSource = resolve(repoRoot, "src/lib/blogs/final-package.ts");

function transpileModule(sourcePath, requires = {}) {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
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
    Number,
    Set,
    JSON,
    String,
    RegExp,
    URL,
    Object,
    Array,
    Math,
    URL,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const youtubePipeline = transpileModule(youtubeSource);
const youtubeLaunchPackage = transpileModule(youtubeLaunchSource, {
  "node:crypto": { randomUUID },
  "@supabase/supabase-js": {},
});
const youtubeLaunchState = transpileModule(youtubeLaunchStateSource);
const externalDelivery = transpileModule(externalDeliverySource);
const scheduledLaunchRuntime = transpileModule(scheduledLaunchRuntimeSource);
const spanishFinalPackage = transpileModule(spanishFinalPackageSource, {
  "@/app/api/blogs/[id]/hero-image/local-image": {
    resolveLocalImageFile: async (candidate) => ({ path: candidate, size: 100, contentType: "image/png" }),
  },
  "@/lib/blogs/hero-image-roots": { allowedBlogHeroImageRoots: () => ["/approved"] },
});
const { orchestrateWorkItemCompletion, buildPublicationVerificationRequest } = transpileModule(completionSource, {
  "@/lib/youtube-pipeline": youtubePipeline,
  "@/lib/youtube-launch-package": youtubeLaunchPackage,
  "@/lib/youtube-launch-state": youtubeLaunchState,
  "@/lib/work-items/external-delivery": externalDelivery,
  "@/lib/work-items/scheduled-launch-runtime": scheduledLaunchRuntime,
  "@/lib/blogs/final-package": spanishFinalPackage,
  "@/lib/work-items/git-artifact": {
    verifyRepositoryCommit: async (repositoryPath, sha) => ({ repositoryPath, repositoryRoot: repositoryPath, sha }),
  },
});

const databaseUrl = requireMissionControlTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const agentCompletion = transpileModule(agentCompletionSource, {
  "@/lib/content/live-verification": {
    verifyPublishedContent: async () => {
      throw new Error("verification unavailable");
    },
  },
  "@/lib/db/mission-control": { normalizeRow: (row) => row },
  "@/lib/db/postgres": {
    query: (text, params) => pool.query(text, params),
    withTransaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await run(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  },
  "@/lib/work-items/completion-orchestration": { orchestrateWorkItemCompletion, buildPublicationVerificationRequest },
});

before(async () => {
  await pool.query("select 1 from public.work_items limit 1");
});

after(async () => {
  await pool.end();
});

async function inRollbackTransaction(run) {
  const client = await pool.connect();
  await client.query("begin");
  try {
    await run(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function insertPipelineItem(client, overrides = {}) {
  const id = randomUUID();
  const values = {
    pipeline_type: "community_post",
    title: "Test pipeline item",
    status: "draft",
    metadata: {},
    ...overrides,
  };
  const result = await client.query(
    `insert into public.pipeline_items
       (id, pipeline_type, title, slug, status, priority, owner_agent, requested_by,
        source_type, source_id, scheduled_for, published_at, current_url, content_body, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     returning *`,
    [
      id,
      values.pipeline_type,
      values.title,
      values.slug || null,
      values.status,
      values.priority || "medium",
      values.owner_agent || "test",
      values.requested_by || "test",
      values.source_type || "manual",
      values.source_id || null,
      values.scheduled_for || null,
      values.published_at || null,
      values.current_url || null,
      values.content_body || null,
      JSON.stringify(values.metadata),
    ],
  );
  return result.rows[0];
}

async function insertApprovedLaunchChildren(client, parentId, launchGeneration, publishAt) {
  for (const pipelineType of ["community_post", "email_campaign", "youtube_pinned_comment"]) {
    await insertPipelineItem(client, {
      pipeline_type: pipelineType,
      status: "ready_for_review",
      metadata: {
        launch_package: {
          kind: "scheduled_youtube_launch_package_v1",
          source_video_pipeline_item_id: parentId,
          launch_generation: launchGeneration,
          publish_at: publishAt,
        },
        review: { status: "approved", approved_by: "gonza", launch_generation: launchGeneration },
      },
    });
  }
}

async function insertWorkItem(client, pipelineItem, payloadOverrides = {}) {
  const id = randomUUID();
  const payload = {
    pipeline_type: pipelineItem.pipeline_type,
    pipeline_item_id: pipelineItem.id,
    relation_type: "draft",
    action: "develop_community_post",
    ...payloadOverrides,
  };
  const result = await client.query(
    `insert into public.work_items
       (id, kind, source_type, source_id, title, instruction, status, priority,
        owner_agent, target_agent_id, requested_by, payload)
     values ($1,'task','pipeline_item',$2,$3,'test','in_progress','medium',$4,$4,'test',$5::jsonb)
     returning *`,
    [id, pipelineItem.id, `Complete ${pipelineItem.title}`, payloadOverrides.owner_agent || "test", JSON.stringify(payload)],
  );
  return result.rows[0];
}

async function insertScheduledActivation(client, pipelineItem, { videoId, publishAt = "2026-08-01T10:00:00.000Z" }) {
  const launchGeneration = `youtube-launch-v1:${videoId}:${publishAt}`;
  const workItem = await insertWorkItem(client, pipelineItem, {
    trigger: "youtube_launch_package_v1",
    relation_type: "video_launch_activate",
    action: "video_launch_activate",
    source_video_pipeline_item_id: pipelineItem.id,
    pipeline_item_id: pipelineItem.id,
    video_id: videoId,
    publish_at: publishAt,
    launch_generation: launchGeneration,
  });
  const metadata = {
    ...(pipelineItem.metadata || {}),
    youtube_v0: { ...((pipelineItem.metadata || {}).youtube_v0 || {}), video_id: videoId },
    launch_package: {
      ...((pipelineItem.metadata || {}).launch_package || {}),
      kind: "scheduled_youtube_launch_package_v1",
      status: "scheduled",
      video_id: videoId,
      publish_at: publishAt,
      launch_generation: launchGeneration,
      activation_work_item_id: workItem.id,
      preflight: { status: "pass", checked_at: new Date(Date.now() - 120_000).toISOString() },
    },
  };
  await client.query("update public.pipeline_items set metadata=$1::jsonb where id=$2", [JSON.stringify(metadata), pipelineItem.id]);
  await client.query(
    "insert into public.pipeline_work_map (pipeline_item_id, work_item_id, relation_type) values ($1,$2,'followup')",
    [pipelineItem.id, workItem.id],
  );
  return { workItem, launchGeneration };
}

function completed(workItem) {
  return { ...workItem, status: "done", completed_at: new Date(), updated_at: new Date() };
}

const verifyPublishedContent = async ({ url }) => ({
  ok: true,
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  errors: [],
  checks: { reachable: true },
});

test("Spanish final-package completion persists ES and verified hero without mutating legacy localization", async () => {
  await inRollbackTransaction(async (client) => {
    const localization = { en_ready: false, en: { slug: "legacy-en", title: "Legacy" } };
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "blog",
      status: "localizing",
      content_body: "Borrador anterior",
      metadata: { localization, final_check: { status: "changes_requested" } },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "blog_final_package",
      action: "prepare_blog_final_package",
      contract: "spanish_final_package_v1",
    });

    const result = await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { final_package: {
        spanish_markdown: "# Paquete final ES\n\nContenido aprobado.",
        metadata_es: { locale: "es", title: "Título final", slug: "titulo-final" },
        hero_image: { media_path: "/approved/hero.png", width: 1200, height: 630 },
      } } },
      verifyPublishedContent,
    });

    assert.equal(result.effect, "spanish_blog_final_package_prepared");
    const row = (await client.query("select status,content_body,metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "final_check");
    assert.equal(row.content_body, "# Paquete final ES\n\nContenido aprobado.");
    assert.deepEqual(row.metadata.localization, localization);
    assert.equal(row.metadata.final_package.contract, "spanish_final_package_v1");
    assert.equal(row.metadata.final_package.metadata_es.locale, "es");
    assert.equal(row.metadata.final_package.hero_verified, true);
    assert.equal(row.metadata.hero_image.media_path, "/approved/hero.png");
    assert.equal(row.metadata.final_check.status, "ready");
  });
});

test("Spanish final-package completion fails closed on missing ES or hero and leaves the pipeline unchanged", async () => {
  await inRollbackTransaction(async (client) => {
    const metadata = { localization: { en_ready: false }, marker: "preserve" };
    const pipelineItem = await insertPipelineItem(client, { pipeline_type: "blog", status: "localizing", content_body: "Original", metadata });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "blog_final_package",
      action: "prepare_blog_final_package",
    });

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { final_package: {
          spanish_markdown: "# ES",
          metadata_es: { locale: "es", title: "Título" },
          hero_image: {},
        } } },
        verifyPublishedContent,
      }),
      /spanish_final_package_local_hero_required/,
    );

    const row = (await client.query("select status,content_body,metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "localizing");
    assert.equal(row.content_body, "Original");
    assert.deepEqual(row.metadata, metadata);
  });
});

test("legacy blog localization completion remains replay-compatible", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "blog",
      status: "localizing",
      content_body: "ES intacto",
      metadata: { localization: { en: { slug: "legacy" } }, marker: "preserve" },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "followup",
      action: "localize_blog_to_en",
    });

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { localization: { en: { slug: "legacy" } } } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status,content_body,metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "final_check");
    assert.equal(row.content_body, "ES intacto");
    assert.equal(row.metadata.localization.en_ready, true);
    assert.equal(row.metadata.localization.en.slug, "legacy");
    assert.equal(row.metadata.marker, "preserve");
    assert.equal(row.metadata.final_package, undefined);
  });
});

test("agent completion rolls work-item done and package writes back together when final-package validation fails", async () => {
  const pipelineId = randomUUID();
  const workItemId = randomUUID();
  await pool.query(
    "insert into pipeline_items (id,pipeline_type,title,status,content_body,metadata) values ($1,'blog','Atomic ES package','localizing','Original ES',$2::jsonb)",
    [pipelineId, JSON.stringify({ localization: { en_ready: false }, marker: "preserve" })],
  );
  await pool.query(
    `insert into work_items
       (id,kind,source_type,source_id,title,instruction,status,owner_agent,target_agent_id,payload)
     values ($1,'task','pipeline_item',$2,'Prepare ES package','test','in_progress','content','content',$3::jsonb)`,
    [workItemId, pipelineId, JSON.stringify({
      pipeline_type: "blog",
      pipeline_item_id: pipelineId,
      relation_type: "blog_final_package",
      action: "prepare_blog_final_package",
    })],
  );
  try {
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "done",
        output: { final_package: {
          spanish_markdown: "# Final ES",
          metadata_es: { locale: "es", title: "Final" },
          hero_image: {},
        } },
      }),
      /spanish_final_package_local_hero_required/,
    );
    const work = (await pool.query("select status,completed_at,payload from work_items where id=$1", [workItemId])).rows[0];
    const pipeline = (await pool.query("select status,content_body,metadata from pipeline_items where id=$1", [pipelineId])).rows[0];
    const events = await pool.query("select id from event_log where entity_id=$1", [workItemId]);
    assert.equal(work.status, "in_progress");
    assert.equal(work.completed_at, null);
    assert.equal(work.payload.output, undefined);
    assert.equal(pipeline.status, "localizing");
    assert.equal(pipeline.content_body, "Original ES");
    assert.equal(pipeline.metadata.marker, "preserve");
    assert.equal(events.rowCount, 0);
  } finally {
    await pool.query("delete from work_items where id=$1", [workItemId]);
    await pool.query("delete from pipeline_items where id=$1", [pipelineId]);
  }
});

test("community completion persists output copy and moves the pipeline card to ready_for_review", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, { metadata: { copy: { text: "" } } });
    const workItem = await insertWorkItem(client, pipelineItem);

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { copy: { text: "Copy final para Discord" } } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.equal(row.metadata.copy.text, "Copy final para Discord");
    assert.equal(row.metadata.runtime_feedback.last_status, "copy_saved");
  });
});

test("community video launch completion stays draft when playlist URL is missing", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "Dn1pJz5fq-w";
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pipelineItem = await insertPipelineItem(client, {
      metadata: {
        kind: "video_launch_announcement",
        source: { video_id: videoId, video_url: watchUrl, playlist_context_url: null },
        launch_package: {
          video_id: videoId,
          youtube_url: watchUrl,
          playlist_context_url: null,
          suppress_link_previews: false,
        },
        copy: { text: "" },
      },
    });
    const workItem = await insertWorkItem(client, pipelineItem);

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { copy: { text: `Nuevo video\n${watchUrl}` } } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "draft");
    assert.match(row.metadata.review.notes, /playlist_context_url.*required/i);
    assert.equal(row.metadata.runtime_feedback.last_status, "launch_validation_failed");
  });
});

test("community video launch completion reaches review with matching raw playlist URL", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "Dn1pJz5fq-w";
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const playlistContextUrl = `${watchUrl}&list=PLabc123`;
    const pipelineItem = await insertPipelineItem(client, {
      metadata: {
        kind: "video_launch_announcement",
        source: { video_id: videoId, video_url: watchUrl, playlist_context_url: playlistContextUrl },
        launch_package: {
          video_id: videoId,
          youtube_url: watchUrl,
          playlist_context_url: playlistContextUrl,
          suppress_link_previews: false,
        },
        copy: { text: "" },
      },
    });
    const workItem = await insertWorkItem(client, pipelineItem);

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { copy: { text: `Nuevo video\n${playlistContextUrl}` } } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.equal(row.metadata.runtime_feedback.last_status, "copy_saved");
  });
});

test("community scheduling creates one future publish work item and is replay-safe", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      status: "approved",
      metadata: { copy: { text: "Copy aprobada" }, kind: "news" },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "schedule",
      action: "schedule_community_post",
    });
    const body = { status: "done", output: { scheduled_for: "2026-08-03T12:00:00.000Z" } };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });
    await orchestrateWorkItemCompletion(client, {
      existing: completed(workItem),
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });

    const pipeline = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(pipeline.status, "scheduled");
    assert.equal(new Date(pipeline.metadata.schedule.scheduled_for).toISOString(), "2026-08-03T12:00:00.000Z");
    const publishWork = await client.query(
      "select id, scheduled_for, payload from public.work_items where source_id = $1 and payload ->> 'action' = 'publish_community_post'",
      [pipelineItem.id],
    );
    assert.equal(publishWork.rowCount, 1);
    assert.equal(new Date(publishWork.rows[0].scheduled_for).toISOString(), "2026-08-03T12:00:00.000Z");
    assert.equal(pipeline.metadata.schedule.publish_work_item_id, publishWork.rows[0].id);
  });
});

test("email_draft completion stores the draft and moves email_campaign to ready_for_review", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "email_campaign",
      status: "drafting",
      metadata: { kind: "video_announcement" },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "marketing_email_campaign",
      action: "draft_video_announcement",
    });
    const emailDraft = {
      subject: "Nuevo video de AIPaths",
      preview_text: "Una forma práctica de operar con IA",
      body_markdown: "Mirá el nuevo video.",
    };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { email_draft: emailDraft } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.deepEqual(row.metadata.draft, emailDraft);
    assert.equal(row.metadata.review.status, "ready_for_review");
  });
});

test("YouTube pinned comment draft completion stores text and moves to ready_for_review", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "youtube_pinned_comment",
      status: "drafting",
      metadata: { draft: {}, launch_package: { video_id: "PinDraft001" } },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "youtube_pinned_comment_draft",
      action: "draft_youtube_pinned_comment",
      owner_agent: "youtube",
    });
    const pinnedDraft = { text: "Comentá 'IA' y te paso el recurso.", status: "ready_for_review" };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { pinned_comment_draft: pinnedDraft } },
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "ready_for_review");
    assert.equal(row.metadata.draft.text, pinnedDraft.text);
    assert.equal(row.metadata.review.status, "ready_for_review");
    assert.equal(row.metadata.runtime_feedback.last_status, "pinned_comment_draft_saved");
  });
});

test("YouTube gate completion updates gate history once and derives terminal completion state", async () => {
  await inRollbackTransaction(async (client) => {
    const gates = Object.fromEntries(youtubePipeline.YOUTUBE_GATE_ORDER.map((key) => [key, { status: key === "postmortem" ? "not_started" : "pass", history: [] }]));
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "published",
      published_at: "2026-07-01T10:00:00.000Z",
      metadata: { gates, scores: { reach: 8, retention: 7, conversion: 6, confidence: 9 } },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "postmortem",
      action: "youtube_gate_postmortem",
      owner_agent: "youtube",
    });
    const body = { status: "done", gate_status: "pass", output: { evidence_summary: "Learning loop complete" } };

    await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });
    await orchestrateWorkItemCompletion(client, {
      existing: completed(workItem),
      updated: completed(workItem),
      body,
      verifyPublishedContent,
    });

    const row = (await client.query("select status, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "archived");
    assert.equal(row.metadata.gates.postmortem.status, "pass");
    assert.equal(row.metadata.gates.postmortem.evidence_summary, "Learning loop complete");
    assert.equal(row.metadata.gates.postmortem.history.length, 1);
  });
});

for (const pipelineType of ["blog", "guide"]) {
  test(`${pipelineType} publish completion verifies and persists live publication state`, async () => {
    await inRollbackTransaction(async (client) => {
      const pipelineItem = await insertPipelineItem(client, {
        pipeline_type: pipelineType,
        slug: `test-${pipelineType}`,
        status: "scheduled",
        metadata: { seo: { meta_description: `Test ${pipelineType}` } },
      });
      const workItem = await insertWorkItem(client, pipelineItem, {
        relation_type: "publish",
        action: pipelineType === "blog" ? "publish_blog" : "publish_guide",
        owner_agent: "dev",
      });
      const url = `https://aipaths.academy/${pipelineType}s/test-${pipelineType}`;

      const completionBody = { status: "done", current_url: url, published_at: "2026-07-26T10:00:00.000Z" };
      const verificationRequest = buildPublicationVerificationRequest(completed(workItem), pipelineItem, completionBody);
      await orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: completionBody,
        publicationVerification: {
          request: verificationRequest,
          result: await verifyPublishedContent({ url }),
          workItemId: workItem.id,
          workItemUpdatedAt: workItem.updated_at ? String(workItem.updated_at) : null,
          pipelineItemId: pipelineItem.id,
          pipelineItemUpdatedAt: pipelineItem.updated_at ? String(pipelineItem.updated_at) : null,
        },
      });

      const row = (await client.query("select status, current_url, published_at, metadata from public.pipeline_items where id = $1", [pipelineItem.id])).rows[0];
      assert.equal(row.status, "live");
      assert.equal(row.current_url, url);
      assert.equal(new Date(row.published_at).toISOString(), "2026-07-26T10:00:00.000Z");
      assert.equal(row.metadata.publication_verification.result.ok, true);

      if (pipelineType === "guide") {
        const announcement = await client.query(
          "select id, status from public.pipeline_items where pipeline_type = 'community_post' and source_id = $1",
          [pipelineItem.id],
        );
        assert.equal(announcement.rowCount, 1);
        const announcementWork = await client.query(
          "select id from public.work_items where source_id = $1 and payload ->> 'action' = 'draft_guide_announcement'",
          [announcement.rows[0].id],
        );
        assert.equal(announcementWork.rowCount, 1);
      }
    });
  });
}

test("publication completion rejects stale preflight evidence under the row lock before applying live state", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "blog",
      title: "CAS publication",
      slug: "cas-publication",
      status: "scheduled",
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "publish",
      action: "publish_blog",
      owner_agent: "dev",
    });
    const body = { status: "done", current_url: "https://aipaths.academy/blogs/cas-publication" };
    const updated = completed(workItem);
    const request = buildPublicationVerificationRequest(updated, pipelineItem, body);

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated,
        body,
        publicationVerification: {
          request,
          result: { ok: true, finalUrl: body.current_url },
          workItemId: workItem.id,
          workItemUpdatedAt: workItem.updated_at ? String(workItem.updated_at) : null,
          pipelineItemId: pipelineItem.id,
          pipelineItemUpdatedAt: "stale-version",
        },
      }),
      /verification snapshot changed/,
    );

    const row = (await client.query("select status, current_url from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.current_url, null);
  });
});

test("agent completion rolls the work item and pipeline effects back together when publication verification throws", async () => {
  const pipelineId = randomUUID();
  const workItemId = randomUUID();
  try {
    await pool.query(
      `insert into public.pipeline_items (id, pipeline_type, title, slug, status, metadata)
       values ($1, 'blog', 'Atomic publication test', 'atomic-publication-test', 'scheduled', '{}'::jsonb)`,
      [pipelineId],
    );
    await pool.query(
      `insert into public.work_items
         (id, kind, source_type, source_id, title, instruction, status, owner_agent, payload)
       values ($1, 'task', 'pipeline_item', $2, 'Publish atomic test', 'test', 'in_progress', 'dev', $3::jsonb)`,
      [workItemId, pipelineId, JSON.stringify({
        pipeline_type: "blog",
        pipeline_item_id: pipelineId,
        relation_type: "publish",
        action: "publish_blog",
      })],
    );

    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "done",
        current_url: "https://aipaths.academy/blogs/atomic-publication-test",
      }),
      /verification unavailable/,
    );

    const workItem = (await pool.query("select status, completed_at from public.work_items where id = $1", [workItemId])).rows[0];
    const pipelineItem = (await pool.query("select status, current_url from public.pipeline_items where id = $1", [pipelineId])).rows[0];
    const events = await pool.query("select id from public.event_log where entity_id = $1", [workItemId]);
    assert.equal(workItem.status, "in_progress");
    assert.equal(workItem.completed_at, null);
    assert.equal(pipelineItem.status, "scheduled");
    assert.equal(pipelineItem.current_url, null);
    assert.equal(events.rowCount, 0);
  } finally {
    await pool.query("delete from public.work_items where id = $1", [workItemId]);
    await pool.query("delete from public.pipeline_items where id = $1", [pipelineId]);
  }
});

test("agent endpoint rejects YouTube launch identity payload mutations before update", async () => {
  const pipelineId = randomUUID();
  const workItemId = randomUUID();
  await pool.query(
    "insert into public.pipeline_items (id,pipeline_type,title,status,metadata) values ($1,'video','Launch identity guard','scheduled','{}'::jsonb)",
    [pipelineId],
  );
  await pool.query(
    `insert into public.work_items
       (id,kind,source_type,source_id,title,instruction,status,owner_agent,target_agent_id,payload)
     values ($1,'task','pipeline_item',$2,'Activation guard','test','in_progress','strategist','strategist',$3::jsonb)`,
    [workItemId, pipelineId, JSON.stringify({
      trigger: "youtube_launch_package_v1",
      action: "video_launch_activate",
      relation_type: "video_launch_activate",
      pipeline_item_id: pipelineId,
      source_video_pipeline_item_id: pipelineId,
      launch_generation: "generation-1",
      publish_at: "2026-08-01T10:00:00.000Z",
    })],
  );
  try {
    await assert.rejects(
      () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
        status: "ready",
        payload_patch: { action: "develop_community_post", source_video_pipeline_item_id: randomUUID() },
      }),
      /youtube_launch_controlled_payload_mutation/,
    );
    const row = (await pool.query("select status,payload from public.work_items where id=$1", [workItemId])).rows[0];
    assert.equal(row.status, "in_progress");
    assert.equal(row.payload.action, "video_launch_activate");
    assert.equal(row.payload.source_video_pipeline_item_id, pipelineId);
  } finally {
    await pool.query("delete from public.work_items where id=$1", [workItemId]);
    await pool.query("delete from public.pipeline_items where id=$1", [pipelineId]);
  }
});

test("agent endpoint rejects every Scheduled Launch V2 identity, gate, retry and delivery mutation on derived external actions", async () => {
  const pipelineId = randomUUID();
  const controlled = {
    launch_state_contract: "attacker_contract",
    requires_preflight_passed: false,
    requires_live_check_passed: false,
    requires_gonza_approval: false,
    approval_status: "approved",
    runtime_retry_contract: "attacker_retry",
    external_delivery_idempotency_key: "attacker-key",
  };
  await pool.query(
    "insert into public.pipeline_items (id,pipeline_type,title,status,metadata) values ($1,'community_post','Derived launch guard','scheduled','{}'::jsonb)",
    [pipelineId],
  );
  try {
    for (const mutationField of ["payload_patch", "payload_increment"]) {
      const workItemId = randomUUID();
      await pool.query(
        `insert into public.work_items
           (id,kind,source_type,source_id,title,instruction,status,owner_agent,target_agent_id,payload)
         values ($1,'task','pipeline_item',$2,'Derived community publish','test','in_progress','community','community',$3::jsonb)`,
        [workItemId, pipelineId, JSON.stringify({
          trigger: "community_review_approved_scheduled",
          action: "publish_community_post",
          relation_type: "publish_community_post",
          pipeline_item_id: pipelineId,
          source_video_pipeline_item_id: randomUUID(),
          launch_state_contract: "scheduled_launch_v2",
          launch_generation: "generation-authoritative",
          publish_at: "2026-08-01T10:00:00.000Z",
          requires_preflight_passed: true,
          requires_live_check_passed: true,
          requires_gonza_approval: true,
          approval_status: "pending",
          runtime_retry_contract: "scheduled_launch_v2_retry_v1",
          external_delivery_idempotency_key: "ytlaunch:fixture:authoritative",
        })],
      );
      try {
        await assert.rejects(
          () => agentCompletion.patchAgentWorkItemWithCompletion(workItemId, {
            status: "ready",
            [mutationField]: controlled,
          }),
          /youtube_launch_controlled_payload_mutation/,
        );
        const row = (await pool.query("select status,payload from public.work_items where id=$1", [workItemId])).rows[0];
        assert.equal(row.status, "in_progress");
        for (const key of Object.keys(controlled)) assert.notEqual(row.payload[key], controlled[key]);
      } finally {
        await pool.query("delete from public.work_items where id=$1", [workItemId]);
      }
    }
  } finally {
    await pool.query("delete from public.pipeline_items where id=$1", [pipelineId]);
  }
});

test("YouTube launch preflight completion persists pass evidence on the scheduled parent", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "Preflight01";
    const checkedAt = new Date().toISOString();
    const publishAt = new Date(Date.now() + 29 * 60_000).toISOString();
    const launchGeneration = `youtube-launch-v1:${videoId}:${publishAt}:fixture`;
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: publishAt,
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: videoId, playlist_id: "PLabc123" },
        launch_package: {
          kind: "scheduled_youtube_launch_package_v1",
          status: "scheduled",
          video_id: videoId,
          youtube_url: publicUrl,
          playlist_id: "PLabc123",
          publish_at: publishAt,
          launch_generation: launchGeneration,
        },
      },
    });
    await insertApprovedLaunchChildren(client, pipelineItem.id, launchGeneration, publishAt);
    const workItem = await insertWorkItem(client, pipelineItem, {
      trigger: "youtube_launch_package_v1",
      relation_type: "youtube_launch_preflight",
      action: "youtube_launch_preflight",
      source_video_pipeline_item_id: pipelineItem.id,
      pipeline_item_id: pipelineItem.id,
      video_id: videoId,
      publish_at: publishAt,
      launch_generation: launchGeneration,
    });

    const result = await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: { status: "done", output: { preflight: {
        status: "pass",
        checked_at: checkedAt,
        evidence: {
          video_id: videoId,
          canonical_url: publicUrl,
          privacy_status: "private",
          scheduled_publish_at: publishAt,
          playlist: { playlist_id: "PLabc123", contains_video: true },
          approvals: {
            community: { status: "approved" },
            marketing: { status: "approved" },
            pinned_comment: { status: "manual_out_of_scope", manual_out_of_scope: true },
          },
          runtime_health: { status: "healthy" },
          summary: "Preflight passed",
        },
      } } },
      verifyPublishedContent,
    });

    assert.equal(result.effect, "youtube_launch_preflight_passed");
    const row = (await client.query("select status, metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.metadata.launch_package.launch_state, "scheduled");
    assert.equal(row.metadata.launch_package.preflight.status, "pass");
    assert.equal(row.metadata.runtime_feedback.last_status, "youtube_launch_preflight_passed");
  });
});

test("blocked preflight is recoverable through remediation, requeue and a passing rerun", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "Preflight02";
    const checkedAt = new Date().toISOString();
    const publishAt = new Date(Date.now() + 29 * 60_000).toISOString();
    const launchGeneration = `youtube-launch-v1:${videoId}:${publishAt}:fixture`;
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: publishAt,
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: videoId, playlist_id: "PLabc123" },
        launch_package: {
          kind: "scheduled_youtube_launch_package_v1",
          status: "scheduled",
          video_id: videoId,
          youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
          playlist_id: "PLabc123",
          publish_at: publishAt,
          launch_generation: launchGeneration,
        },
      },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      trigger: "youtube_launch_package_v1",
      launch_state_contract: "scheduled_launch_v2",
      relation_type: "youtube_launch_preflight",
      action: "youtube_launch_preflight",
      source_video_pipeline_item_id: pipelineItem.id,
      pipeline_item_id: pipelineItem.id,
      video_id: videoId,
      publish_at: publishAt,
      launch_generation: launchGeneration,
    });
    await client.query("update work_items set status='done',completed_at=now() where id=$1", [workItem.id]);

    const blockedBody = { status: "done", output: { preflight: {
      status: "blocked",
      checked_at: checkedAt,
      blockers: ["thumbnail_not_ready"],
      approvals: {
        community: { status: "approved" },
        marketing: { status: "approved" },
        pinned_comment: { status: "manual_out_of_scope" },
      },
      evidence: { video_id: videoId },
    } } };
    const blockedResult = await orchestrateWorkItemCompletion(client, {
      existing: workItem,
      updated: completed(workItem),
      body: blockedBody,
      verifyPublishedContent,
    });

    assert.equal(blockedResult.effect, "youtube_launch_preflight_blocked");
    const blockedWork = (await client.query("select status,completed_at,payload from work_items where id=$1", [workItem.id])).rows[0];
    assert.equal(blockedWork.status, "blocked");
    assert.equal(blockedWork.completed_at, null);
    assert.equal(blockedWork.payload.dispatch_state, "blocked_launch_gate");
    assert.match(blockedWork.payload.remediation, /rerun.*preflight/i);
    assert.equal(blockedWork.payload.dead_letter_reason, "youtube_launch_preflight_blocked");

    await insertApprovedLaunchChildren(client, pipelineItem.id, launchGeneration, publishAt);
    await client.query(
      `update work_items set status='ready',completed_at=null,
         payload=payload || '{"dispatch_state":"ready_after_manual_requeue"}'::jsonb where id=$1`,
      [workItem.id],
    );
    const requeued = (await client.query("select * from work_items where id=$1", [workItem.id])).rows[0];
    await client.query("update work_items set status='done',completed_at=now() where id=$1", [workItem.id]);
    const passBody = { status: "done", output: { preflight: {
      status: "pass",
      checked_at: checkedAt,
      evidence: {
        video_id: videoId,
        canonical_url: `https://www.youtube.com/watch?v=${videoId}`,
        privacy_status: "private",
        scheduled_publish_at: publishAt,
        playlist: { playlist_id: "PLabc123", contains_video: true },
        runtime_health: { status: "healthy" },
      },
    } } };
    const passedResult = await orchestrateWorkItemCompletion(client, {
      existing: requeued,
      updated: completed(requeued),
      body: passBody,
      verifyPublishedContent,
    });

    assert.equal(passedResult.effect, "youtube_launch_preflight_passed");
    const passedWork = (await client.query("select status from work_items where id=$1", [workItem.id])).rows[0];
    const parent = (await client.query("select status,published_at,current_url,metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(passedWork.status, "done");
    assert.equal(parent.status, "scheduled");
    assert.equal(parent.published_at, null);
    assert.equal(parent.current_url, null);
    assert.equal(parent.metadata.launch_package.launch_state, "scheduled");
    assert.equal(parent.metadata.launch_package.preflight.status, "pass");
  });
});

test("YouTube live-check publishes the exact scheduled parent once with public evidence", async () => {
  await inRollbackTransaction(async (client) => {
    const publishAt = new Date(Date.now() - 60_000).toISOString();
    const checkedAt = new Date(Date.now() - 30_000).toISOString();
    const publicUrl = "https://www.youtube.com/watch?v=LiveCheck01";
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: publishAt,
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: "LiveCheck01" },
        launch_package: { kind: "scheduled_youtube_launch_package_v1", status: "scheduled" },
      },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId: "LiveCheck01", publishAt });
    const body = { status: "done", output: { live_check: {
      status: "public",
      checked_at: checkedAt,
      public_url: publicUrl,
      launch_generation: launchGeneration,
      evidence: { source: "youtube_data_api", video_id: "LiveCheck01", visibility: "public", public_url: publicUrl },
    } } };

    const first = await orchestrateWorkItemCompletion(client, {
      existing: workItem, updated: completed(workItem), body, verifyPublishedContent,
    });
    const second = await orchestrateWorkItemCompletion(client, {
      existing: completed(workItem), updated: completed(workItem), body, verifyPublishedContent,
    });

    assert.equal(first.effect, "youtube_launch_activated");
    assert.equal(second.applied, false);
    const row = (await client.query("select status, published_at, current_url, metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "published");
    assert.equal(row.current_url, publicUrl);
    assert.ok(row.published_at);
    assert.equal(row.metadata.youtube_v0.stage, "published");
    assert.equal(row.metadata.launch_package.status, "activated");
    assert.equal(row.metadata.launch_package.public_verified, true);

    const fanout = await client.query(
      `select id from work_items
        where source_id=$1
          and (payload->>'trigger'='video_published_manual'
            or payload->>'action' in ('draft_video_announcement','collect_youtube_snapshot'))`,
      [pipelineItem.id],
    );
    assert.equal(fanout.rowCount, 0);
  });
});

test("YouTube live-check cannot activate early with future evidence", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "EarlyGate01";
    const publishAt = new Date(Date.now() + (30 * 60 * 1000)).toISOString();
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: publishAt,
      metadata: { youtube_v0: { stage: "scheduled", video_id: videoId } },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId, publishAt });

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: {
          status: "public",
          checked_at: publishAt,
          public_url: publicUrl,
          launch_generation: launchGeneration,
          evidence: { source: "youtube_data_api", video_id: videoId, visibility: "public", public_url: publicUrl },
        } } },
        verifyPublishedContent,
      }),
      /cannot activate before the scheduled publish time/i,
    );

    const row = (await client.query("select status,published_at,current_url from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.published_at, null);
    assert.equal(row.current_url, null);
  });
});

test("YouTube live-check rejects duplicate open activation identities", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "Duplicate01";
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: "2026-08-01T10:00:00.000Z",
      metadata: { youtube_v0: { stage: "scheduled", video_id: videoId } },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId });
    await insertWorkItem(client, pipelineItem, {
      trigger: "youtube_launch_package_v1",
      relation_type: "video_launch_activate",
      action: "video_launch_activate",
      source_video_pipeline_item_id: pipelineItem.id,
      pipeline_item_id: pipelineItem.id,
      video_id: videoId,
      publish_at: "2026-08-01T10:00:00.000Z",
      launch_generation: launchGeneration,
    });
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: {
          status: "public",
          checked_at: "2026-08-01T10:02:00.000Z",
          public_url: publicUrl,
          launch_generation: launchGeneration,
          evidence: { source: "youtube_data_api", video_id: videoId, visibility: "public", public_url: publicUrl },
        } } },
        verifyPublishedContent,
      }),
      /exactly one current activation/i,
    );
    const row = (await client.query("select status,published_at from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.published_at, null);
  });
});

test("YouTube live-check without public URL/evidence fails closed and leaves scheduled parent unchanged", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: "NoEvidence1" },
        launch_package: { kind: "scheduled_youtube_launch_package_v1", status: "scheduled" },
      },
    });
    const { workItem } = await insertScheduledActivation(client, pipelineItem, { videoId: "NoEvidence1" });

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: { status: "public" } } },
        verifyPublishedContent,
      }),
      /public URL and structured evidence/i,
    );
    const row = (await client.query("select status, published_at, current_url, metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.published_at, null);
    assert.equal(row.current_url, null);
    assert.equal(row.metadata.launch_package.status, "scheduled");
  });
});

test("YouTube live-check rejects a different video URL and does not publish", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: "2026-08-01T10:00:00.000Z",
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: "Expected001" },
        launch_package: { kind: "scheduled_youtube_launch_package_v1", status: "scheduled", video_id: "Expected001" },
      },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId: "Expected001" });
    const wrongUrl = "https://www.youtube.com/watch?v=Different01";

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: {
          status: "public",
          checked_at: "2026-08-01T10:02:00.000Z",
          public_url: wrongUrl,
          launch_generation: launchGeneration,
          evidence: { source: "youtube_data_api", video_id: "Different01", visibility: "public", public_url: wrongUrl },
        } } },
        verifyPublishedContent,
      }),
      /expected YouTube video/i,
    );

    const row = (await client.query("select status, published_at, current_url from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.published_at, null);
    assert.equal(row.current_url, null);
  });
});

test("YouTube live-check rejects evidence outside the current launch verification window", async () => {
  await inRollbackTransaction(async (client) => {
    const videoId = "WindowTest1";
    const publishAt = new Date(Date.now() - (8 * 60 * 60 * 1000)).toISOString();
    const checkedAt = new Date(Date.now() - (60 * 1000)).toISOString();
    const publicUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "scheduled",
      scheduled_for: publishAt,
      metadata: { youtube_v0: { stage: "scheduled", video_id: videoId } },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId, publishAt });
    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: {
          status: "public",
          checked_at: checkedAt,
          public_url: publicUrl,
          launch_generation: launchGeneration,
          evidence: { source: "youtube_data_api", video_id: videoId, visibility: "public", public_url: publicUrl },
        } } },
        verifyPublishedContent,
      }),
      /verification window/i,
    );
    const row = (await client.query("select status,published_at from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "scheduled");
    assert.equal(row.published_at, null);
  });
});

test("stale YouTube activation cannot publish a parked parent", async () => {
  await inRollbackTransaction(async (client) => {
    const publicUrl = "https://www.youtube.com/watch?v=Expected001";
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "parked",
      scheduled_for: "2026-08-01T10:00:00.000Z",
      metadata: {
        youtube_v0: { stage: "scheduled", video_id: "Expected001" },
        launch_package: { kind: "scheduled_youtube_launch_package_v1", status: "scheduled", video_id: "Expected001" },
      },
    });
    const { workItem, launchGeneration } = await insertScheduledActivation(client, pipelineItem, { videoId: "Expected001" });

    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", output: { live_check: {
          status: "public",
          checked_at: "2026-08-01T10:02:00.000Z",
          public_url: publicUrl,
          launch_generation: launchGeneration,
          evidence: { source: "youtube_data_api", video_id: "Expected001", visibility: "public", public_url: publicUrl },
        } } },
        verifyPublishedContent,
      }),
      /requires an active scheduled parent/i,
    );

    const row = (await client.query("select status, published_at from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "parked");
    assert.equal(row.published_at, null);
  });
});

test("legacy YouTube gate completion is rejected for an active scheduled launch", async () => {
  await inRollbackTransaction(async (client) => {
    const pipelineItem = await insertPipelineItem(client, {
      pipeline_type: "video",
      status: "editing",
      metadata: {
        gates: { strategic_fit: { status: "not_started", history: [] } },
        launch_package: { kind: "scheduled_youtube_launch_package_v1", status: "scheduled" },
      },
    });
    const workItem = await insertWorkItem(client, pipelineItem, {
      relation_type: "strategic_fit",
      action: "youtube_gate_strategic_fit",
      owner_agent: "youtube",
    });
    await assert.rejects(
      () => orchestrateWorkItemCompletion(client, {
        existing: workItem,
        updated: completed(workItem),
        body: { status: "done", gate_status: "in_progress" },
        verifyPublishedContent,
      }),
      /reject legacy gate transitions/i,
    );
    const row = (await client.query("select status,metadata from pipeline_items where id=$1", [pipelineItem.id])).rows[0];
    assert.equal(row.status, "editing");
    assert.equal(row.metadata.gates.strategic_fit.status, "not_started");
  });
});
