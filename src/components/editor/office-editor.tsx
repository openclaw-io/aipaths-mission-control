"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  TILE_SIZE,
  drawFloorTile,
  drawCarpetTile,
  drawWallTile,
  drawDesk,
  drawMonitor,
  drawChair,
  drawPlant,
  drawBookshelf,
  drawWaterCooler,
  drawWhiteboard,
  drawServerRack,
  drawCoffeeMachine,
  drawRug,
  drawWindow,
  drawLamp,
} from "@/components/office/pixel-sprites";
import type { FurnitureType, TileType, OfficeLayout, FurniturePlacement, OfficeTemplate } from "@/lib/types/office";
import { generateThumbnail } from "@/hooks/use-office-templates";
import { Trash2, RotateCcw, Download, Upload, Grid3X3, MousePointer, Paintbrush, Save, Copy, Pencil } from "lucide-react";

// ── Constants ───────────────────────────────────────────────

const SCALE = 3;

const FURNITURE_TYPES: { type: FurnitureType; label: string }[] = [
  { type: "desk", label: "Desk" },
  { type: "monitor", label: "Monitor" },
  { type: "chair", label: "Chair" },
  { type: "plant", label: "Plant" },
  { type: "bookshelf", label: "Bookshelf" },
  { type: "watercooler", label: "Cooler" },
  { type: "whiteboard", label: "Whiteboard" },
  { type: "server", label: "Server" },
  { type: "coffee", label: "Coffee" },
  { type: "rug", label: "Rug" },
  { type: "window", label: "Window" },
  { type: "lamp", label: "Lamp" },
];

const TILE_LABELS: { type: TileType; label: string; color: string }[] = [
  { type: 0, label: "Floor", color: "#4a6741" },
  { type: 1, label: "Wall", color: "#6b7d8e" },
  { type: 2, label: "Carpet", color: "#5b4a8a" },
];

const SPRITE_DRAWERS: Record<FurnitureType, () => OffscreenCanvas | HTMLCanvasElement> = {
  desk: drawDesk, monitor: drawMonitor, chair: drawChair, plant: drawPlant,
  bookshelf: drawBookshelf, watercooler: drawWaterCooler, whiteboard: drawWhiteboard,
  server: drawServerRack, coffee: drawCoffeeMachine, rug: drawRug, window: drawWindow, lamp: drawLamp,
};

type EditorMode = "select" | "place" | "paint";

// ── Props ───────────────────────────────────────────────────

export interface OfficeEditorProps {
  layout: OfficeLayout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddFurniture: (type: FurnitureType, x: number, y: number) => void;
  onMoveFurniture: (id: string, x: number, y: number) => void;
  onRemoveFurniture: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
  onSetTile: (row: number, col: number, tile: TileType) => void;
  onReset: () => void;
  onExport: () => string;
  onImport: (json: string) => boolean;
  onLoadLayout: (layout: OfficeLayout) => void;
  templates: OfficeTemplate[];
  onSaveTemplate: (name: string, layout: OfficeLayout, thumbnail?: string) => OfficeTemplate;
  onUpdateTemplate: (id: string, layout: OfficeLayout, thumbnail?: string) => void;
  onDeleteTemplate: (id: string) => void;
  onDuplicateTemplate: (id: string, newName: string) => OfficeTemplate | null;
  onRenameTemplate: (id: string, name: string) => void;
}

