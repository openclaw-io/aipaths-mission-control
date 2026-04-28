import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

const ALLOWED_IMAGE_ROOTS = [
  "/Users/joaco/.openclaw/media",
  "/Users/joaco/Documents/openclaw/director-content/work/localizations",
];

function getNestedRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as JsonRecord)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as JsonRecord) : null;
}

function getString(record: JsonRecord | null, keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function contentTypeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function isAllowedPath(filePath: string) {
  const resolved = path.resolve(filePath);
  return ALLOWED_IMAGE_ROOTS.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceClient();

  const { data: item, error } = await db.from("pipeline_items").select("metadata").eq("id", id).eq("pipeline_type", "blog").single();
  if (error || !item) return NextResponse.json({ error: "Blog not found" }, { status: 404 });

  const metadata = (item.metadata || {}) as JsonRecord;
  const hero = getNestedRecord(metadata, "hero_image") || getNestedRecord(metadata, "cover_image");
  const imagePath = getString(hero, ["media_path", "local_path", "path"]);

  if (!imagePath) return NextResponse.json({ error: "Hero image path not found" }, { status: 404 });
  if (!isAllowedPath(imagePath)) return NextResponse.json({ error: "Hero image path is not allowed" }, { status: 403 });

  try {
    const file = await readFile(imagePath);
    return new NextResponse(file, {
      headers: {
        "Content-Type": contentTypeFor(imagePath),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Hero image file not found" }, { status: 404 });
  }
}
