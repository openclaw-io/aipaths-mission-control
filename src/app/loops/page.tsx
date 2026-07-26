import { LoopsClient } from "@/components/loops/LoopsClient";
import { getLoopDetail, listLoopGalleryCards, type LoopDetailPayload } from "@/lib/loops/read-model";

export const dynamic = "force-dynamic";

export default async function LoopsPage() {
  const loops = await listLoopGalleryCards();
  const detailsEntries = await Promise.all(loops.map(async (loop) => [loop.id, await getLoopDetail(loop.id)] as const));
  const loopDetails: Record<string, LoopDetailPayload> = Object.fromEntries(
    detailsEntries.filter((entry): entry is readonly [string, LoopDetailPayload] => entry[1] !== null)
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📐 Loops</h1>
      <p className="mt-1 text-sm text-gray-500">
        Planning, approvals, and execution readiness for active initiatives
      </p>
      <div className="mt-6">
        <LoopsClient loops={loops} loopDetails={loopDetails} />
      </div>
    </div>
  );
}
