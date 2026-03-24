"use client";

import { useState, useCallback } from "react";
import type { OfficeLayout, FurnitureType, TileType } from "@/lib/types/office";

const STORAGE_KEY = "mc-pixel-office-layout";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function createDefaultLayout(): OfficeLayout {
  const cols = 30;
  const rows = 20;
  const tilemap: TileType[][] = [];

  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) {
      if (r < 3) row.push(1);
      else if (r >= 8 && r <= 14 && c >= 10 && c <= 20) row.push(2);
      else row.push(0);
    }
    tilemap.push(row);
  }

  return {
    name: "Default Office",
    cols,
    rows,
    tilemap,
    furniture: [
      { id: generateId(), type: "window", x: 3, y: 0, label: "Window" },
      { id: generateId(), type: "window", x: 9, y: 0, label: "Window" },
      { id: generateId(), type: "window", x: 17, y: 0, label: "Window" },
      { id: generateId(), type: "window", x: 23, y: 0, label: "Window" },
      { id: generateId(), type: "whiteboard", x: 13, y: 0.5, label: "Sprint Board" },
      { id: generateId(), type: "desk", x: 1, y: 4, label: "Desk 1" },
      { id: generateId(), type: "monitor", x: 2, y: 3, label: "Monitor 1" },
      { id: generateId(), type: "chair", x: 2, y: 6, label: "Chair 1" },
      { id: generateId(), type: "desk", x: 5, y: 4, label: "Desk 2" },
      { id: generateId(), type: "monitor", x: 6, y: 3, label: "Monitor 2" },
      { id: generateId(), type: "chair", x: 6, y: 6, label: "Chair 2" },
      { id: generateId(), type: "desk", x: 21, y: 4, label: "Desk 3" },
      { id: generateId(), type: "monitor", x: 22, y: 3, label: "Monitor 3" },
      { id: generateId(), type: "chair", x: 22, y: 6, label: "Chair 3" },
      { id: generateId(), type: "desk", x: 25, y: 4, label: "Desk 4" },
      { id: generateId(), type: "monitor", x: 26, y: 3, label: "Monitor 4" },
      { id: generateId(), type: "chair", x: 26, y: 6, label: "Chair 4" },
      { id: generateId(), type: "rug", x: 11, y: 9, label: "Meeting Area" },
      { id: generateId(), type: "desk", x: 1, y: 15, label: "Desk 5" },
      { id: generateId(), type: "monitor", x: 2, y: 14, label: "Monitor 5" },
      { id: generateId(), type: "chair", x: 2, y: 17, label: "Chair 5" },
      { id: generateId(), type: "desk", x: 5, y: 15, label: "Desk 6" },
      { id: generateId(), type: "monitor", x: 6, y: 14, label: "Monitor 6" },
      { id: generateId(), type: "chair", x: 6, y: 17, label: "Chair 6" },
      { id: generateId(), type: "desk", x: 21, y: 15, label: "Desk 7" },
      { id: generateId(), type: "monitor", x: 22, y: 14, label: "Monitor 7" },
      { id: generateId(), type: "chair", x: 22, y: 17, label: "Chair 7" },
      { id: generateId(), type: "desk", x: 25, y: 15, label: "Desk 8" },
      { id: generateId(), type: "monitor", x: 26, y: 14, label: "Monitor 8" },
      { id: generateId(), type: "chair", x: 26, y: 17, label: "Chair 8" },
      { id: generateId(), type: "plant", x: 0, y: 3, label: "Plant" },
      { id: generateId(), type: "plant", x: 9, y: 4, label: "Plant" },
      { id: generateId(), type: "plant", x: 20, y: 3, label: "Plant" },
      { id: generateId(), type: "plant", x: 29, y: 3, label: "Plant" },
      { id: generateId(), type: "plant", x: 0, y: 14, label: "Plant" },
      { id: generateId(), type: "plant", x: 9, y: 15, label: "Plant" },
      { id: generateId(), type: "plant", x: 29, y: 14, label: "Plant" },
      { id: generateId(), type: "bookshelf", x: 10, y: 3, label: "Library" },
      { id: generateId(), type: "server", x: 27, y: 9, label: "Server Rack" },
      { id: generateId(), type: "watercooler", x: 20, y: 9, label: "Water Cooler" },
      { id: generateId(), type: "coffee", x: 10, y: 16, label: "Coffee Machine" },
      { id: generateId(), type: "lamp", x: 0, y: 8, label: "Lamp" },
      { id: generateId(), type: "lamp", x: 29, y: 8, label: "Lamp" },
      { id: generateId(), type: "lamp", x: 14, y: 14, label: "Lamp" },
    ],
  };
}

export function useOfficeState() {
  const [layout, setLayout] = useState<OfficeLayout>(() => {
    if (typeof window === "undefined") return createDefaultLayout();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as OfficeLayout;
    } catch { /* ignore */ }
    return createDefaultLayout();
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const persist = useCallback((l: OfficeLayout) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)); } catch { /* ignore */ }
  }, []);

  const addFurniture = useCallback((type: FurnitureType, x: number, y: number) => {
    setLayout((prev) => {
      const next = { ...prev, furniture: [...prev.furniture, { id: generateId(), type, x, y, label: type }] };
      persist(next);
      return next;
    });
  }, [persist]);

  const moveFurniture = useCallback((id: string, x: number, y: number) => {
    setLayout((prev) => {
      const next = { ...prev, furniture: prev.furniture.map((f) => (f.id === id ? { ...f, x, y } : f)) };
      persist(next);
      return next;
    });
  }, [persist]);

  const removeFurniture = useCallback((id: string) => {
    setLayout((prev) => {
      const next = { ...prev, furniture: prev.furniture.filter((f) => f.id !== id) };
      persist(next);
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
  }, [persist]);

  const updateFurnitureLabel = useCallback((id: string, label: string) => {
    setLayout((prev) => {
      const next = { ...prev, furniture: prev.furniture.map((f) => (f.id === id ? { ...f, label } : f)) };
      persist(next);
      return next;
    });
  }, [persist]);

  const setTile = useCallback((row: number, col: number, tile: TileType) => {
    setLayout((prev) => {
      const newTilemap = prev.tilemap.map((r) => [...r]);
      if (newTilemap[row]) newTilemap[row][col] = tile;
      const next = { ...prev, tilemap: newTilemap };
      persist(next);
      return next;
    });
  }, [persist]);

  const resetLayout = useCallback(() => {
    const def = createDefaultLayout();
    setLayout(def);
    persist(def);
    setSelectedId(null);
  }, [persist]);

  const exportLayout = useCallback(() => JSON.stringify(layout, null, 2), [layout]);

  const importLayout = useCallback((json: string) => {
    try {
      const parsed = JSON.parse(json) as OfficeLayout;
      if (parsed.cols && parsed.rows && parsed.tilemap && parsed.furniture) {
        setLayout(parsed);
        persist(parsed);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, [persist]);

  const loadLayout = useCallback((newLayout: OfficeLayout) => {
    const cloned = structuredClone(newLayout);
    setLayout(cloned);
    persist(cloned);
    setSelectedId(null);
  }, [persist]);

  return {
    layout, selectedId, setSelectedId,
    addFurniture, moveFurniture, removeFurniture, updateFurnitureLabel,
    setTile, resetLayout, exportLayout, importLayout, loadLayout,
  };
}
