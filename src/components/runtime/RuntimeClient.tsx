"use client";

import { useEffect, useMemo, useState } from "react";

type LaunchdStatus = {
  label: string;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  last_exit_status: number | null;
} | null;

type Listener = {
  command: string;
  pid: number;
  user: string;
  endpoint: string;
  address: string;
  port: number;
};

type RuntimeService = {
  id: string;
  name: string;
  owner: string | null;
  type: string | null;
  environment: string | null;
  runtime: string | null;
  status: string;
  configured_status?: string | null;
  health: string;
  ports: number[];
  port: number | null;
  port_listening: boolean | null;
  launchd: LaunchdStatus;
  urls: { local: string | null; tailnet: string | null };
  exposure: { public: string | null; tailscale: string | null };
  repo: string | null;
  source_path: string | null;
  schedule: string | null;
  logs: Record<string, string> | null;
  notes: string | null;
  warnings: string[];
};

type TailscaleRoute = {
  url: string | null;
  path: string;
  proxy: string;
};

type RuntimeSnapshot = {
  generated_at: string;
  host: string;
  summary: {
    total: number;
    running: number;
    unhealthy: number;
    stopped: number;
    planned: number;
    external: number;
    warnings: number;
    public_exposure: number;
    unregistered_listeners: number;
  };
  tailscale: {
    serve?: TailscaleRoute[];
    funnel?: TailscaleRoute[];
    funnel_public: boolean;
  };
  services: RuntimeService[];
  unregistered_listeners: Listener[];
  error?: string;
};

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-green-500", text: "text-green-300", label: "Running" },
  unhealthy: { dot: "bg-red-500", text: "text-red-300", label: "Unhealthy" },
  stopped: { dot: "bg-gray-500", text: "text-gray-300", label: "Stopped" },
  planned: { dot: "bg-purple-500", text: "text-purple-300", label: "Planned" },
  external: { dot: "bg-blue-500", text: "text-blue-300", label: "External" },
  manual: { dot: "bg-yellow-500", text: "text-yellow-300", label: "Manual" },
  unknown: { dot: "bg-gray-500", text: "text-gray-300", label: "Unknown" },
};

function statusStyle(status: string) {
  return STATUS_STYLES[status] || STATUS_STYLES.unknown;
}

function formatPorts(service: RuntimeService) {
  if (!service.ports?.length) return "—";
  return service.ports.join(", ");
}

