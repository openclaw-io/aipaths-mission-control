"use client";

import { useState, useCallback } from "react";
import type { OfficeLayout, OfficeTemplate } from "@/lib/types/office";

const STORAGE_KEY = "mc-office-templates";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function loadTemplates(): OfficeTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as OfficeTemplate[];
  } catch {
    /* ignore */
  }
  return [];
}

function persistTemplates(templates: OfficeTemplate[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    /* ignore */
  }
}

/**
 * Generate a small thumbnail from a canvas element.
 * Returns a data URL (JPEG, ~120x80px).
 */
export function generateThumbnail(
  sourceCanvas: HTMLCanvasElement | null,
): string | undefined {
  if (!sourceCanvas) return undefined;
  const thumbW = 120;
  const thumbH = Math.round(
    (sourceCanvas.height / sourceCanvas.width) * thumbW,
  );
  const thumb = document.createElement("canvas");
  thumb.width = thumbW;
  thumb.height = thumbH;
  const ctx = thumb.getContext("2d");
  if (!ctx) return undefined;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, thumbW, thumbH);
  return thumb.toDataURL("image/jpeg", 0.7);
}

export function useOfficeTemplates() {
  const [templates, setTemplates] = useState<OfficeTemplate[]>(loadTemplates);

  const save = useCallback((next: OfficeTemplate[]) => {
    setTemplates(next);
    persistTemplates(next);
  }, []);

  const saveAsTemplate = useCallback(
    (
      name: string,
      layout: OfficeLayout,
      thumbnail?: string,
    ): OfficeTemplate => {
      const now = new Date().toISOString();
      const tpl: OfficeTemplate = {
        id: generateId(),
        name,
        thumbnail,
        layout: structuredClone(layout),
        createdAt: now,
        updatedAt: now,
      };
      const next = [...loadTemplates(), tpl];
      save(next);
      return tpl;
    },
    [save],
  );

  const updateTemplate = useCallback(
    (id: string, layout: OfficeLayout, thumbnail?: string) => {
      const current = loadTemplates();
      const next = current.map((t) =>
        t.id === id
          ? {
              ...t,
              layout: structuredClone(layout),
              thumbnail: thumbnail ?? t.thumbnail,
              updatedAt: new Date().toISOString(),
            }
          : t,
      );
      save(next);
    },
    [save],
  );

  const renameTemplate = useCallback(
    (id: string, name: string) => {
      const current = loadTemplates();
      const next = current.map((t) =>
        t.id === id
          ? { ...t, name, updatedAt: new Date().toISOString() }
          : t,
      );
      save(next);
    },
    [save],
  );

  const duplicateTemplate = useCallback(
    (id: string, newName: string): OfficeTemplate | null => {
      const current = loadTemplates();
      const source = current.find((t) => t.id === id);
      if (!source) return null;
      const now = new Date().toISOString();
      const tpl: OfficeTemplate = {
        id: generateId(),
        name: newName,
        thumbnail: source.thumbnail,
        layout: structuredClone(source.layout),
        createdAt: now,
        updatedAt: now,
      };
      const next = [...current, tpl];
      save(next);
      return tpl;
    },
    [save],
  );

  const deleteTemplate = useCallback(
    (id: string) => {
      const current = loadTemplates();
      const next = current.filter((t) => t.id !== id);
      save(next);
    },
    [save],
  );

  return {
    templates,
    saveAsTemplate,
    updateTemplate,
    renameTemplate,
    duplicateTemplate,
    deleteTemplate,
  };
}
