"use client";

import { useEffect, useState } from "react";

export function SchedulerToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [maxConcurrent, setMaxConcurrent] = useState("2");
  const [dailyBudget, setDailyBudget] = useState("50");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/scheduler")
      .then((r) => r.json())
      .then((config) => {
        setEnabled(config.enabled !== "false");
        setMaxConcurrent(config.max_concurrent || "2");
        setDailyBudget(config.daily_budget_usd || "50");
      })
      .catch(() => {});
  }, []);

  async function toggle() {
    const newValue = !enabled;
    setSaving(true);
    await fetch("/api/scheduler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: String(newValue) }),
    });
    setEnabled(newValue);
    setSaving(false);
  }

  async function updateConfig(key: string, value: string) {
    await fetch("/api/scheduler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
  }

  if (enabled === null) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-[#111118] p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">⚡ Task Scheduler</h3>
          <span className={`inline-flex h-2 w-2 rounded-full ${enabled ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
        </div>
        <button
          onClick={toggle}
          disabled={saving}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            enabled
              ? "border border-yellow-600/50 bg-yellow-600/10 text-yellow-400 hover:bg-yellow-600/20"
              : "border border-green-600/50 bg-green-600/10 text-green-400 hover:bg-green-600/20"
          }`}
        >
          {enabled ? "⏸ Pause" : "▶️ Start"}
        </button>
      </div>

      <div className="flex gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500">Concurrent:</span>
          <input
            type="number"
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
            onBlur={() => updateConfig("max_concurrent", maxConcurrent)}
            className="w-12 rounded border border-gray-700 bg-[#1a1a24] px-1.5 py-0.5 text-white text-center focus:outline-none"
            min={1}
            max={10}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500">Daily budget:</span>
          <span className="text-gray-400">$</span>
          <input
            type="number"
            value={dailyBudget}
            onChange={(e) => setDailyBudget(e.target.value)}
            onBlur={() => updateConfig("daily_budget_usd", dailyBudget)}
            className="w-16 rounded border border-gray-700 bg-[#1a1a24] px-1.5 py-0.5 text-white text-center focus:outline-none"
            min={1}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500">Every:</span>
          <span className="text-gray-400">10 min</span>
        </div>
      </div>
    </div>
  );
}