export function OfficeEditor({
  layout, selectedId, onSelect, onAddFurniture, onMoveFurniture,
  onRemoveFurniture, onUpdateLabel, onSetTile, onReset, onExport, onImport,
  onLoadLayout, templates, onSaveTemplate, onUpdateTemplate, onDeleteTemplate,
  onDuplicateTemplate, onRenameTemplate,
}: OfficeEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<EditorMode>("select");
  const [placingType, setPlacingType] = useState<FurnitureType | null>(null);
  const [paintTile, setPaintTile] = useState<TileType>(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasScale, setCanvasScale] = useState(1);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState("");
  const [isPainting, setIsPainting] = useState(false);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const CANVAS_W = layout.cols * TILE_SIZE * SCALE;
  const CANVAS_H = layout.rows * TILE_SIZE * SCALE;

  // ── Responsive scale ────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const sx = container.clientWidth / CANVAS_W;
      const sy = container.clientHeight / CANVAS_H;
      setCanvasScale(Math.max(Math.min(sx, sy, 1), 0.15));
    };
    const obs = new ResizeObserver(update);
    obs.observe(container);
    update();
    return () => obs.disconnect();
  }, [CANVAS_W, CANVAS_H]);

  // ── Render ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.imageSmoothingEnabled = false;

    // Tile sprites
    const tileSprites = new Map<number, OffscreenCanvas | HTMLCanvasElement>();
    tileSprites.set(0, drawFloorTile());
    tileSprites.set(1, drawWallTile());
    tileSprites.set(2, drawCarpetTile());

    // Draw tilemap
    for (let r = 0; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const tileType = layout.tilemap[r]?.[c] ?? 0;
        const sprite = tileSprites.get(tileType);
        if (sprite) ctx.drawImage(sprite as CanvasImageSource, c * TILE_SIZE * SCALE, r * TILE_SIZE * SCALE, TILE_SIZE * SCALE, TILE_SIZE * SCALE);
      }
    }

    // Grid overlay
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let r = 0; r <= layout.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * TILE_SIZE * SCALE);
      ctx.lineTo(CANVAS_W, r * TILE_SIZE * SCALE);
      ctx.stroke();
    }
    for (let c = 0; c <= layout.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * TILE_SIZE * SCALE, 0);
      ctx.lineTo(c * TILE_SIZE * SCALE, CANVAS_H);
      ctx.stroke();
    }

    // Draw furniture
    const furnitureSprites = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
    const types = new Set(layout.furniture.map((f) => f.type));
    types.forEach((type) => {
      const drawer = SPRITE_DRAWERS[type];
      if (drawer) furnitureSprites.set(type, drawer());
    });

    const sorted = [...layout.furniture].sort((a, b) => a.y - b.y);
    sorted.forEach((item) => {
      const sprite = furnitureSprites.get(item.type);
      if (!sprite) return;
      const srcW = (sprite as HTMLCanvasElement).width ?? TILE_SIZE;
      const srcH = (sprite as HTMLCanvasElement).height ?? TILE_SIZE;
      const dx = item.x * TILE_SIZE * SCALE;
      const dy = item.y * TILE_SIZE * SCALE;
      ctx.drawImage(sprite as CanvasImageSource, dx, dy, srcW * SCALE, srcH * SCALE);

      // Selection highlight
      if (item.id === selectedId) {
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(dx - 2, dy - 2, srcW * SCALE + 4, srcH * SCALE + 4);
        ctx.setLineDash([]);
      }

      // Label
      if (item.label) {
        ctx.font = "bold 9px monospace";
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        const tw = ctx.measureText(item.label).width + 6;
        ctx.fillRect(dx, dy - 12, tw, 12);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(item.label, dx + 3, dy - 6);
      }
    });

    // Paint mode cursor indicator
    if (mode === "paint") {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
  }, [layout, selectedId, CANVAS_W, CANVAS_H, mode]);

  // ── Canvas coords ─────────────────────────────────────────
  const getCanvasCoords = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }, [CANVAS_W, CANVAS_H]);

  const getTileCoords = useCallback((e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e);
    return { col: Math.floor(x / (TILE_SIZE * SCALE)), row: Math.floor(y / (TILE_SIZE * SCALE)) };
  }, [getCanvasCoords]);

  // ── Mouse handlers ────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e);
    const tileX = x / (TILE_SIZE * SCALE);
    const tileY = y / (TILE_SIZE * SCALE);

    if (mode === "paint") {
      const { row, col } = getTileCoords(e);
      if (row >= 0 && row < layout.rows && col >= 0 && col < layout.cols) {
        onSetTile(row, col, paintTile);
        setIsPainting(true);
      }
      return;
    }

    if (mode === "place" && placingType) {
      const snappedX = Math.floor(tileX);
      const snappedY = Math.floor(tileY);
      onAddFurniture(placingType, snappedX, snappedY);
      return;
    }

    // Select mode — find clicked furniture
    let found: FurniturePlacement | null = null;
    for (const item of [...layout.furniture].reverse()) {
      const ix = item.x * TILE_SIZE * SCALE;
      const iy = item.y * TILE_SIZE * SCALE;
      const sprite = SPRITE_DRAWERS[item.type]?.();
      const iw = sprite ? (sprite as HTMLCanvasElement).width * SCALE : TILE_SIZE * SCALE;
      const ih = sprite ? (sprite as HTMLCanvasElement).height * SCALE : TILE_SIZE * SCALE;
      if (x >= ix && x <= ix + iw && y >= iy && y <= iy + ih) { found = item; break; }
    }

    if (found) {
      onSelect(found.id);
      setDragging(found.id);
      setDragOffset({ x: x - found.x * TILE_SIZE * SCALE, y: y - found.y * TILE_SIZE * SCALE });
    } else {
      onSelect(null);
    }
  }, [mode, placingType, paintTile, layout, getCanvasCoords, getTileCoords, onAddFurniture, onSelect, onSetTile]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (mode === "paint" && isPainting) {
      const { row, col } = getTileCoords(e);
      if (row >= 0 && row < layout.rows && col >= 0 && col < layout.cols) onSetTile(row, col, paintTile);
      return;
    }
    if (!dragging) return;
    const { x, y } = getCanvasCoords(e);
    const newX = (x - dragOffset.x) / (TILE_SIZE * SCALE);
    const newY = (y - dragOffset.y) / (TILE_SIZE * SCALE);
    onMoveFurniture(dragging, Math.round(newX * 2) / 2, Math.round(newY * 2) / 2);
  }, [dragging, dragOffset, mode, isPainting, paintTile, layout, getCanvasCoords, getTileCoords, onMoveFurniture, onSetTile]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    setIsPainting(false);
  }, []);

  // ── Import handler ────────────────────────────────────────
  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      onImport(text);
    };
    input.click();
  }, [onImport]);

  const handleExport = useCallback(() => {
    const json = onExport();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${layout.name || "office-layout"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [onExport, layout.name]);

  const selectedItem = selectedId ? layout.furniture.find((f) => f.id === selectedId) : null;

  const handleSaveTemplate = useCallback(() => {
    if (!templateName.trim()) return;
    const thumb = generateThumbnail(canvasRef.current);
    onSaveTemplate(templateName.trim(), layout, thumb);
    setTemplateName("");
    setShowSavePrompt(false);
  }, [templateName, layout, onSaveTemplate]);

  const handleLoadTemplate = useCallback((tpl: OfficeTemplate) => {
    if (!confirm(`Load template "${tpl.name}"? Current unsaved layout will be replaced.`)) return;
    onLoadLayout(tpl.layout);
  }, [onLoadLayout]);

  const handleUpdateTemplate = useCallback((tpl: OfficeTemplate) => {
    if (!confirm(`Overwrite template "${tpl.name}" with the current layout?`)) return;
    const thumb = generateThumbnail(canvasRef.current);
    onUpdateTemplate(tpl.id, layout, thumb);
  }, [layout, onUpdateTemplate]);

  const handleDuplicateTemplate = useCallback((tpl: OfficeTemplate) => {
    const name = prompt("Name for the copy:", `${tpl.name} (copy)`);
    if (!name) return;
    onDuplicateTemplate(tpl.id, name);
  }, [onDuplicateTemplate]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-white/10 bg-[#111] flex flex-col shrink-0 overflow-y-auto">
        {/* Tools */}
        <div className="p-3 border-b border-white/10">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tools</h3>
          <div className="flex gap-1">
            <button onClick={() => { setMode("select"); setPlacingType(null); }} className={`p-2 rounded ${mode === "select" ? "bg-blue-600" : "bg-white/5 hover:bg-white/10"} transition-colors`} title="Select & Move">
              <MousePointer size={14} />
            </button>
            <button onClick={() => setMode("paint")} className={`p-2 rounded ${mode === "paint" ? "bg-blue-600" : "bg-white/5 hover:bg-white/10"} transition-colors`} title="Paint Tiles">
              <Paintbrush size={14} />
            </button>
            <button onClick={() => setMode("place")} className={`p-2 rounded ${mode === "place" ? "bg-blue-600" : "bg-white/5 hover:bg-white/10"} transition-colors`} title="Place Furniture">
              <Grid3X3 size={14} />
            </button>
          </div>
        </div>

        {/* Paint tiles */}
        {mode === "paint" && (
          <div className="p-3 border-b border-white/10">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tile Brush</h3>
            <div className="space-y-1">
              {TILE_LABELS.map((t) => (
                <button key={t.type} onClick={() => setPaintTile(t.type)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs ${paintTile === t.type ? "bg-blue-600/30 border border-blue-500" : "bg-white/5 hover:bg-white/10 border border-transparent"} transition-colors`}>
                  <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: t.color }} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Furniture palette */}
        {mode === "place" && (
          <div className="p-3 border-b border-white/10">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Furniture</h3>
            <div className="grid grid-cols-2 gap-1">
              {FURNITURE_TYPES.map((f) => (
                <button key={f.type} onClick={() => setPlacingType(f.type)}
                  className={`px-2 py-1.5 rounded text-xs text-left ${placingType === f.type ? "bg-blue-600/30 border border-blue-500" : "bg-white/5 hover:bg-white/10 border border-transparent"} transition-colors`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Selected item properties */}
        {selectedItem && mode === "select" && (
          <div className="p-3 border-b border-white/10">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Properties</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-gray-400">
                <span>Type</span>
                <span className="text-white capitalize">{selectedItem.type}</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Position</span>
                <span className="text-white">{selectedItem.x}, {selectedItem.y}</span>
              </div>
              <div>
                <label className="text-gray-400 block mb-1">Label</label>
                {editingLabel ? (
                  <input value={labelValue} onChange={(e) => setLabelValue(e.target.value)}
                    onBlur={() => { onUpdateLabel(selectedItem.id, labelValue); setEditingLabel(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { onUpdateLabel(selectedItem.id, labelValue); setEditingLabel(false); } }}
                    className="w-full bg-white/10 border border-white/20 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                ) : (
                  <button onClick={() => { setLabelValue(selectedItem.label || ""); setEditingLabel(true); }}
                    className="w-full text-left bg-white/5 border border-transparent hover:border-white/20 rounded px-2 py-1 text-white">
                    {selectedItem.label || "(click to set)"}
                  </button>
                )}
              </div>
              <button onClick={() => onRemoveFurniture(selectedItem.id)}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors">
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="p-3 mt-auto border-t border-white/10">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Actions</h3>
          <div className="space-y-1">
            <button onClick={handleExport} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 transition-colors">
              <Download size={12} /> Export JSON
            </button>
            <button onClick={handleImport} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 transition-colors">
              <Upload size={12} /> Import JSON
            </button>
            <button onClick={onReset} className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 text-yellow-400 transition-colors">
              <RotateCcw size={12} /> Reset Default
            </button>
          </div>
        </div>
      </div>

      {/* Canvas + Templates area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Canvas */}
        <div ref={containerRef} className="flex-1 flex items-center justify-center overflow-hidden bg-[#0a150a] p-4 relative"
          onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
          <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H}
            style={{ width: CANVAS_W * canvasScale, height: CANVAS_H * canvasScale, imageRendering: "pixelated", cursor: mode === "paint" ? "crosshair" : mode === "place" ? "copy" : dragging ? "grabbing" : "default" }}
            className="rounded-lg shadow-2xl border border-white/10"
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
          />
          <div className="absolute top-3 left-3 bg-black/70 text-white text-xs px-3 py-1.5 rounded-md font-mono">
            {mode === "select" && "Click to select, drag to move"}
            {mode === "place" && placingType && `Click to place: ${placingType}`}
            {mode === "place" && !placingType && "Select furniture from sidebar"}
            {mode === "paint" && `Painting: ${TILE_LABELS.find((t) => t.type === paintTile)?.label}`}
          </div>
        </div>

        {/* Templates strip */}
        {mode === "select" && (
          <div className="shrink-0 border-t border-white/10 bg-[#111] px-4 py-3">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Templates</h3>
              {!showSavePrompt ? (
                <button
                  onClick={() => setShowSavePrompt(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors"
                >
                  <Save size={11} /> Save Current
                </button>
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); handleSaveTemplate(); }}
                  className="flex items-center gap-2"
                >
                  <input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Template name..."
                    className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 w-40"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!templateName.trim()}
                    className="px-2 py-1 rounded text-xs bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowSavePrompt(false); setTemplateName(""); }}
                    className="px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-gray-400 transition-colors"
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
            {templates.length === 0 ? (
              <p className="text-xs text-gray-600">No saved templates yet. Click &quot;Save Current&quot; to save this layout as a template.</p>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {templates.map((tpl) => (
                  <div key={tpl.id} className="group relative shrink-0 w-[140px]">
                    {/* Thumbnail + Click to load */}
                    <button
                      onClick={() => handleLoadTemplate(tpl)}
                      className="w-full rounded-lg overflow-hidden border border-white/10 hover:border-blue-500/50 transition-colors bg-[#0a150a]"
                      title={`Load "${tpl.name}"`}
                    >
                      {tpl.thumbnail ? (
                        <img
                          src={tpl.thumbnail}
                          alt={tpl.name}
                          className="w-full h-[80px] object-cover"
                          style={{ imageRendering: "pixelated" }}
                        />
                      ) : (
                        <div className="w-full h-[80px] flex items-center justify-center text-gray-600 text-xs">
                          No preview
                        </div>
                      )}
                    </button>
                    {/* Name */}
                    <div className="mt-1 px-1">
                      {renamingId === tpl.id ? (
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => {
                            if (renameValue.trim()) onRenameTemplate(tpl.id, renameValue.trim());
                            setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (renameValue.trim()) onRenameTemplate(tpl.id, renameValue.trim());
                              setRenamingId(null);
                            }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="w-full bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-blue-500"
                          autoFocus
                        />
                      ) : (
                        <p className="text-[10px] text-gray-400 truncate">{tpl.name}</p>
                      )}
                    </div>
                    {/* Action buttons (visible on hover) */}
                    <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUpdateTemplate(tpl); }}
                        className="p-1 rounded bg-black/70 hover:bg-black/90 text-gray-300 hover:text-white transition-colors"
                        title="Overwrite with current layout"
                      >
                        <Save size={10} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenamingId(tpl.id); setRenameValue(tpl.name); }}
                        className="p-1 rounded bg-black/70 hover:bg-black/90 text-gray-300 hover:text-white transition-colors"
                        title="Rename"
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDuplicateTemplate(tpl); }}
                        className="p-1 rounded bg-black/70 hover:bg-black/90 text-gray-300 hover:text-white transition-colors"
                        title="Duplicate"
                      >
                        <Copy size={10} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete template "${tpl.name}"?`)) onDeleteTemplate(tpl.id);
                        }}
                        className="p-1 rounded bg-black/70 hover:bg-red-900/80 text-gray-300 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
