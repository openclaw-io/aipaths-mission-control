import assert from "node:assert/strict";
import test from "node:test";

import {
  compactCommunityPipelineItem,
  compactEditorialPipelineItem,
} from "../../../src/lib/pipeline-items/compact-metadata.ts";

test("compactCommunityPipelineItem preserves compact fields from local nested metadata", () => {
  const item = compactCommunityPipelineItem({
    id: "community-1",
    metadata: {
      kind: "news",
      channel: "discord",
      destination_label: "News",
      target: { channel_id: "123", channel_name: "radar" },
      copy: { text: "Contenido real", poll_options: ["Sí", "No"] },
      source: { type: "intel", url: "https://example.com" },
      review: { notes: "ready" },
      runtime_feedback: { last_status: "draft_saved" },
      ignored_large_field: "do not serialize",
    },
  });

  assert.deepEqual(item.metadata, {
    kind: "news",
    channel: "discord",
    destination_label: "News",
    target: { channel_id: "123", channel_name: "radar" },
    copy: { text: "Contenido real", poll_options: ["Sí", "No"] },
    source: { type: "intel", url: "https://example.com" },
    review: { notes: "ready" },
    runtime_feedback: { last_status: "draft_saved" },
  });
});

test("compactEditorialPipelineItem preserves compact fields from local nested metadata", () => {
  const item = compactEditorialPipelineItem({
    id: "blog-1",
    metadata: {
      intel: { enriched_item_id: 42 },
      draft_summary: "Resumen real",
      draft_markdown: "# Full draft must stay lazy-loaded",
      localization: {
        en_ready: true,
        en: { slug: "english-slug", draft_markdown: "Full EN draft" },
      },
      hero_image: {
        url: "https://example.com/hero.png",
        status: "ready",
        width: 1200,
        height: 630,
        prompt: "large field omitted from list payload",
      },
      final_check: { status: "ready", notes: "large field omitted" },
      ignored_large_field: "do not serialize",
    },
  });

  assert.deepEqual(item.metadata, {
    intel: { enriched_item_id: 42 },
    draft_summary: "Resumen real",
    localization: { en_ready: true, en: { slug: "english-slug" } },
    hero_image: {
      url: "https://example.com/hero.png",
      status: "ready",
      width: 1200,
      height: 630,
    },
    final_check: { status: "ready" },
  });
});
