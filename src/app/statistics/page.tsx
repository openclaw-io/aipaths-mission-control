import { YouTubeLearningDashboard } from "@/components/youtube/YouTubeLearningDashboard";
import { loadYouTubeStatisticsRows } from "@/lib/youtube/statistics-read-model";

export const dynamic = "force-dynamic";

export default async function StatisticsPage() {
  const rows = await loadYouTubeStatisticsRows();
  return <YouTubeLearningDashboard initialRows={rows} />;
}
