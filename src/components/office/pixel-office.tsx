"use client";

import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { AgentStatus, FurniturePlacement, OfficeLayout, SpriteAgent } from "@/lib/types/office";
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
} from "./pixel-sprites";
import {
  drawAgentCharacter,
  drawStatusIndicator,
  drawAgentNameTag,
  drawTaskBubble,
  drawParticle,
  updateParticle,
  createSpawnParticles,
  createDespawnParticles,
  getAppearanceForAgent,
  type AgentAppearance,
  type Particle,
} from "./sprite-generator";

// ── Helpers ──────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  busy: "Working",
  error: "Error",
  offline: "Offline",
  starting: "Starting",
};

const STATUS_COLORS_HEX: Record<AgentStatus, string> = {
  idle: "#2ecc71",
  busy: "#f39c12",
  error: "#e74c3c",
  offline: "#95a5a6",
  starting: "#3498db",
};

// ── Constants ───────────────────────────────────────────────

const SCALE = 3;

type FurnitureDrawType = FurniturePlacement["type"];

const SPRITE_DRAWERS: Record<FurnitureDrawType, () => OffscreenCanvas | HTMLCanvasElement> = {
  desk: drawDesk,
  monitor: drawMonitor,
  chair: drawChair,
  plant: drawPlant,
  bookshelf: drawBookshelf,
  watercooler: drawWaterCooler,
  whiteboard: drawWhiteboard,
  server: drawServerRack,
  coffee: drawCoffeeMachine,
  rug: drawRug,
  window: drawWindow,
  lamp: drawLamp,
};

// ── Workstation definitions ─────────────────────────────────

interface Workstation {
  index: number;
  seatX: number;
  seatY: number;
  labelX: number;
  labelY: number;
}

function buildWorkstations(furniture: FurniturePlacement[]): Workstation[] {
  const desks = furniture.filter((f) => f.type === "desk");
  return desks.map((desk, i) => {
    const seatX = desk.x * TILE_SIZE * SCALE + 8 * SCALE;
    const seatY = (desk.y + 1.8) * TILE_SIZE * SCALE;
    return {
      index: i,
      seatX,
      seatY,
      labelX: desk.x * TILE_SIZE * SCALE + 16 * SCALE,
      labelY: (desk.y + 3.5) * TILE_SIZE * SCALE,
    };
  });
}

// ── Animation state mapping ──────────────────────────────────

type SpriteAnimation = SpriteAgent["animation"];

interface AnimationParams {
  animSpeed: number;
  armsTyping: boolean;
  bobAmplitude: number;
  opacityMult: number;
  scaleMult: number;
  tintColor: string | null;
  showZzz: boolean;
  showSparkles: boolean;
  errorFlash: boolean;
}

function getAnimationParams(animation: SpriteAnimation, phaseAge: number, frame: number): AnimationParams {
  const base: AnimationParams = {
    animSpeed: 1, armsTyping: false, bobAmplitude: 0, opacityMult: 1,
    scaleMult: 1, tintColor: null, showZzz: false, showSparkles: false, errorFlash: false,
  };
  switch (animation) {
    case "spawning": {
      const t = Math.min(phaseAge / 800, 1);
      const ease = t === 1 ? 1 : 1 - Math.pow(2, -10 * t) * Math.cos((t * 10 - 0.75) * (2 * Math.PI / 3));
      return { ...base, scaleMult: ease, opacityMult: Math.min(t * 2, 1) };
    }
    case "idle":
      return { ...base, bobAmplitude: 0.5, animSpeed: 0.5 };
    case "working":
      return { ...base, armsTyping: true, animSpeed: 1.5, bobAmplitude: 0.3 };
    case "walking":
      return { ...base, animSpeed: 1.2, bobAmplitude: 1.0 };
    case "error":
      return { ...base, errorFlash: true, animSpeed: 0.3, tintColor: "rgba(231, 76, 60, 0.3)" };
    case "sleeping":
      return { ...base, opacityMult: 0.5, showZzz: true, animSpeed: 0.2, bobAmplitude: 0.2 };
    case "celebrating": {
      const bounceT = (phaseAge % 400) / 400;
      const bounce = Math.abs(Math.sin(bounceT * Math.PI * 2)) * 3;
      return { ...base, bobAmplitude: bounce, showSparkles: true, animSpeed: 2.0 };
    }
    case "despawning": {
      const t = Math.min(phaseAge / 1200, 1);
      return { ...base, opacityMult: 1 - t, scaleMult: 1 - t * 0.4 };
    }
    default:
      return base;
  }
}

function drawZzzIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
  ctx.save();
  ctx.font = "bold 10px monospace";
  ctx.fillStyle = "#95a5a6";
  ctx.textAlign = "center";
  for (let i = 0; i < 3; i++) {
    const offset = (frame * 0.02 + i * 0.4) % 1.5;
    const alpha = Math.max(0, 1 - offset);
    ctx.globalAlpha = alpha * 0.7;
    const zx = x + i * 6 - 3;
    const zy = y - offset * 20 - i * 4;
    ctx.font = `bold ${8 + i * 2}px monospace`;
    ctx.fillText("z", zx, zy);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawCelebrationSparkles(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
  ctx.save();
  const colors = ["#f1c40f", "#e74c3c", "#2ecc71", "#3498db", "#9b59b6"];
  for (let i = 0; i < 6; i++) {
    const angle = (frame * 0.05 + i * (Math.PI * 2 / 6)) % (Math.PI * 2);
    const radius = 15 + Math.sin(frame * 0.1 + i) * 5;
    const sx = x + Math.cos(angle) * radius;
    const sy = y + Math.sin(angle) * radius - 10;
    const size = 2 + Math.sin(frame * 0.15 + i * 2) * 1;
    const alpha = 0.6 + Math.sin(frame * 0.1 + i * 1.5) * 0.4;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.moveTo(sx, sy - size);
    ctx.lineTo(sx + size * 0.5, sy);
    ctx.lineTo(sx, sy + size);
    ctx.lineTo(sx - size * 0.5, sy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawErrorFlash(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number, scale: number) {
  const flashIntensity = Math.sin(frame * 0.15) * 0.5 + 0.5;
  ctx.save();
  ctx.globalAlpha = flashIntensity * 0.25;
  ctx.fillStyle = "#e74c3c";
  ctx.beginPath();
  ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Canvas agent sprite state ────────────────────────────────

interface CanvasAgentSprite {
  id: string;
  name: string;
  status: AgentStatus;
  prevStatus: AgentStatus;
  animation: SpriteAnimation;
  phaseAge: number;
  appearance: AgentAppearance;
  workstationIdx: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  animFrame: number;
  spawnTime: number;
  despawning: boolean;
  despawnAlpha: number;
  currentTask?: string;
  isSubAgent: boolean;
  parentId?: string;
}

// ── Office background cache ─────────────────────────────────

interface OfficeCanvasState {
  tilemap: number[][];
  furniture: FurniturePlacement[];
  tileSprites: Map<number, OffscreenCanvas | HTMLCanvasElement>;
  furnitureSprites: Map<string, OffscreenCanvas | HTMLCanvasElement>;
}

function initOfficeState(layout: OfficeLayout): OfficeCanvasState {
  const tileSprites = new Map<number, OffscreenCanvas | HTMLCanvasElement>();
  tileSprites.set(0, drawFloorTile());
  tileSprites.set(1, drawWallTile());
  tileSprites.set(2, drawCarpetTile());

  const furnitureSprites = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
  const types = new Set(layout.furniture.map((f) => f.type));
  types.forEach((type) => {
    const drawer = SPRITE_DRAWERS[type];
    if (drawer) furnitureSprites.set(type, drawer());
  });

  return { tilemap: layout.tilemap, furniture: layout.furniture, tileSprites, furnitureSprites };
}

function renderOfficeBackground(
  ctx: CanvasRenderingContext2D,
  state: OfficeCanvasState,
  time: number,
  cols: number,
  rows: number,
) {
  ctx.imageSmoothingEnabled = false;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileType = state.tilemap[r]?.[c] ?? 0;
      const sprite = state.tileSprites.get(tileType);
      if (sprite) {
        ctx.drawImage(sprite as CanvasImageSource, c * TILE_SIZE * SCALE, r * TILE_SIZE * SCALE, TILE_SIZE * SCALE, TILE_SIZE * SCALE);
      }
    }
  }

  const sorted = [...state.furniture].sort((a, b) => a.y - b.y);
  sorted.forEach((item) => {
    const sprite = state.furnitureSprites.get(item.type);
    if (!sprite) return;
    const srcW = (sprite as HTMLCanvasElement).width ?? TILE_SIZE;
    const srcH = (sprite as HTMLCanvasElement).height ?? TILE_SIZE;
    ctx.drawImage(sprite as CanvasImageSource, item.x * TILE_SIZE * SCALE, item.y * TILE_SIZE * SCALE, srcW * SCALE, srcH * SCALE);
  });

  // Server LED flicker
  const flickerPhase = Math.sin(time / 500);
  state.furniture.filter((f) => f.type === "server").forEach((srv) => {
    const sx = srv.x * TILE_SIZE * SCALE;
    const sy = srv.y * TILE_SIZE * SCALE;
    if (flickerPhase > 0.3) { ctx.fillStyle = "#33ff33"; ctx.fillRect(sx + 4 * SCALE, sy + 8 * SCALE, SCALE, SCALE); }
    if (flickerPhase < -0.3) { ctx.fillStyle = "#ffff33"; ctx.fillRect(sx + 8 * SCALE, sy + 14 * SCALE, SCALE, SCALE); }
  });

  // Monitor screen glow
  const screenGlow = 0.5 + 0.15 * Math.sin(time / 1200);
  state.furniture.filter((f) => f.type === "monitor").forEach((mon) => {
    const mx = mon.x * TILE_SIZE * SCALE;
    const my = mon.y * TILE_SIZE * SCALE;
    ctx.globalAlpha = screenGlow;
    ctx.fillStyle = "#4488cc";
    ctx.fillRect(mx + 3 * SCALE, my + 1 * SCALE, 10 * SCALE, 8 * SCALE);
    ctx.globalAlpha = 1;
  });
}

// ── Props ───────────────────────────────────────────────────

export interface PixelOfficeProps {
  layout: OfficeLayout;
  agents?: SpriteAgent[];
  className?: string;
}

// ── Component ───────────────────────────────────────────────

export function PixelOffice({ layout, agents = [], className = "" }: PixelOfficeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const officeStateRef = useRef<OfficeCanvasState | null>(null);
  const animRef = useRef<number>(0);
  const spritesRef = useRef<Map<string, CanvasAgentSprite>>(new Map());
  const particlesRef = useRef<Particle[]>([]);
  const prevAgentIdsRef = useRef<Set<string>>(new Set());
  const frameRef = useRef(0);
  const [canvasScale, setCanvasScale] = useState(1);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  const CANVAS_W = layout.cols * TILE_SIZE * SCALE;
  const CANVAS_H = layout.rows * TILE_SIZE * SCALE;

  const workstations = useMemo(() => buildWorkstations(layout.furniture), [layout.furniture]);
  const counts = useMemo(() => {
    const total = agents.filter((a) => a.lifecycle !== "gone").length;
    const busy = agents.filter((a) => a.agentStatus === "busy" && a.lifecycle !== "gone").length;
    const subAgents = agents.filter((a) => a.isSubAgent && a.lifecycle !== "gone").length;
    return { total, busy, subAgents };
  }, [agents]);

  // ── Sync agents → canvas sprites ────────────────────────────
  const syncSprites = useCallback(
    (agentList: SpriteAgent[]) => {
      const canvasSprites = spritesRef.current;
      const currentIds = new Set<string>();
      const prevIds = prevAgentIdsRef.current;
      const usedSlots = new Set<number>();

      for (const cs of canvasSprites.values()) {
        if (!cs.despawning) usedSlots.add(cs.workstationIdx);
      }

      for (const agent of agentList) {
        if (agent.lifecycle === "gone") continue;
        currentIds.add(agent.id);
        const existing = canvasSprites.get(agent.id);

        if (existing) {
          const statusChanged = existing.status !== agent.agentStatus;
          existing.prevStatus = existing.status;
          existing.status = agent.agentStatus;
          existing.name = agent.name;
          existing.currentTask = agent.currentTask;
          existing.animation = agent.animation;
          existing.phaseAge = agent.phaseAge;
          existing.despawning = agent.lifecycle === "despawning";
          if (statusChanged && !existing.despawning) {
            particlesRef.current.push(...createSpawnParticles(existing.x, existing.y - 10, agent.agentStatus));
          }
        } else {
          let slot = 0;
          while (usedSlots.has(slot) && slot < workstations.length) slot++;
          const ws = slot < workstations.length
            ? workstations[slot]
            : { index: slot, seatX: 15 * TILE_SIZE * SCALE + (slot - workstations.length) * 50, seatY: 12 * TILE_SIZE * SCALE, labelX: 15 * TILE_SIZE * SCALE + (slot - workstations.length) * 50, labelY: 14 * TILE_SIZE * SCALE };
          usedSlots.add(slot);

          canvasSprites.set(agent.id, {
            id: agent.id, name: agent.name, status: agent.agentStatus, prevStatus: agent.agentStatus,
            animation: agent.animation, phaseAge: agent.phaseAge,
            appearance: getAppearanceForAgent(agent.id), workstationIdx: slot,
            x: ws.seatX, y: ws.seatY + 40, targetX: ws.seatX, targetY: ws.seatY,
            animFrame: 0, spawnTime: agent.spawnedAt, despawning: agent.lifecycle === "despawning",
            despawnAlpha: 1, currentTask: agent.currentTask, isSubAgent: agent.isSubAgent, parentId: agent.parentId,
          });
          if (prevIds.size > 0) {
            particlesRef.current.push(...createSpawnParticles(ws.seatX, ws.seatY, agent.agentStatus));
          }
        }
      }

      for (const [id, cs] of canvasSprites) {
        if (!currentIds.has(id) && !cs.despawning) {
          cs.despawning = true;
          cs.animation = "despawning";
          cs.phaseAge = 0;
          particlesRef.current.push(...createDespawnParticles(cs.x, cs.y));
        }
      }
      prevAgentIdsRef.current = currentIds;
    },
    [workstations],
  );

  useEffect(() => { syncSprites(agents); }, [agents, syncSprites]);

  // ── Responsive scale ────────────────────────────────────
  const updateScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const sx = container.clientWidth / CANVAS_W;
    const sy = container.clientHeight / CANVAS_H;
    setCanvasScale(Math.max(Math.min(sx, sy, 1), 0.2));
  }, [CANVAS_W, CANVAS_H]);

  // ── Mouse hover ──────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const scaleX = CANVAS_W / canvasRect.width;
    const scaleY = CANVAS_H / canvasRect.height;
    const mx = (e.clientX - canvasRect.left) * scaleX;
    const my = (e.clientY - canvasRect.top) * scaleY;

    let found: string | null = null;
    for (const sprite of spritesRef.current.values()) {
      if (sprite.despawning) continue;
      if (Math.abs(mx - sprite.targetX) < 30 && Math.abs(my - sprite.targetY) < 40) { found = sprite.id; break; }
    }
    setHoveredAgent(found);
    if (found) setTooltipPos({ x: e.clientX - containerRect.left + 16, y: e.clientY - containerRect.top - 10 });
  }, [CANVAS_W, CANVAS_H]);

  const [tooltipTick, setTooltipTick] = useState(0);
  useEffect(() => {
    if (!hoveredAgent) return;
    const interval = setInterval(() => setTooltipTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [hoveredAgent]);

  const hoveredSpriteData = useMemo(() => {
    if (!hoveredAgent) return null;
    const sprite = spritesRef.current.get(hoveredAgent);
    if (!sprite || sprite.despawning) return null;
    return {
      name: sprite.name, status: sprite.status, animation: sprite.animation,
      task: sprite.currentTask, uptime: formatUptime(Date.now() - sprite.spawnTime), isSubAgent: sprite.isSubAgent,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredAgent, tooltipTick]);

  // ── Main render loop ────────────────────────────────────
  useEffect(() => {
    officeStateRef.current = initOfficeState(layout);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const container = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (container) {
      resizeObserver = new ResizeObserver(updateScale);
      resizeObserver.observe(container);
      updateScale();
    }

    const animate = (time: number) => {
      frameRef.current++;
      const frame = frameRef.current;
      const dt = 1 / 60;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      if (officeStateRef.current) renderOfficeBackground(ctx, officeStateRef.current, time, layout.cols, layout.rows);

      const canvasSprites = spritesRef.current;
      const sortedSprites = Array.from(canvasSprites.values()).sort((a, b) => a.targetY - b.targetY);

      for (const sprite of sortedSprites) {
        const animParams = getAnimationParams(sprite.animation, sprite.phaseAge, frame);
        sprite.x += (sprite.targetX - sprite.x) * 0.12;
        sprite.y += (sprite.targetY - sprite.y) * 0.12;

        if (sprite.despawning && animParams.opacityMult <= 0.01) { canvasSprites.delete(sprite.id); continue; }
        if (sprite.despawning) {
          sprite.despawnAlpha -= dt * 2.5;
          if (sprite.despawnAlpha <= 0 && sprite.animation !== "despawning") { canvasSprites.delete(sprite.id); continue; }
        }

        ctx.save();
        const effectiveAlpha = sprite.despawning ? Math.max(0, Math.min(sprite.despawnAlpha, animParams.opacityMult)) : animParams.opacityMult;
        if (effectiveAlpha < 1) ctx.globalAlpha = effectiveAlpha;

        if (animParams.scaleMult !== 1) {
          ctx.translate(sprite.x, sprite.y + 20);
          ctx.scale(animParams.scaleMult, animParams.scaleMult);
          ctx.translate(-sprite.x, -(sprite.y + 20));
        }

        const bobOffset = animParams.bobAmplitude > 0 ? Math.sin(frame * 0.08 * animParams.animSpeed) * animParams.bobAmplitude * SCALE : 0;

        if (hoveredAgent === sprite.id) { ctx.shadowColor = "rgba(52, 152, 219, 0.6)"; ctx.shadowBlur = 20; }

        sprite.animFrame = frame;

        if (animParams.tintColor) {
          ctx.fillStyle = animParams.tintColor;
          ctx.beginPath();
          ctx.arc(sprite.x, sprite.y + bobOffset, 12 * SCALE, 0, Math.PI * 2);
          ctx.fill();
        }

        const animatedFrame = Math.floor(frame * animParams.animSpeed / 10);
        drawAgentCharacter(ctx, sprite.appearance, animatedFrame, sprite.status, SCALE, sprite.x - 8 * SCALE, sprite.y - 13 * SCALE + bobOffset);
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;

        if (animParams.errorFlash) drawErrorFlash(ctx, sprite.x, sprite.y + bobOffset, frame, SCALE);
        if (animParams.showZzz) drawZzzIndicator(ctx, sprite.x + 10, sprite.y - 16 * SCALE + bobOffset, frame);
        if (animParams.showSparkles) drawCelebrationSparkles(ctx, sprite.x, sprite.y + bobOffset, frame);

        drawStatusIndicator(ctx, sprite.x, sprite.y - 16 * SCALE + bobOffset, sprite.status, frame, SCALE);

        const ws = sprite.workstationIdx < workstations.length ? workstations[sprite.workstationIdx] : null;
        drawAgentNameTag(ctx, ws ? ws.labelX : sprite.x, ws ? ws.labelY : sprite.y + 30, sprite.name, sprite.status, sprite.isSubAgent);

        if ((hoveredAgent === sprite.id || sprite.animation === "working") && sprite.currentTask) {
          drawTaskBubble(ctx, sprite.x, sprite.y - 18 * SCALE + bobOffset, sprite.currentTask, frame);
        }
        ctx.restore();
      }

      // Particles
      const alive: Particle[] = [];
      for (const p of particlesRef.current) {
        if (updateParticle(p, dt)) { drawParticle(ctx, p); alive.push(p); }
      }
      particlesRef.current = alive;

      // Empty indicator
      if (canvasSprites.size === 0 && agents.length === 0) {
        ctx.save();
        ctx.font = "bold 13px monospace";
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No agents active \u2014 waiting for activity\u2026", CANVAS_W / 2, CANVAS_H / 2);
        ctx.restore();
      }

      // HUD
      if (canvasSprites.size > 0) {
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        ctx.beginPath();
        ctx.roundRect(8, 8, 170, counts.subAgents > 0 ? 38 : 22, 5);
        ctx.fill();
        ctx.font = "bold 10px monospace";
        ctx.fillStyle = "#ecf0f1";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`\uD83E\uDD16 ${counts.total} agent${counts.total !== 1 ? "s" : ""} \u00B7 ${counts.busy} busy`, 14, 20);
        if (counts.subAgents > 0) { ctx.fillStyle = "#9b59b6"; ctx.fillText(`\u2B21 ${counts.subAgents} sub-agent${counts.subAgents !== 1 ? "s" : ""}`, 14, 36); }
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(animRef.current); resizeObserver?.disconnect(); };
  }, [layout, updateScale, hoveredAgent, counts, agents, CANVAS_W, CANVAS_H, workstations]);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div ref={containerRef} className="flex-1 flex items-center justify-center overflow-hidden bg-[#1a2a1a] p-2 md:p-4 relative">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: CANVAS_W * canvasScale, height: CANVAS_H * canvasScale, imageRendering: "pixelated", cursor: hoveredAgent ? "pointer" : "default" }}
          className="rounded-lg shadow-2xl border border-white/10"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoveredAgent(null)}
        />
        {hoveredAgent && hoveredSpriteData && (
          <div ref={tooltipRef} className="absolute pointer-events-none z-50" style={{ left: tooltipPos.x, top: tooltipPos.y, transform: "translateY(-100%)" }}>
            <div className="bg-black/90 backdrop-blur-sm text-white border border-white/20 rounded-lg shadow-xl px-3 py-2.5 min-w-[180px] max-w-[260px]">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STATUS_COLORS_HEX[hoveredSpriteData.status] }} />
                <span className="font-semibold text-sm truncate">{hoveredSpriteData.name}</span>
                {hoveredSpriteData.isSubAgent && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 font-medium shrink-0">sub</span>}
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                <span>Status</span>
                <span className="font-medium" style={{ color: STATUS_COLORS_HEX[hoveredSpriteData.status] }}>{STATUS_LABELS[hoveredSpriteData.status]}</span>
              </div>
              <div className="flex items-start justify-between gap-2 text-xs text-gray-400 mb-1">
                <span className="shrink-0">Task</span>
                <span className="font-medium text-white text-right truncate max-w-[160px]">{hoveredSpriteData.task || "\u2014"}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>Uptime</span>
                <span className="font-mono font-medium text-white">{hoveredSpriteData.uptime}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-white/10 shrink-0 flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="font-semibold text-gray-300">Status:</span>
        {(Object.entries(STATUS_COLORS_HEX) as [AgentStatus, string][]).map(([status, color]) => (
          <span key={status} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {STATUS_LABELS[status]}
          </span>
        ))}
      </div>
    </div>
  );
}