function statusPill(status: string) {
  const style = statusStyle(status);
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium ${style.text}`}>
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

function Card({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#111118] p-5">
      <div className={`text-3xl font-bold ${accent || "text-white"}`}>{value}</div>
      <div className="mt-1 text-sm text-gray-400">{label}</div>
    </div>
  );
}

function LinkOrDash({ href }: { href: string | null }) {
  if (!href) return <span className="text-gray-600">—</span>;
  return (
    <a className="text-blue-300 hover:text-blue-200" href={href} target="_blank" rel="noreferrer">
      abrir
    </a>
  );
}

export default function RuntimeClient() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/runtime/services", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSnapshot(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const sortedServices = useMemo(() => {
    if (!snapshot) return [];
    const rank: Record<string, number> = { unhealthy: 0, stopped: 1, running: 2, manual: 3, planned: 4, external: 5 };
    return [...snapshot.services].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name));
  }, [snapshot]);

  const planned = sortedServices.filter((service) => service.status === "planned");

  if (loading && !snapshot) {
    return <div className="mt-8 rounded-xl border border-white/10 bg-[#111118] p-6 text-gray-400">Cargando runtime…</div>;
  }

  if (error && !snapshot) {
    return <div className="mt-8 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-red-200">No pude cargar runtime: {error}</div>;
  }

  if (!snapshot) return null;

  return (
    <div className="mt-8 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-500">
          Host: <span className="text-gray-300">{snapshot.host}</span> · generado: {new Date(snapshot.generated_at).toLocaleString("en-GB")}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50"
        >
          {loading ? "Actualizando…" : "Refresh"}
        </button>
      </div>

      {error && <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">Último refresh falló: {error}</div>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Card label="Total" value={snapshot.summary.total} />
        <Card label="Running" value={snapshot.summary.running} accent="text-green-300" />
        <Card label="Unhealthy" value={snapshot.summary.unhealthy} accent="text-red-300" />
        <Card label="Planned" value={snapshot.summary.planned} accent="text-purple-300" />
        <Card label="Public exposure" value={snapshot.summary.public_exposure} accent={snapshot.summary.public_exposure ? "text-red-300" : "text-green-300"} />
        <Card label="Unregistered" value={snapshot.summary.unregistered_listeners} accent={snapshot.summary.unregistered_listeners ? "text-yellow-300" : "text-gray-300"} />
      </div>

      <section className="rounded-xl border border-white/10 bg-[#111118] p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Services</h2>
            <p className="text-sm text-gray-500">Servicios, jobs, puertos, health y LaunchAgents registrados.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-white/10 text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Service</th>
                <th className="px-3 py-3">Owner</th>
                <th className="px-3 py-3">Runtime</th>
                <th className="px-3 py-3">Ports</th>
                <th className="px-3 py-3">URL</th>
                <th className="px-3 py-3">LaunchAgent</th>
                <th className="px-3 py-3">Health</th>
                <th className="px-3 py-3">Warnings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sortedServices.map((service) => (
                <tr key={service.id} className="align-top text-gray-300">
                  <td className="px-3 py-3">{statusPill(service.status)}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-white">{service.name}</div>
                    <div className="text-xs text-gray-500">{service.type || "—"}</div>
                  </td>
                  <td className="px-3 py-3 text-gray-400">{service.owner || "—"}</td>
                  <td className="px-3 py-3 text-gray-400">{service.runtime || "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs text-gray-300">{formatPorts(service)}</td>
                  <td className="px-3 py-3"><LinkOrDash href={service.urls.tailnet || service.urls.local} /></td>
                  <td className="max-w-[220px] px-3 py-3 font-mono text-xs text-gray-400">{service.launchd?.label || "—"}</td>
                  <td className="px-3 py-3 text-gray-400">{service.health}</td>
                  <td className="max-w-[320px] px-3 py-3">
                    {service.warnings.length ? (
                      <ul className="space-y-1 text-xs text-yellow-300">
                        {service.warnings.map((warning) => <li key={warning}>⚠ {warning}</li>)}
                      </ul>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-white/10 bg-[#111118] p-5">
          <h2 className="text-lg font-semibold text-white">Tailscale exposure</h2>
          <p className="mt-1 text-sm text-gray-500">Serve debe ser tailnet-only. Funnel público requiere aprobación explícita.</p>
          <div className={`mt-4 rounded-lg border p-3 text-sm ${snapshot.tailscale.funnel_public ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-green-500/30 bg-green-500/10 text-green-200"}`}>
            Funnel público: {snapshot.tailscale.funnel_public ? "ACTIVO" : "no detectado"}
          </div>
          <div className="mt-4 space-y-2">
            {(snapshot.tailscale.serve || []).map((route, index) => (
              <div key={`${route.url}-${route.path}-${index}`} className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                <div className="text-blue-300">{route.url}{route.path}</div>
                <div className="text-gray-500">proxy → {route.proxy}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 bg-[#111118] p-5">
          <h2 className="text-lg font-semibold text-white">Unregistered listeners</h2>
          <p className="mt-1 text-sm text-gray-500">Puertos escuchando que no están mapeados en el registry.</p>
          <div className="mt-4 space-y-2">
            {snapshot.unregistered_listeners.length === 0 ? (
              <p className="text-sm text-gray-500">No hay listeners sin registrar.</p>
            ) : snapshot.unregistered_listeners.map((listener) => (
              <div key={`${listener.pid}-${listener.port}-${listener.endpoint}`} className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-100">
                <span className="font-mono">:{listener.port}</span> · {listener.command} pid {listener.pid} · {listener.endpoint}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-white/10 bg-[#111118] p-5">
        <h2 className="text-lg font-semibold text-white">Planned modules</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {planned.map((service) => (
            <div key={service.id} className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
              <div className="font-medium text-purple-200">{service.name}</div>
              <div className="mt-1 text-sm text-gray-400">{service.notes || "—"}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-[#111118] p-5">
        <h2 className="text-lg font-semibold text-white">Runbooks</h2>
        <div className="mt-3 grid gap-2 text-sm text-gray-400 md:grid-cols-2">
          <code>director-systems/config/services.json</code>
          <code>director-systems/scripts/collect-runtime-status.mjs</code>
          <code>director-systems/docs/INTERNAL-SERVICE-RUNBOOK.md</code>
          <code>director-systems/docs/WHATSAPP-META-MODULE-ARCHITECTURE.md</code>
        </div>
      </section>
    </div>
  );
}
