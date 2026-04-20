export const AGENT_ROUTING = {
  strategist: { agentId: "strategist", channelId: "1474045438989697115" },
  youtube: { agentId: "youtube", channelId: "1473373627750682664" },
  content: { agentId: "content", channelId: "1473373703197691934" },
  marketing: { agentId: "marketing", channelId: "1473373756557623481" },
  dev: { agentId: "dev", channelId: "1473373777755639982" },
  community: { agentId: "community", channelId: "1473373793375490058" },
  editor: { agentId: "editor", channelId: "1473373703197691934" },
  legal: { agentId: "legal", channelId: "1473373703197691934" },
} as const;

export type RoutedAgent = keyof typeof AGENT_ROUTING;

export function isRoutedAgent(agent: string): agent is RoutedAgent {
  return agent in AGENT_ROUTING;
}
