import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_LOCAL_IMAGE_SIZE = 10_485_760;

const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export class LocalImageError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LocalImageError";
    this.status = status;
  }
}

export interface ResolvedLocalImage {
  path: string;
  size: number;
  contentType: string;
}

function isWithinRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function imageErrorForFileSystemError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";

  if (code === "ELOOP") {
    return new LocalImageError("Hero image path is not allowed", 403);
  }
  return new LocalImageError("Hero image file not found", 404);
}

export async function resolveLocalImageFile(
  candidate: string,
  allowedRoots: readonly string[],
  maxSize = MAX_LOCAL_IMAGE_SIZE,
): Promise<ResolvedLocalImage> {
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    throw imageErrorForFileSystemError(error);
  }

  const canonicalRoots = (
    await Promise.all(allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return null;
      }
    }))
  ).filter((root): root is string => root !== null);

  if (!canonicalRoots.some((root) => isWithinRoot(canonicalCandidate, root))) {
    throw new LocalImageError("Hero image path is not allowed", 403);
  }

  let fileStat;
  try {
    fileStat = await stat(canonicalCandidate);
  } catch (error) {
    throw imageErrorForFileSystemError(error);
  }

  if (!fileStat.isFile()) {
    throw new LocalImageError("Hero image file not found", 404);
  }
  if (fileStat.size > maxSize) {
    throw new LocalImageError("Hero image file is too large", 413);
  }

  const contentType = CONTENT_TYPES.get(path.extname(canonicalCandidate).toLowerCase());
  if (!contentType) {
    throw new LocalImageError("Hero image type is not allowed", 415);
  }

  return { path: canonicalCandidate, size: fileStat.size, contentType };
}

export async function readLocalImageFile(
  candidate: string,
  allowedRoots: readonly string[],
  maxSize = MAX_LOCAL_IMAGE_SIZE,
) {
  const resolved = await resolveLocalImageFile(candidate, allowedRoots, maxSize);
  let fileHandle;

  try {
    fileHandle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      throw new LocalImageError("Hero image file not found", 404);
    }
    if (fileStat.size > maxSize) {
      throw new LocalImageError("Hero image file is too large", 413);
    }

    const data = await fileHandle.readFile();
    if (data.byteLength > maxSize) {
      throw new LocalImageError("Hero image file is too large", 413);
    }

    return { ...resolved, size: data.byteLength, data };
  } catch (error) {
    if (error instanceof LocalImageError) throw error;
    throw imageErrorForFileSystemError(error);
  } finally {
    await fileHandle?.close();
  }
}