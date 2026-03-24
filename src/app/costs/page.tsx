export const dynamic = "force-dynamic";

export default function CostsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white">💰 Costs</h1>
      <p className="mt-1 text-sm text-gray-500">
        Token usage and spend per agent — coming soon
      </p>
      <div className="mt-8 rounded-xl border border-gray-800 bg-[#111118] p-12 text-center">
        <p className="text-4xl mb-3">💰</p>
        <p className="text-lg text-gray-400">Cost Intelligence Dashboard</p>
        <p className="mt-2 text-sm text-gray-600">
          Sync your usage data to see cost breakdowns by agent, model, and day.
        </p>
      </div>
    </div>
  );
}
