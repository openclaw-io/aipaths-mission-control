import { homedir } from "node:os";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { directorRoot } from "@/lib/agents-paths";
import { createServiceClient } from "@/lib/supabase/admin";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { getPipelineItemLocal } from "@/lib/db/pipeline-local";
import { LocalImageError, readLocalImageFile } from "./local-image";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

// Los dos roots sirven portadas vivas: medido el 2026-08-08, 7 blogs referencian
// ~/.openclaw/media y 23 apuntan a director-content. @content se retira como AGENTE,
// pero su carpeta de trabajo sigue siendo el origen de esas 23 imágenes.
function allowedImageRoots(): string[] {
  // ~/.openclaw cuelga del $HOME del usuario, no del workspace: homedir() es lo correcto.
  const roots = [path.join(homedir(), ".openclaw", "media")];
  // director-content sí se muda en GON-71; si no se puede resolver, el root se omite y
  // esas imágenes dejan de pasar el allowlist — visible, no silencioso.
  const content = directorRoot("content");
  if (content) roots.push(path.join(content, "work", "localizations"));
  return roots;
}

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

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let item: { metadata?: unknown } | null = null;
  if (isLocalAuthDisabled()) {
    item = await getPipelineItemLocal(id, "blog");
  } else {
    const db = createServiceClient();
    const { data, error } = await db.from("pipeline_items").select("metadata").eq("id", id).eq("pipeline_type", "blog").single();
    if (error) return NextResponse.json({ error: "Blog not found" }, { status: 404 });
    item = data;
  }
  if (!item) return NextResponse.json({ error: "Blog not found" }, { status: 404 });

  const metadata = (item.metadata || {}) as JsonRecord;
  const hero = getNestedRecord(metadata, "hero_image") || getNestedRecord(metadata, "cover_image");
  const imagePath = getString(hero, ["media_path", "local_path", "path"]);

  if (!imagePath) return NextResponse.json({ error: "Hero image path not found" }, { status: 404 });

  try {
    const image = await readLocalImageFile(imagePath, allowedImageRoots());
    return new NextResponse(image.data, {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(image.size),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof LocalImageError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Hero image file not found" }, { status: 404 });
  }
}
