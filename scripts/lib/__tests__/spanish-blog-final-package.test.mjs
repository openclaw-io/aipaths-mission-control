import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/blogs/final-package.ts");
const notifySource = readFileSync(resolve(repoRoot, "src/app/api/work-items/notify/route.ts"), "utf8");
const resolvedCandidates = [];

const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;
const cjsModule = { exports: {} };
vm.runInNewContext(transpiled, {
  module: cjsModule,
  exports: cjsModule.exports,
  require(specifier) {
    if (specifier === "@/app/api/blogs/[id]/hero-image/local-image") {
      return { resolveLocalImageFile: async (candidate, roots) => {
        resolvedCandidates.push({ candidate, roots });
        return { path: candidate, size: 123, contentType: "image/png" };
      } };
    }
    if (specifier === "@/lib/blogs/hero-image-roots") return { allowedBlogHeroImageRoots: () => ["/approved"] };
    throw new Error(`Unexpected require: ${specifier}`);
  },
  process: { env: {} },
  Error,
  Object,
  Array,
  String,
}, { filename: sourcePath });

const contract = cjsModule.exports;

test("Spanish final package gate is explicit and disabled by default", () => {
  assert.equal(contract.spanishBlogFinalPackageEnabled({}), false);
  assert.equal(contract.spanishBlogFinalPackageEnabled({ SPANISH_ONLY_BLOG_FINAL_PACKAGE_ENABLED: "1" }), false);
  assert.equal(contract.spanishBlogFinalPackageEnabled({ SPANISH_ONLY_BLOG_FINAL_PACKAGE_ENABLED: "true" }), true);
});

test("Spanish final package parser requires structured ES metadata and local hero", () => {
  const parsed = contract.parseSpanishBlogFinalPackageOutput({ output: { final_package: {
    spanish_markdown: "# Final ES",
    metadata_es: { locale: "es", title: "Título", slug: "titulo" },
    hero_image: { media_path: "/approved/hero.png" },
  } } });
  assert.equal(parsed.spanishMarkdown, "# Final ES");
  assert.equal(parsed.metadataEs.locale, "es");
  assert.equal(parsed.heroPath, "/approved/hero.png");

  assert.throws(() => contract.parseSpanishBlogFinalPackageOutput({ output: { final_package: {
    spanish_markdown: "# ES", metadata_es: { locale: "en", title: "Wrong" }, hero_image: { media_path: "/approved/hero.png" },
  } } }), /metadata_es_required/);
  assert.throws(() => contract.parseSpanishBlogFinalPackageOutput({ output: { final_package: {
    spanish_markdown: "# ES", metadata_es: { locale: "es", title: "Título" }, hero_image: { url: "https://example.test/hero.png" },
  } } }), /local_hero_required/);
});

test("Spanish final package readiness and hero verification share the local allowlist", async () => {
  const item = {
    content_body: "# Final ES",
    metadata: {
      final_package: {
        contract: "spanish_final_package_v1",
        metadata_es: { locale: "es", title: "Título final" },
        hero_verified: true,
      },
      hero_image: { local_path: "/approved/hero.png" },
    },
  };
  assert.equal(contract.spanishBlogFinalPackageReady(item), true);
  await contract.assertSpanishBlogFinalPackageReady(item);
  assert.deepEqual(resolvedCandidates.at(-1), { candidate: "/approved/hero.png", roots: ["/approved"] });
});

test("Spanish final package readiness fails closed when structured ES metadata drifts", async () => {
  const baseItem = {
    content_body: "# Final ES",
    metadata: {
      final_package: {
        contract: "spanish_final_package_v1",
        metadata_es: { locale: "es", title: "Título final" },
        hero_verified: true,
      },
      hero_image: { local_path: "/approved/hero.png" },
    },
  };

  const wrongLocale = structuredClone(baseItem);
  wrongLocale.metadata.final_package.metadata_es.locale = "en";
  assert.equal(contract.spanishBlogFinalPackageReady(wrongLocale), false);
  await assert.rejects(contract.assertSpanishBlogFinalPackageReady(wrongLocale), /not_ready/);

  const missingTitle = structuredClone(baseItem);
  missingTitle.metadata.final_package.metadata_es.title = " ";
  assert.equal(contract.spanishBlogFinalPackageReady(missingTitle), false);
  await assert.rejects(contract.assertSpanishBlogFinalPackageReady(missingTitle), /not_ready/);
});

test("notifier completion command requires the structured final-package JSON file", () => {
  assert.match(notifySource, /workPayload\?\.action === "prepare_blog_final_package"/);
  assert.match(notifySource, /SPANISH_FINAL_PACKAGE_COMPLETION_JSON/);
  assert.match(notifySource, /--data-binary/);
  assert.match(notifySource, /"final_package"/);
});
