import { resolveLocalImageFile } from "@/app/api/blogs/[id]/hero-image/local-image";
import { allowedBlogHeroImageRoots } from "@/lib/blogs/hero-image-roots";

export const SPANISH_BLOG_FINAL_PACKAGE_ACTION = "prepare_blog_final_package";
export const SPANISH_BLOG_FINAL_PACKAGE_RELATION = "blog_final_package";
export const SPANISH_BLOG_FINAL_PACKAGE_CONTRACT = "spanish_final_package_v1";

type JsonRecord = Record<string, unknown>;

export type SpanishBlogFinalPackage = {
  spanishMarkdown: string;
  metadataEs: JsonRecord & { locale: "es"; title: string };
  heroImage: JsonRecord;
  heroPath: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function heroPathFromRecord(hero: JsonRecord) {
  return readString(hero.media_path) || readString(hero.local_path) || readString(hero.path);
}

export function spanishBlogFinalPackageEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.SPANISH_ONLY_BLOG_FINAL_PACKAGE_ENABLED === "true";
}

export function parseSpanishBlogFinalPackageOutput(body: JsonRecord): SpanishBlogFinalPackage {
  const output = asRecord(body.output);
  const finalPackage = asRecord(output.final_package);
  const spanishMarkdown = readString(finalPackage.spanish_markdown);
  const metadataEs = asRecord(finalPackage.metadata_es);
  const title = readString(metadataEs.title);
  const heroImage = asRecord(finalPackage.hero_image);
  const heroPath = heroPathFromRecord(heroImage);

  if (!spanishMarkdown) throw new Error("spanish_final_package_markdown_required");
  if (metadataEs.locale !== "es" || !title) throw new Error("spanish_final_package_metadata_es_required");
  if (!heroPath) throw new Error("spanish_final_package_local_hero_required");

  return {
    spanishMarkdown,
    metadataEs: { ...metadataEs, locale: "es", title },
    heroImage,
    heroPath,
  };
}

export async function assertSpanishBlogHeroResolvable(heroPath: string) {
  return resolveLocalImageFile(heroPath, allowedBlogHeroImageRoots());
}

export function spanishBlogFinalPackageReady(item: { content_body?: unknown; metadata?: unknown }) {
  const metadata = asRecord(item.metadata);
  const finalPackage = asRecord(metadata.final_package);
  const metadataEs = asRecord(finalPackage.metadata_es);
  const heroImage = asRecord(metadata.hero_image);
  return readString(item.content_body) !== null
    && finalPackage.contract === SPANISH_BLOG_FINAL_PACKAGE_CONTRACT
    && metadataEs.locale === "es"
    && readString(metadataEs.title) !== null
    && finalPackage.hero_verified === true
    && heroPathFromRecord(heroImage) !== null;
}

export async function assertSpanishBlogFinalPackageReady(item: { content_body?: unknown; metadata?: unknown }) {
  if (!spanishBlogFinalPackageReady(item)) throw new Error("spanish_final_package_not_ready");
  const heroPath = heroPathFromRecord(asRecord(asRecord(item.metadata).hero_image));
  if (!heroPath) throw new Error("spanish_final_package_local_hero_required");
  await assertSpanishBlogHeroResolvable(heroPath);
}
