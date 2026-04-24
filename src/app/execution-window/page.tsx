import { getExecutionWindowConfig, isExecutionWindowOpenNow } from "@/lib/execution-window";
import { ExecutionWindowClient } from "@/components/execution-window/ExecutionWindowClient";

export const dynamic = "force-dynamic";

export default async function ExecutionWindowPage() {
  const config = await getExecutionWindowConfig();
  if (!config) {
    return <div className="text-sm text-gray-400">Execution window config missing.</div>;
  }

  const state = isExecutionWindowOpenNow(config, new Date());

  return <ExecutionWindowClient config={config} state={state} />;
}
