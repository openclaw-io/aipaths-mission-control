export type AgentStatus = "idle" | "busy" | "error" | "offline" | "starting";

export interface AgentData {
  id: string;
  name: string;
  status: AgentStatus;
  currentTask?: string;
  isSubAgent?: boolean;
  parentId?: string;
}

export type TileType = 0 | 1 | 2;

export type FurnitureType =
  | "desk" | "monitor" | "chair" | "plant" | "bookshelf"
  | "watercooler" | "whiteboard" | "server" | "coffee"
  | "rug" | "window" | "lamp";

export interface FurniturePlacement {
  id: string;
  type: FurnitureType;
  x: number;
  y: number;
  label?: string;
}

export interface OfficeLayout {
  name: string;
  cols: number;
  rows: number;
  tilemap: TileType[][];
  furniture: FurniturePlacement[];
}

export type SpriteAnimation =
  | "idle" | "working" | "spawning" | "despawning"
  | "walking" | "error" | "sleeping" | "celebrating";

export interface SpriteAgent {
  id: string;
  name: string;
  agentStatus: AgentStatus;
  animation: SpriteAnimation;
  lifecycle: "spawning" | "active" | "despawning" | "gone";
  position: { x: number; y: number };
  currentTask?: string;
  isSubAgent: boolean;
  parentId?: string;
  spawnedAt: number;
  lastUpdated: number;
  phaseAge: number;
  colorSeed: number;
}
