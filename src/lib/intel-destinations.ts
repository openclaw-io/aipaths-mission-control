export type IntelDestinationKey = "blog" | "guide" | "email" | "video" | "short" | "news";

export type IntelDestinationConfig = {
  key: IntelDestinationKey;
  label: string;
  director: "content" | "marketing" | "youtube" | "community";
  pipelineType: "blog" | "doc" | "email_campaign" | "video" | "community_post";
};

export const INTEL_DESTINATION_ORDER: IntelDestinationKey[] = ["blog", "guide", "email", "video", "short", "news"];

export const INTEL_DESTINATION_CONFIG: Record<IntelDestinationKey, IntelDestinationConfig> = {
  blog: { key: "blog", label: "Blog", director: "content", pipelineType: "blog" },
  guide: { key: "guide", label: "Guide", director: "content", pipelineType: "doc" },
  email: { key: "email", label: "Email", director: "marketing", pipelineType: "email_campaign" },
  video: { key: "video", label: "Video", director: "youtube", pipelineType: "video" },
  short: { key: "short", label: "Short", director: "youtube", pipelineType: "video" },
  news: { key: "news", label: "News", director: "community", pipelineType: "community_post" },
};

export const DESTINATION_ALIASES: Record<string, IntelDestinationKey> = {
  blog: "blog",
  blogs: "blog",
  guide: "guide",
  guides: "guide",
  doc: "guide",
  docs: "guide",
  email: "email",
  mail: "email",
  email_campaign: "email",
  campaign: "email",
  video: "video",
  videos: "video",
  longform: "video",
  short: "short",
  shorts: "short",
  news: "news",
  community: "news",
  community_post: "news",
};

export const INTEL_DESTINATION_OPTIONS = INTEL_DESTINATION_ORDER.map((key) => ({
  key,
  label: INTEL_DESTINATION_CONFIG[key].label,
  director: INTEL_DESTINATION_CONFIG[key].director,
  pipelineType: INTEL_DESTINATION_CONFIG[key].pipelineType,
}));
