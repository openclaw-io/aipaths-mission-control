import { LoopsClient } from "@/components/loops/LoopsClient";
import { getLoopDetail, listLoopGalleryCards } from "@/lib/loops/read-model";

export const dynamic = "force-dynamic";

export default async function LoopsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedLoop = params?.loop;
  const selectedLoopId = typeof requestedLoop === "string" && requestedLoop.trim()
    ? requestedLoop.trim()
    : null;
  const loops = await listLoopGalleryCards();

  let selectedLoopDetail = null;
  let detailError: string | null = null;
  if (selectedLoopId) {
    try {
      selectedLoopDetail = await getLoopDetail(selectedLoopId);
      if (!selectedLoopDetail) detailError = "Loop detail was not found.";
    } catch (error) {
      console.error(`Failed to load Loop detail ${selectedLoopId}`, error);
      detailError = "This Loop detail is unavailable in the current environment.";
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📐 Loops</h1>
      <p className="mt-1 text-sm text-gray-500">
        Planning, approvals, and execution readiness for active initiatives
      </p>
      <div className="mt-6">
        <LoopsClient
          loops={loops}
          selectedLoopId={selectedLoopId}
          selectedLoopDetail={selectedLoopDetail}
          detailError={detailError}
        />
      </div>
    </div>
  );
}
