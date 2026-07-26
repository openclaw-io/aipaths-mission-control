import { OverviewClient, type BusinessOverviewProps } from "@/components/overview/OverviewClient";
import { isLocalAuthDisabled } from "@/lib/auth/local";
import { query } from "@/lib/db/postgres";
import { loadYouTubeStatisticsRows } from "@/lib/youtube/statistics-read-model";
import type { YouTubeMetricSnapshot, YouTubeStatisticsRow } from "@/lib/youtube/statistics-types";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

type SnapshotRow = {
  date: string;
  academy_json: JsonRecord | null;
  youtube_json: JsonRecord | null;
  waitlist_json: JsonRecord | null;
};

type KpiRow = {
  date: string;
  total_users: number | null;
  new_users_today: number | null;
  total_subscribers: number | null;
  total_sessions: number | null;
};

export default async function OverviewPage() {
  const today = new Date();
  const since30 = toDateString(daysAgo(today, 30));
  const localSupabasePlaceholder = isLocalSupabasePlaceholder();

  const [snapshotsRes, kpisRes, youtubeRows] = await Promise.all([
    query<SnapshotRow>(
      `select date, academy_json, youtube_json, waitlist_json
         from ops_daily_snapshots
        where date >= $1
        order by date desc`,
      [since30],
    ),
    query<KpiRow>(
      `select date, total_users, new_users_today, total_subscribers, total_sessions
         from academy_daily_kpis
        where date >= $1
        order by date desc`,
      [since30],
    ),
    localSupabasePlaceholder ? Promise.resolve([] as YouTubeStatisticsRow[]) : loadYouTubeStatisticsRows(),
  ]);

  const snapshots = (snapshotsRes.rows || []).filter((row) => row.date >= since30);
  const kpis = (kpisRes.rows || []).filter((row) => row.date >= since30);
  const latestSnapshot = snapshots[0] || null;
  const latestAcademy = asRecord(latestSnapshot?.academy_json);
  const latestKpi = kpis[0] || null;
  const diagnosticTotals = summarizeDiagnostics(snapshots);
  const audience = summarizeAudience(kpis, latestAcademy);
  const youtubeViews = summarizeYouTubeViews(youtubeRows, snapshots);
  const ctaClicks = diagnosticTotals.clicks;
  const starts = diagnosticTotals.starts;
  const completions = diagnosticTotals.completions;

  const data: BusinessOverviewProps = {
    updatedAt: latestSnapshot?.date || latestKpi?.date || today.toISOString(),
    windowLabel: "Últimos 30 días",
    audience,
    diagnosticCompletions: completions,
    funnel: [
      {
        label: "Views YT",
        value: youtubeViews,
        conversionFromPrevious: null,
      },
      {
        label: "CTA clicks",
        value: ctaClicks,
        conversionFromPrevious: conversionRate(ctaClicks, youtubeViews),
      },
      {
        label: "Diagnóstico starts",
        value: starts,
        conversionFromPrevious: conversionRate(starts, ctaClicks),
      },
      {
        label: "Diagnósticos completados",
        value: completions,
        conversionFromPrevious: conversionRate(completions, starts),
      },
    ],
    topRefs: topKeyCounts(snapshots, ["academy_json", "diagnostic", "top_landing_refs"]),
  };

  return <OverviewClient {...data} />;
}

function summarizeDiagnostics(rows: SnapshotRow[]) {
  return rows.reduce(
    (total, row) => {
      const diagnostic = getDiagnostic(row);
      const responses = asRecord(diagnostic.responses);
      total.starts += numberValue(diagnostic.start_sessions ?? diagnostic.starts);
      total.completions += numberValue(diagnostic.completion_sessions ?? diagnostic.completions ?? responses.total);
      total.clicks += numberValue(diagnostic.diagnostic_landing_sessions ?? diagnostic.diagnostic_unique_visitors);
      return total;
    },
    { starts: 0, completions: 0, clicks: 0 },
  );
}

function summarizeAudience(kpis: KpiRow[], latestAcademy: JsonRecord): BusinessOverviewProps["audience"] {
  const totals = kpis.reduce(
    (acc, row) => {
      acc.newUsers30 += numberValue(row.new_users_today);
      acc.sessions30 += numberValue(row.total_sessions);
      return acc;
    },
    { newUsers30: 0, sessions30: 0 },
  );

  const latestKpi = kpis[0] || null;
  return {
    totalUsers: numberValue(latestAcademy.total_users ?? latestKpi?.total_users),
    totalSubscribers: numberValue(latestAcademy.total_subscribers ?? latestKpi?.total_subscribers),
    ...totals,
  };
}

function summarizeYouTubeViews(rows: YouTubeStatisticsRow[], snapshots: SnapshotRow[]) {
  const snapshot28d = rows
    .map((row) => row.snapshots["28d"])
    .filter(Boolean) as YouTubeMetricSnapshot[];
  const views = sum(snapshot28d, (snapshot) => numberValue(snapshot.views));

  if (views > 0) return views;

  return snapshots.reduce((total, row) => total + Math.max(0, numberValue(asRecord(row.youtube_json).views_delta)), 0);
}

function topKeyCounts(rows: SnapshotRow[], path: string[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const rawList = getPath(row as unknown as JsonRecord, path);
    if (!Array.isArray(rawList)) continue;
    for (const item of rawList) {
      const record = asRecord(item);
      const key = stringValue(record.key ?? record.source ?? record.ref ?? record.label) || "unknown";
      const count = numberValue(record.count ?? record.sessions ?? record.visitors ?? record.value);
      map.set(key, (map.get(key) || 0) + count);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }));
}

function conversionRate(value: number | null, previous: number | null) {
  if (value === null || previous === null || previous <= 0) return null;
  return (value / previous) * 100;
}

function getDiagnostic(row: SnapshotRow | null | undefined) {
  return asRecord(asRecord(row?.academy_json).diagnostic);
}

function getPath(record: JsonRecord, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  return current;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sum<T>(items: T[], getter: (item: T) => number) {
  return items.reduce((total, item) => total + getter(item), 0);
}

function daysAgo(date: Date, days: number) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function toDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isLocalSupabasePlaceholder() {
  return isLocalAuthDisabled();
}
