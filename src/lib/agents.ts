export const AGENT_IDS = [
  "strategist", "youtube", "content", "marketing",
  "dev", "community", "editor", "legal", "gonza",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentMeta {
  id: AgentId;
  name: string;
  emoji: string;
  role: string;
  badgeClass: string;
}

export const AGENTS: AgentMeta[] = [
  { id: "strategist", name: "Strategist", emoji: "🎯", role: "Strategy, research, weekly reports", badgeClass: "bg-purple-500/20 text-purple-400" },
  { id: "youtube", name: "YouTube Director", emoji: "🎬", role: "Video strategy, thumbnails, SEO", badgeClass: "bg-red-500/20 text-red-400" },
  { id: "content", name: "Content Director", emoji: "✍️", role: "Blog posts, docs, guides", badgeClass: "bg-green-500/20 text-green-400" },
  { id: "marketing", name: "Marketing Director", emoji: "📣", role: "Email campaigns, growth", badgeClass: "bg-orange-500/20 text-orange-400" },
  { id: "dev", name: "Dev Director", emoji: "💻", role: "Website, deployments, infrastructure", badgeClass: "bg-blue-500/20 text-blue-400" },
  { id: "community", name: "Community Director", emoji: "🏘️", role: "Discord community management", badgeClass: "bg-teal-500/20 text-teal-400" },
  { id: "editor", name: "Editor", emoji: "🎨", role: "Content editing, quality", badgeClass: "bg-pink-500/20 text-pink-400" },
  { id: "legal", name: "Legal", emoji: "⚖️", role: "Legal compliance, terms", badgeClass: "bg-gray-500/20 text-gray-400" },
  { id: "gonza", name: "Gonza", emoji: "👤", role: "Owner, oversight, approvals", badgeClass: "bg-indigo-500/20 text-indigo-400" },
];

export const AGENT_MAP = new Map(AGENTS.map((a) => [a.id, a]));

export function getAgentBadgeClass(agentId: string): string {
  return AGENT_MAP.get(agentId as AgentId)?.badgeClass ?? "bg-gray-500/20 text-gray-400";
}
