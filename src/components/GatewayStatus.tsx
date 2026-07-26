"use client";

import { useState, useEffect, useCallback } from "react";

type Status = "checking" | "healthy" | "down";

type GatewayHealth = {
  gateway?: "healthy" | "down";
  runtime?: string;
  running?: number;
  total?: number;
};

export default function GatewayStatus() {
  const [status, setStatus] = useState<Status>("checking");
  const [showMenu, setShowMenu] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [health, setHealth] = useState<GatewayHealth | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health/gateway");
      const data = await res.json();
      setHealth(data);
      setStatus(data.gateway === "healthy" ? "healthy" : "down");
      setLastCheck(new Date());
    } catch {
      setHealth(null);
      setStatus("down");
      setLastCheck(new Date());
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  async function handleRestart() {
    if (!confirm("Restart all Hermes agent gateways? This will briefly interrupt Discord agent communications.")) {
      return;
    }
    setRestarting(true);
    setShowMenu(false);
    try {
      const res = await fetch("/api/gateway/restart", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setStatus("checking");
        setTimeout(checkHealth, 5000);
      } else {
        alert(`Restart failed: ${data.error}`);
      }
    } catch (err) {
      alert(`Restart failed: ${err}`);
    } finally {
      setRestarting(false);
    }
  }

  const dotColor = status === "healthy" ? "bg-green-500"
    : status === "down" ? "bg-red-500"
    : "bg-gray-500";

  const gatewayCount = health?.running != null && health?.total != null ? ` (${health.running}/${health.total})` : "";
  const label = status === "healthy" ? `Hermes Gateways Online${gatewayCount}`
    : status === "down" ? `Hermes Gateway Down${gatewayCount}`
    : "Checking Hermes...";

  const shouldPulse = status === "down";

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:bg-[#1a1a24] hover:text-white transition"
        title={label}
      >
        <span className="relative flex h-3 w-3">
          {shouldPulse && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotColor} opacity-75`} />
          )}
          <span className={`relative inline-flex h-3 w-3 rounded-full ${dotColor}`} />
        </span>
        <span className="hidden sm:inline">{label}</span>
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-gray-700 bg-[#111118] shadow-xl">
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
                <span className="text-sm font-medium text-white">{label}</span>
              </div>
              {lastCheck && (
                <p className="mt-1 text-xs text-gray-500">
                  Last check: {lastCheck.toLocaleTimeString()}
                </p>
              )}
            </div>
            <div className="p-2">
              <button
                onClick={() => checkHealth()}
                className="w-full rounded-md px-3 py-2 text-left text-sm text-gray-300 hover:bg-[#1a1a24] transition"
              >
                🔄 Check Now
              </button>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="w-full rounded-md px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
              >
                {restarting ? "⏳ Restarting..." : "🔃 Restart Hermes Gateways"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
