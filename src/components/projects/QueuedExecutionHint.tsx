"use client";

import { useEffect, useState } from "react";

export function QueuedExecutionHint({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/execution-window");
        const data = await res.json();
        if (!cancelled) setOpen(Boolean(data?.state?.open));
      } catch {
        if (!cancelled) setOpen(null);
      }
    }

    load();
    const interval = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (open === null) {
    return (
      <div className={`text-xs text-gray-500 ${compact ? "" : "rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-2"}`}>
        Checking execution window...
      </div>
    );
  }

  if (open) {
    return (
      <div className={`text-xs text-blue-300 ${compact ? "" : "rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2"}`}>
        Queued, waiting for scheduler slot.
      </div>
    );
  }

  return (
    <div className={`text-xs text-amber-300 ${compact ? "" : "rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2"}`}>
      Queued, waiting for execution window.
    </div>
  );
}
