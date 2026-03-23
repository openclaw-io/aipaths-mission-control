import { AGENTS } from "@/lib/agents";
import type { AgentStatus, SpriteAgent, SpriteAnimation } from "@/lib/types/office";

interface TaskRow {
  id: string;
  title: string;
  agent: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface MemoryRow {
  agent: string;
  date: string;
  content: string;
}

interface AgentState {
  status: AgentStatus;
  animation: SpriteAnimation;
  currentTask?: string;
}

const TWO_MINUTES = 2 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export function resolveAgentStatus(
  tasks: TaskRow[],
  todayMemory?: MemoryRow,
): AgentState {
  if (tasks.length === 0) {
    return withMemoryBubble({ status: "idle", animation: "idle" }, todayMemory);
  }

  const inProgress = tasks.find((t) => t.status === "in_progress");
  if (inProgress) {
    return { status: "busy", animation: "working", currentTask: inProgress.title };
  }

  const recentDone = tasks.find(
    (t) => t.status === "done" && t.completed_at &&
      Date.now() - new Date(t.completed_at).getTime() < TWO_MINUTES,
  );
  if (recentDone) {
    return { status: "idle", animation: "celebrating", currentTask: recentDone.title };
  }

  const allBlocked = tasks.every((t) => t.status === "blocked");
  if (allBlocked) {
    return withMemoryBubble({ status: "idle", animation: "sleeping" }, todayMemory);
  }

  const mostRecent = tasks.reduce((latest, t) => {
    const d = new Date(t.created_at).getTime();
    return d > latest ? d : latest;
  }, 0);
  if (Date.now() - mostRecent > ONE_HOUR) {
    return withMemoryBubble({ status: "offline", animation: "sleeping" }, todayMemory);
  }

  return withMemoryBubble({ status: "idle", animation: "idle" }, todayMemory);
}

function withMemoryBubble(state: AgentState, memory?: MemoryRow): AgentState {
  if (!memory || state.currentTask) return state;
  const content = memory.content.length > 40
    ? memory.content.slice(0, 39) + "\u2026"
    : memory.content;
  return { ...state, currentTask: content };
}

export function buildSpriteAgents(
  tasks: TaskRow[],
  memoryEntries: MemoryRow[],
): SpriteAgent[] {
  const today = new Date().toISOString().slice(0, 10);
  const tasksByAgent = new Map<string, TaskRow[]>();
  const todayMemory = new Map<string, MemoryRow>();

  for (const t of tasks) {
    const list = tasksByAgent.get(t.agent) ?? [];
    list.push(t);
    tasksByAgent.set(t.agent, list);
  }

  for (const m of memoryEntries) {
    if (m.date === today && !todayMemory.has(m.agent)) {
      todayMemory.set(m.agent, m);
    }
  }

  return AGENTS.map((agent, i) => {
    const agentTasks = tasksByAgent.get(agent.id) ?? [];
    const memory = todayMemory.get(agent.id);
    const state = resolveAgentStatus(agentTasks, memory);

    return {
      id: agent.id,
      name: agent.name,
      agentStatus: state.status,
      animation: state.animation,
      lifecycle: "active" as const,
      position: { x: 0, y: 0 },
      currentTask: state.currentTask,
      isSubAgent: false,
      spawnedAt: Date.now() - (i + 1) * 300000,
      lastUpdated: Date.now(),
      phaseAge: 10000,
      colorSeed: i * 42,
    };
  });
}
