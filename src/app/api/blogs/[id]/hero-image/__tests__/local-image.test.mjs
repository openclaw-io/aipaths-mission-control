import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LocalImageError, readLocalImageFile, resolveLocalImageFile } from "../local-image.ts";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mission-control-image-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function expectImageError(action, status) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof LocalImageError);
    assert.equal(error.status, status);
    return true;
  });
}

describe("resolveLocalImageFile", () => {
  test("resolves a regular image under the real root", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "images");
    await mkdir(root);
    const candidate = path.join(root, "hero.PNG");
    await writeFile(candidate, Buffer.from("image"));

    const image = await readLocalImageFile(candidate, [root], 1024);

    assert.equal(image.path, await realpath(candidate));
    assert.equal(image.contentType, "image/png");
    assert.equal(image.size, 5);
    assert.equal(image.data.toString(), "image");
  });

  test("supports a symlinked root while comparing canonical paths", async () => {
    const parent = await makeTempDir();
    const realRoot = path.join(parent, "real-images");
    const linkedRoot = path.join(parent, "linked-images");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);
    const candidate = path.join(linkedRoot, "hero.webp");
    await writeFile(path.join(realRoot, "hero.webp"), Buffer.from("image"));

    const image = await resolveLocalImageFile(candidate, [linkedRoot], 1024);

    assert.equal(image.path, await realpath(path.join(realRoot, "hero.webp")));
    assert.equal(image.contentType, "image/webp");
  });

  test("rejects a candidate symlink that escapes an allowed root", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "images");
    const outside = path.join(parent, "outside.png");
    await mkdir(root);
    await writeFile(outside, Buffer.from("secret"));
    const candidate = path.join(root, "hero.png");
    await symlink(outside, candidate);

    await expectImageError(() => resolveLocalImageFile(candidate, [root], 1024), 403);
  });

  test("rejects directories and unsupported extensions", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "images");
    await mkdir(root);

    await expectImageError(() => resolveLocalImageFile(root, [root], 1024), 404);

    const candidate = path.join(root, "hero.svg");
    await writeFile(candidate, Buffer.from("<svg/>"));
    await expectImageError(() => resolveLocalImageFile(candidate, [root], 1024), 415);
  });

  test("rejects files over the configured size limit", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "images");
    await mkdir(root);
    const candidate = path.join(root, "hero.jpg");
    await writeFile(candidate, Buffer.alloc(11));

    await expectImageError(() => resolveLocalImageFile(candidate, [root], 10), 413);
  });
});
