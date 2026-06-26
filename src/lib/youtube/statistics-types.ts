export type YouTubeLearningWindow = "7d" | "28d" | "lifetime" | "launch_day" | "first_7d" | "first_28d";

export interface YouTubeMetricSnapshot {
  academy_video_id: string;
  window_key: YouTubeLearningWindow;
  window_start_date: string | null;
  window_end_date: string | null;
  views: number | null;
  impressions: number | null;
  yt_ctr: number | null;
  avg_view_duration_seconds: number | null;
  avg_percent_viewed: number | null;
  retention_30s: number | null;
  retention_50pct: number | null;
  retention_75pct: number | null;
  watch_time_minutes: number | null;
  subscribers_gained: number | null;
  traffic_source_top: string | null;
  launch_day_impressions: number | null;
  launch_day_yt_ctr: number | null;
  first_7d_impressions: number | null;
  first_7d_yt_ctr: number | null;
  first_7d_reach_days_covered: number | null;
  source_freshness_json: Record<string, unknown>;
  raw_metrics_json: Record<string, unknown>;
  computed_at: string;
}

export interface YouTubeManualLearning {
  format?: string | null;
  pillar?: string | null;
  video_type?: string | null;
  promise?: string | null;
  primary_cta?: string | null;
  hook_type?: string | null;
  title_angle?: string | null;
  thumbnail_angle?: string | null;
  manual_result?: string | null;
  what_worked?: string | null;
  what_failed?: string | null;
  hypothesis?: string | null;
  next_test?: string | null;
  ctas?: Array<{
    destination: string;
    clicks: number | null;
    leads: number | null;
    revenue: number | null;
    ref: string;
  }>;
  updated_at?: string | null;
  updated_by?: string | null;
}

export interface YouTubeStatisticsRow {
  item: {
    id: string;
    pipeline_type: string;
    title: string;
    slug: string | null;
    status: string;
    priority: string | null;
    owner_agent: string | null;
    requested_by: string | null;
    source_type: string | null;
    source_id: string | null;
    scheduled_for: string | null;
    published_at: string | null;
    current_url: string | null;
    content_path: string | null;
    content_format: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };
  video: {
    academy_video_id: string;
    platform_video_id: string;
    title: string;
    published_at: string | null;
    video_kind: "longform" | "short";
    is_published: boolean | null;
    metadata_json: Record<string, unknown> | null;
  } | null;
  snapshots: Partial<Record<YouTubeLearningWindow, YouTubeMetricSnapshot>>;
  manual: YouTubeManualLearning;
}
