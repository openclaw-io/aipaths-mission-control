"use client";

import { useEffect, useState } from "react";

type ModeValue = "forced_on" | "auto" | "forced_off";

const MODE_OPTIONS: Array<{ value: ModeValue; label: string }> = [
  { value: "forced_on", label: "On" },
  { value: "auto", label: "Auto" },
  { value: "forced_off", label: "Off" },
];

export default function ExecutionWindowTopbar() {
  const [mode, setMode] = useState<ModeValue>("auto");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/execution-window");
        const data = await res.json();
        if (!cancelled && data?.config?.override_mode) {
          setMode(data.config.override_mode as ModeValue);
        }
      } catch {
        // noop
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    const interval = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function setExecutionMode(nextMode: ModeValue) {
    const previous = mode;
    setMode(nextMode);
    setSaving(true);

    try {
      const res = await fetch("/api/execution-window", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          override_mode: nextMode,
          override_until: nextMode === "auto" ? null : "9999-12-31T23:59:59.000Z",
          override_reason: nextMode === "auto" ? null : `Set from topbar (${nextMode})`,
        }),
      });

      if (!res.ok) throw new Error("Failed to update execution window");
    } catch (error) {
      console.error(error);
      setMode(previous);
      alert("No pude actualizar el execution window mode.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-[#111118] px-2 py-1.5">
      <span className="hidden text-xs text-gray-500 sm:inline">Queue</span>
      <div className="inline-flex rounded-full border border-gray-800 bg-[#0d0d14] p-1">
        {MODE_OPTIONS.map((option) => {
          const active = mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setExecutionMode(option.value)}
              disabled={saving || !loaded}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                active
                  ? option.value === "forced_on"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : option.value === "forced_off"
                      ? "bg-rose-500/20 text-rose-300"
                      : "bg-blue-500/20 text-blue-300"
                  : "text-gray-400 hover:text-white"
              } disabled:opacity-50`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {saving && <span className="text-xs text-blue-300">Saving...</span>}
    </div>
  );
}
