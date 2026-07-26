"use client";

export type BusinessOverviewProps = {
  updatedAt: string;
  windowLabel: string;
  audience: {
    totalUsers: number;
    totalSubscribers: number;
    sessions30: number;
    newUsers30: number;
  };
  diagnosticCompletions: number;
  funnel: Array<{
    label: string;
    value: number | null;
    conversionFromPrevious: number | null;
    suffix?: string;
  }>;
  topRefs: Array<{ key: string; count: number }>;
};

const PYRAMID_WIDTHS = [100, 82, 64, 48];

export function OverviewClient({
  updatedAt,
  windowLabel,
  audience,
  diagnosticCompletions,
  funnel,
  topRefs,
}: BusinessOverviewProps) {
  return (
    <div className="space-y-6 pb-10">
      <header className="rounded-3xl border border-white/10 bg-[#111118] p-6 shadow-2xl shadow-black/20 md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-emerald-300/80">Business Command Center</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-5xl">Diagnóstico IA pulse</h1>
        <p className="mt-5 text-xs text-gray-500">Último snapshot: {formatDate(updatedAt)}</p>
      </header>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <MetricCard label="Usuarios totales" value={audience.totalUsers} />
        <MetricCard label="Newsletter" value={audience.totalSubscribers} />
        <MetricCard label="Sesiones Web 30D" value={audience.sessions30} />
        <MetricCard label="Nuevos Usuarios 30D" value={audience.newUsers30} />
        <MetricCard label="Diagnósticos completados" value={diagnosticCompletions} highlight />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.45fr_0.8fr]">
        <div className="rounded-3xl border border-white/10 bg-[#111118] p-5 md:p-7">
          <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-gray-500">Funnel · {windowLabel}</p>
              <h2 className="mt-1 text-xl font-semibold text-white">Pirámide invertida del diagnóstico</h2>
            </div>
            <p className="text-sm text-gray-500">Views → CTA clicks → starts → completados</p>
          </div>

          <div className="mt-7 flex flex-col items-center gap-2">
            {funnel.map((step, index) => (
              <PyramidStep
                key={step.label}
                step={step}
                width={PYRAMID_WIDTHS[index] ?? 42}
                showConversion={index > 0}
              />
            ))}
          </div>
        </div>

        <Panel title="Refs que traen diagnóstico" eyebrow="Top landing refs · 30d">
          <KeyCountList items={topRefs} empty="Sin refs registradas." />
        </Panel>
      </section>
    </div>
  );
}

function PyramidStep({
  step,
  width,
  showConversion,
}: {
  step: BusinessOverviewProps["funnel"][number];
  width: number;
  showConversion: boolean;
}) {
  return (
    <div className="flex w-full flex-col items-center">
      {showConversion && (
        <div className="mb-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[11px] font-semibold text-emerald-200/85">
          {step.conversionFromPrevious === null ? "sin tracking" : formatPercent(step.conversionFromPrevious)}
        </div>
      )}
      <div
        className="relative overflow-hidden rounded-[1.6rem] border border-white/10 bg-gradient-to-br from-emerald-400/18 via-sky-400/12 to-white/[0.03] px-5 py-5 text-center shadow-lg shadow-black/20"
        style={{ width: `${width}%` }}
      >
        <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">{step.label}</p>
        <p className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {formatValue(step.value)}{step.suffix ? <span className="ml-1 text-base text-gray-400">{step.suffix}</span> : null}
        </p>
      </div>
    </div>
  );
}

function MetricCard({ label, value, highlight = false }: { label: string; value: number | null; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${highlight ? "border-emerald-400/25 bg-emerald-400/10" : "border-white/10 bg-[#111118]"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{formatValue(value)}</p>
    </div>
  );
}

function Panel({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-[#111118] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-gray-500">{eyebrow}</p>
      <h2 className="mt-1 text-lg font-semibold text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function KeyCountList({ items, empty }: { items: Array<{ key: string; count: number }>; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.key}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-gray-300">{item.key}</span>
            <span className="font-semibold text-white">{formatValue(item.count)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${Math.max(6, (item.count / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return Math.round(value).toLocaleString("es-ES");
}

function formatPercent(value: number) {
  return `${value.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}
