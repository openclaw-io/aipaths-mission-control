import { createClient } from "@/lib/supabase/server";
import { MemoryClient } from "@/components/memory/MemoryClient";

export interface MemoryEntry {
  id: string;
  agent: string;
  type: string;
  title: string | null;
  content?: string | null;
  tags: string[];
  date: string;
  created_at: string;
  updated_at: string;
  content_loaded?: boolean;
  similarity?: number | null;
}

export default async function MemoryPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("memories")
    .select("id, agent, type, title, tags, date, created_at, updated_at")
    .order("date", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[MemoryPage] Failed to fetch memory entries:", error);
  }

  const entries: MemoryEntry[] = (data ?? []).map((entry) => ({
    ...entry,
    content: null,
    content_loaded: false,
  }));

  return <MemoryClient initialEntries={entries} />;
}
