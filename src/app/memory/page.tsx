import { createClient } from "@/lib/supabase/server";
import { MemoryClient } from "@/components/memory/MemoryClient";

export interface MemoryEntry {
  id: string;
  agent: string;
  date: string;
  content: string;
  created_at: string;
}

export default async function MemoryPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("agent_memory")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[MemoryPage] Failed to fetch memory entries:", error);
  }

  const entries: MemoryEntry[] = data ?? [];

  return <MemoryClient initialEntries={entries} />;
}
