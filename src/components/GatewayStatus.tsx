"use client";

import { useState, useEffect, useCallback } from "react";

interface ServiceHealth {
  gateway: "healthy" | "down";
  dispatch: "healthy" | "down";
  overall: "healthy" | "degraded";
}

type OverallStatus = "checking" | "healthy" | "degraded";

export default function GatewayStatus() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [status, setStatus] = useState<OverallStatus>("checking");
  const [showMenu, setShowMenu] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health/gateway");
      const data: ServiceHealth = await res.json();
      setHealth(data);
      setStatus(data.overall === "healthy" ? "healthy" : "degraded");
      setLastCheck(new Date());
    } catch {
      setHealth({ gateway: "down", dispatch: "down", overall: "degraded" });
      setStatus("degraded");
      setLastCheck(new Date());
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  async function handleRestart() {
    if (!confirm("Restart the OpenClaw gateway? This will briefly interrupt all agent communications.")) {
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
    : status === "degraded" ? "bg-red-500"
    : "bg-gray-500";

  const label = status === "healthy" ? "Services Online"
    : status === "degraded" ? "Services Degraded"
    : "Checking...";

  const shouldPulse = status === "degraded";

  function ServiceDot({ name, ok }: { name: string; ok: boolean }) {
    return (
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
        <span className="text-sm text-gray-300">{name}</span>
        <span className={`ml-auto text-xs ${ok ? "text-green-400" : "text-red-400"}`}>
          {ok ? "Online" : "Down"}
        </span>
      </div>
    );
  }

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
          <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-700 bg-[#111118] shadow-xl">
            {/* Service list */}
            <div className="px-4 py-3 space-y-2 border-b border-gray-800">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Core Services</p>
              {health ? (
                <>
                  <ServiceDot name="Gateway" ok={health.gateway === "healthy"} />
                  <ServiceDot name="Dispatch" ok={health.dispatch === "healthy"} />
                </>
              ) : (
                <p className="text-xs text-gray-500">Checking...</p>
              )}
              {lastCheck && (
                <p className="mt-2 text-xs text-gray-600">
                  Last check: {lastCheck.toLocaleTimeString()}
                </p>
              )}
            </div>

            {/* Actions */}
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
                {restarting ? "⏳ Restarting..." : "🔃 Restart Gateway"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
