const BASE_PIPELINE_SELECT =
  "id,pipeline_type,title,slug,status,priority,owner_agent,requested_by,source_type,source_id,scheduled_for,published_at,current_url,content_path,content_format,created_at,updated_at";

const EDITORIAL_METADATA_SELECT = [
  "intel_enriched_item_id:metadata->intel->>enriched_item_id",
  "draft_summary:metadata->>draft_summary",
  "localization_en_ready:metadata->localization->>en_ready",
  "localization_en_slug:metadata->localization->en->>slug",
  "hero_image_url:metadata->hero_image->>url",
  "hero_image_media_path:metadata->hero_image->>media_path",
  "hero_image_local_path:metadata->hero_image->>local_path",
  "hero_image_path:metadata->hero_image->>path",
  "hero_image_status:metadata->hero_image->>status",
  "hero_image_width:metadata->hero_image->>width",
  "hero_image_height:metadata->hero_image->>height",
  "hero_image_aspect_ratio:metadata->hero_image->>aspect_ratio",
  "cover_image_url:metadata->cover_image->>url",
  "cover_image_media_path:metadata->cover_image->>media_path",
  "cover_image_local_path:metadata->cover_image->>local_path",
  "cover_image_path:metadata->cover_image->>path",
  "cover_image_status:metadata->cover_image->>status",
  "cover_image_width:metadata->cover_image->>width",
  "cover_image_height:metadata->cover_image->>height",
  "cover_image_aspect_ratio:metadata->cover_image->>aspect_ratio",
  "final_check_status:metadata->final_check->>status",
].join(",");

const COMMUNITY_METADATA_SELECT = [
  "community_kind:metadata->>kind",
  "community_channel:metadata->>channel",
  "community_target:metadata->target",
  "community_copy:metadata->copy",
  "community_source:metadata->source",
  "community_legacy:metadata->legacy",
  "community_review:metadata->review",
  "community_runtime_feedback:metadata->runtime_feedback",
  "intel_destination_key:metadata->>intel_destination_key",
  "destination_label:metadata->>destination_label",
  "community_intel:metadata->intel",
].join(",");

const EDITORIAL_KEYS = [
  "intel_enriched_item_id",
  "draft_summary",
  "localization_en_ready",
  "localization_en_slug",
  "hero_image_url",
  "hero_image_media_path",
  "hero_image_local_path",
  "hero_image_path",
  "hero_image_status",
  "hero_image_width",
  "hero_image_height",
  "hero_image_aspect_ratio",
  "cover_image_url",
  "cover_image_media_path",
  "cover_image_local_path",
  "cover_image_path",
  "cover_image_status",
  "cover_image_width",
  "cover_image_height",
  "cover_image_aspect_ratio",
  "final_check_status",
] as const;

const COMMUNITY_KEYS = [
  "community_kind",
  "community_channel",
  "community_target",
  "community_copy",
  "community_source",
  "community_legacy",
  "community_review",
  "community_runtime_feedback",
  "intel_destination_key",
  "destination_label",
  "community_intel",
] as const;

export const COMPACT_EDITORIAL_PIPELINE_SELECT = `${BASE_PIPELINE_SELECT},${EDITORIAL_METADATA_SELECT}`;
export const COMPACT_COMMUNITY_PIPELINE_SELECT = `${BASE_PIPELINE_SELECT},${COMMUNITY_METADATA_SELECT}`;

function assignIfPresent(target: Record<string, unknown>, key: string, value: unknown) {
  if (value == null || value === "") return;
  target[key] = value;
}

function numberOrUndefined(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function booleanOrUndefined(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function nestedObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function compactHero(row: Record<string, unknown>, prefix: "hero_image" | "cover_image") {
  const image: Record<string, unknown> = {};
  assignIfPresent(image, "url", row[`${prefix}_url`]);
  assignIfPresent(image, "media_path", row[`${prefix}_media_path`]);
  assignIfPresent(image, "local_path", row[`${prefix}_local_path`]);
  assignIfPresent(image, "path", row[`${prefix}_path`]);
  assignIfPresent(image, "status", row[`${prefix}_status`]);
  assignIfPresent(image, "aspect_ratio", row[`${prefix}_aspect_ratio`]);

  const width = numberOrUndefined(row[`${prefix}_width`]);
  const height = numberOrUndefined(row[`${prefix}_height`]);
  if (width !== undefined) image.width = width;
  if (height !== undefined) image.height = height;

  return Object.keys(image).length > 0 ? image : null;
}

export function compactEditorialPipelineItem<T extends Record<string, unknown>>(row: T): T & { metadata: Record<string, unknown> | null } {
  const item = { ...row } as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};

  if (row.intel_enriched_item_id != null) {
    metadata.intel = { enriched_item_id: row.intel_enriched_item_id };
  }
  assignIfPresent(metadata, "draft_summary", row.draft_summary);

  const localization: Record<string, unknown> = {};
  const enReady = booleanOrUndefined(row.localization_en_ready);
  if (enReady !== undefined) localization.en_ready = enReady;
  if (row.localization_en_slug) localization.en = { slug: row.localization_en_slug };
  if (Object.keys(localization).length > 0) metadata.localization = localization;

  const heroImage = compactHero(row, "hero_image");
  const coverImage = compactHero(row, "cover_image");
  if (heroImage) metadata.hero_image = heroImage;
  if (coverImage) metadata.cover_image = coverImage;
  if (row.final_check_status) metadata.final_check = { status: row.final_check_status };

  for (const key of EDITORIAL_KEYS) delete item[key];
  item.metadata = Object.keys(metadata).length > 0 ? metadata : null;
  return item as T & { metadata: Record<string, unknown> | null };
}

export function compactCommunityPipelineItem<T extends Record<string, unknown>>(row: T): T & { metadata: Record<string, unknown> | null } {
  const item = { ...row } as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};

  assignIfPresent(metadata, "kind", row.community_kind);
  assignIfPresent(metadata, "channel", row.community_channel);
  assignIfPresent(metadata, "intel_destination_key", row.intel_destination_key);
  assignIfPresent(metadata, "destination_label", row.destination_label);

  const objectFields: Array<[string, unknown]> = [
    ["target", row.community_target],
    ["copy", row.community_copy],
    ["source", row.community_source],
    ["legacy", row.community_legacy],
    ["review", row.community_review],
    ["runtime_feedback", row.community_runtime_feedback],
    ["intel", row.community_intel],
  ];
  for (const [key, value] of objectFields) {
    const objectValue = nestedObject(value);
    if (objectValue && Object.keys(objectValue).length > 0) metadata[key] = objectValue;
  }

  for (const key of COMMUNITY_KEYS) delete item[key];
  item.metadata = Object.keys(metadata).length > 0 ? metadata : null;
  return item as T & { metadata: Record<string, unknown> | null };
}
