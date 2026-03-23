import { createClient } from "@/lib/supabase/server";
import { MemoryClient } from "@/components/memory/MemoryClient";

export interface MemoryEntry {
  id: string;
  agent: string;
  type: string;
  title: string | null;
  content: string;
  tags: string[];
  date: string;
  created_at: string;
  updated_at: string;
  similarity?: number | null;
}

export default async function MemoryPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .order("date", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[MemoryPage] Failed to fetch memory entries:", error);
  }

  const entries: MemoryEntry[] = data ?? [];

  return <MemoryClient initialEntries={entries} />;
}
