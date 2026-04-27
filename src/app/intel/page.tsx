import { createClient } from "@/lib/supabase/server";
import { ContentInboxClient } from "@/components/content/ContentInboxClient";
import { getIntelInboxDetail, getIntelInboxHealth, listIntelInbox } from "@/lib/intel-inbox";

export const dynamic = "force-dynamic";

const STATUS_PRESETS: Record<string, "new" | "saved" | "dismissed" | "promoted" | "all"> = {
  new: "new",
  saved: "saved",
  promoted: "promoted",
  dismissed: "dismissed",
  proposed: "new",
  parked: "saved",
  converted: "promoted",
  discarded: "dismissed",
  all: "all",
};

export default async function IntelInboxPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const statusParam = typeof resolvedSearchParams.status === "string" ? resolvedSearchParams.status : "new";
  const assetParam = typeof resolvedSearchParams.primaryAssetType === "string" ? resolvedSearchParams.primaryAssetType : "all";
  const ownerParam = typeof resolvedSearchParams.ownerAgent === "string" ? resolvedSearchParams.ownerAgent : "all";
  const includeOlderNew = resolvedSearchParams.older === "1" || resolvedSearchParams.includeOlder === "1";
  const initialStatus = statusParam in STATUS_PRESETS ? statusParam : "new";

  const selectedIdeaId = typeof resolvedSearchParams.idea === "string" ? resolvedSearchParams.idea : null;

  const initial = await listIntelInbox({
    status: STATUS_PRESETS[initialStatus as keyof typeof STATUS_PRESETS],
    lane: assetParam === "all" ? null : assetParam,
    owner: ownerParam === "all" ? null : ownerParam,
    includeOlderNew,
    freshDays: 3,
    limit: 50,
    offset: 0,
  });

  const allForFilters = await listIntelInbox({
    status: "all",
    limit: 200,
    offset: 0,
  });

  const initialSelectedId = selectedIdeaId && initial.items.some((item) => item.id === selectedIdeaId)
    ? selectedIdeaId
    : null;
  const initialDetail = initialSelectedId ? await getIntelInboxDetail(initialSelectedId) : null;
  const health = await getIntelInboxHealth();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Intel Inbox</h1>
      <p className="mt-1 text-sm text-gray-500">
        Review enriched intel signals and route the strongest ones into the right pipeline.
      </p>
      <div className="mt-6">
        <ContentInboxClient
          initialItems={initial.items}
          initialTotal={initial.total}
          initialStatusFilter={initialStatus}
          initialAssetFilter={assetParam}
          initialOwnerFilter={ownerParam}
          initialIncludeOlderNew={includeOlderNew}
          health={health}
          filterSourceItems={allForFilters.items}
          initialSelectedId={initialSelectedId}
          initialDetail={initialDetail}
        />
      </div>
    </div>
  );
}
