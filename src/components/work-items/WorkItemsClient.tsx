"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

type Tab = "live" | "calendar" | "logs";

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  owner_agent: string | null;
  target_agent_id: string | null;
  requested_by: string | null;
  source_type: string | null;
  source_id: string | null;
  kind: string | null;
  created_at: string;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
}

export interface WorkEvent {
  id: string;
  domain: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-500/20 text-slate-300 border-slate-500/20",
  ready: "bg-blue-500/20 text-blue-300 border-blue-500/20",
  blocked: "bg-yellow-500/20 text-yellow-300 border-yellow-500/20",
  in_progress: "bg-purple-500/20 text-purple-300 border-purple-500/20",
  done: "bg-green-500/20 text-green-300 border-green-500/20",
  failed: "bg-red-500/20 text-red-300 border-red-500/20",
  canceled: "bg-gray-500/20 text-gray-300 border-gray-500/20",
};

function pretty(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "—";
}

function agentFor(item: WorkItem) {
  return item.target_agent_id || item.owner_agent || "unassigned";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function minutesSince(value: string | null | undefined) {
  if (!value) return null;
  return Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
}

function payloadString(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function sortBySchedule(a: WorkItem, b: WorkItem) {
  const at = a.scheduled_for ? new Date(a.scheduled_for).getTime() : 0;
  const bt = b.scheduled_for ? new Date(b.scheduled_for).getTime() : 0;
  if (at !== bt) return at - bt;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

export function WorkItemsClient({ initialItems, initialEvents }: { initialItems: WorkItem[]; initialEvents: WorkEvent[] }) {
  const [items, setItems] = useState(initialItems);
  const [events, setEvents] = useState(initialEvents);
  const [tab, setTab] = useState<Tab>("live");
  const [agentFilter, setAgentFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [now, setNow] = useState(() => Date.now());

  const supabase = createClient();

  useEffect(() => {
    let alive = true;

    async function refresh() {
      const [itemsRes, eventsRes] = await Promise.all([
        supabase
          .from("work_items")
          .select("id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,started_at,completed_at,scheduled_for,payload")
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("event_log")
          .select("id,domain,event_type,entity_type,entity_id,actor,payload,created_at")
          .eq("domain", "work")
          .order("created_at", { ascending: false })
          .limit(100),
      ]);

      if (!alive) return;
      if (!itemsRes.error) setItems((itemsRes.data || []) as WorkItem[]);
      if (!eventsRes.error) setEvents((eventsRes.data || []) as WorkEvent[]);
    }

    const workChannel = supabase
      .channel("work-queue-items")
      .on("postgres_changes", { event: "*", schema: "public", table: "work_items" }, refresh)
      .subscribe();

    const eventChannel = supabase
      .channel("work-queue-events")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "event_log", filter: "domain=eq.work" }, refresh)
      .subscribe();

    const timer = window.setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 10_000);

    return () => {
      alive = false;
      supabase.removeChannel(workChannel);
      supabase.removeChannel(eventChannel);
      window.clearInterval(timer);
    };
  }, [supabase]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (agentFilter !== "all" && agentFor(item) !== agentFilter) return false;
      if (sourceFilter !== "all" && (item.source_type || "unknown") !== sourceFilter) return false;
      return true;
    });
  }, [items, agentFilter, sourceFilter]);

  const agents = useMemo(() => Array.from(new Set(items.map(agentFor))).sort(), [items]);
  const sources = useMemo(() => Array.from(new Set(items.map((item) => item.source_type || "unknown"))).sort(), [items]);

  const readyNow = filteredItems.filter((item) => item.status === "ready" && (!item.scheduled_for || new Date(item.scheduled_for).getTime() <= now)).sort(sortBySchedule);
  const scheduledLater = filteredItems.filter((item) => ["ready", "draft", "blocked"].includes(item.status) && item.scheduled_for && new Date(item.scheduled_for).getTime() > now).sort(sortBySchedule);
  const blocked = filteredItems.filter((item) => item.status === "blocked").sort(sortBySchedule);
  const inProgress = filteredItems.filter((item) => item.status === "in_progress").sort((a, b) => new Date(a.started_at || a.created_at).getTime() - new Date(b.started_at || b.created_at).getTime());
  const failed = filteredItems.filter((item) => item.status === "failed").sort((a, b) => new Date(b.completed_at || b.updated_at || b.created_at).getTime() - new Date(a.completed_at || a.updated_at || a.created_at).getTime());

  const scheduledByDay = useMemo(() => {
    const groups = new Map<string, WorkItem[]>();
    for (const item of scheduledLater) {
      const key = item.scheduled_for!.slice(0, 10);
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 21)
      .map(([day, dayItems]) => [day, dayItems.sort(sortBySchedule)] as const);
  }, [scheduledLater]);

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "live", label: "Live Board", count: readyNow.length + blocked.length + inProgress.length + failed.length },
    { id: "calendar", label: "Calendar", count: scheduledLater.length },
    { id: "logs", label: "Logs", count: events.length },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-[#0a0a0f] p-1">
          {tabs.map((candidate) => (
            <button
              key={candidate.id}
              onClick={() => setTab(candidate.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === candidate.id ? "bg-[#1a1a24] text-white" : "text-gray-500 hover:text-white"}`}
            >
              {candidate.label}
              {typeof candidate.count === "number" && <span className="ml-2 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-gray-300">{candidate.count}</span>}
            </button>
          ))}
        </div>

        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none">
          <option value="all">All agents</option>
          {agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
        </select>

        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none">
          <option value="all">All sources</option>
          {sources.map((source) => <option key={source} value={source}>{pretty(source)}</option>)}
        </select>
      </div>

      {tab === "live" && <LiveBoardTab inProgress={inProgress} readyNow={readyNow} blocked={blocked} failed={failed} events={events} onRequeue={(item) => {
        setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "ready", started_at: null, completed_at: null, updated_at: new Date().toISOString() } : candidate));
      }} />}
      {tab === "calendar" && <CalendarTab grouped={scheduledByDay} />}
      {tab === "logs" && <LogsTab events={events} items={items} />}
    </div>
  );
}

function LiveBoardTab({
  inProgress,
  readyNow,
  blocked,
  failed,
  events,
  onRequeue,
}: {
  inProgress: WorkItem[];
  readyNow: WorkItem[];
  blocked: WorkItem[];
  failed: WorkItem[];
  events: WorkEvent[];
  onRequeue: (item: WorkItem) => void;
}) {
  return (
    <div className="mt-6 space-y-4">
      <ProgressTab items={inProgress} events={events} />
      <QueueColumn title="Next up" subtitle="ready now · scheduler can pick these" items={readyNow} />
      <QueueColumn title="Blocked" subtitle="waiting dependencies before this can run" items={blocked} />
      <FailedColumn items={failed} onRequeue={onRequeue} />
    </div>
  );
}

function ProgressTab({ items, events }: { items: WorkItem[]; events: WorkEvent[] }) {
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Running now</h2>
        <span className="text-xs text-gray-500">{items.length} active</span>
      </div>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-600">No work items in progress.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const lastEvent = events.find((event) => event.entity_id === item.id);
            const mins = minutesSince(item.started_at);
            return (
              <div key={item.id} className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">{item.title}</div>
                    <div className="mt-1 text-xs text-gray-500">{item.id.slice(0, 8)} · {agentFor(item)} · {pretty(item.source_type)}</div>
                  </div>
                  <StatusPill status={item.status} />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-gray-400 sm:grid-cols-3">
                  <Metric label="Started" value={formatDate(item.started_at)} />
                  <Metric label="Running" value={mins === null ? "—" : `${mins}m`} />
                  <Metric label="Dispatch" value={payloadString(item.payload, "dispatch_state") || "—"} />
                </div>
                {lastEvent && (
                  <div className="mt-3 rounded-lg bg-black/20 px-3 py-2 text-xs text-gray-400">
                    Last event: <span className="text-gray-200">{pretty(lastEvent.event_type)}</span> · {formatDate(lastEvent.created_at)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CalendarTab({ grouped }: { grouped: Array<readonly [string, WorkItem[]]> }) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - ((monthStart.getDay() + 6) % 7));

  const itemsByDay = new Map(grouped);
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });

  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(today)}</h2>
        <span className="text-xs text-gray-500">scheduled future work</span>
      </div>
      <div className="grid grid-cols-7 border-l border-t border-gray-800 text-xs text-gray-500">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
          <div key={label} className="border-b border-r border-gray-800 px-2 py-2 font-medium uppercase tracking-wide">{label}</div>
        ))}
        {days.map((day) => {
          const key = day.toISOString().slice(0, 10);
          const dayItems = itemsByDay.get(key) || [];
          const isCurrentMonth = day.getMonth() === today.getMonth();
          const isToday = key === today.toISOString().slice(0, 10);
          return (
            <div key={key} className={`min-h-32 border-b border-r border-gray-800 p-2 ${isCurrentMonth ? "bg-[#0d0d14]" : "bg-black/20 opacity-50"}`}>
              <div className={`mb-2 flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday ? "bg-blue-500 text-white" : "text-gray-500"}`}>{day.getDate()}</div>
              <div className="space-y-1">
                {dayItems.slice(0, 4).map((item) => (
                  <div key={item.id} className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-[11px] text-blue-100">
                    <div className="truncate font-medium">{item.title}</div>
                    <div className="mt-0.5 text-blue-200/60">{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.scheduled_for!))} · {agentFor(item)}</div>
                  </div>
                ))}
                {dayItems.length > 4 && <div className="text-[11px] text-gray-500">+{dayItems.length - 4} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LogsTab({ events, items }: { events: WorkEvent[]; items: WorkItem[] }) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  return (
    <section className="mt-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Work logs</h2>
        <span className="text-xs text-gray-500">latest {events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-600">No work events found.</p>
      ) : (
        <div className="divide-y divide-gray-900">
          {events.map((event) => {
            const item = event.entity_id ? itemById.get(event.entity_id) : undefined;
            return (
              <div key={event.id} className="grid gap-3 py-3 text-sm md:grid-cols-[180px_1fr_140px]">
                <div className="text-xs text-gray-500">{formatDate(event.created_at)}</div>
                <div>
                  <div className="font-medium text-white">{pretty(event.event_type)}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {item?.title || payloadString(event.payload, "title") || event.entity_id || "—"}
                  </div>
                </div>
                <div className="text-xs text-gray-400 md:text-right">{event.actor || payloadString(event.payload, "agent") || "system"}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function QueueColumn({ title, subtitle, items }: { title: string; subtitle: string; items: WorkItem[] }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          <p className="text-xs text-gray-600">{subtitle}</p>
        </div>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-400">{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? <p className="py-6 text-center text-xs text-gray-700">Empty</p> : items.slice(0, 20).map((item) => <WorkCard key={item.id} item={item} />)}
      </div>
    </section>
  );
}

function FailedColumn({ items, onRequeue }: { items: WorkItem[]; onRequeue: (item: WorkItem) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function requeue(item: WorkItem) {
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/work-items/${item.id}/requeue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual_requeue_from_failed_board" }),
      });
      if (!res.ok) throw new Error(await res.text());
      onRequeue(item);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">Failed</h2>
          <p className="text-xs text-red-200/50">needs manual review · requeue when safe</p>
        </div>
        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-200">{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? <p className="py-6 text-center text-xs text-red-200/30">No failed work items.</p> : items.slice(0, 20).map((item) => (
          <WorkCard key={item.id} item={item}>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-red-500/10 pt-3">
              <div className="space-y-1 text-xs text-red-200/60">
                <div>{payloadString(item.payload, "dispatch_failure_reason") || payloadString(item.payload, "error") || "No failure reason stored"}</div>
                {payloadString(item.payload, "dead_letter_reason") && <div>Dead letter: {payloadString(item.payload, "dead_letter_reason")}</div>}
              </div>
              <button
                type="button"
                onClick={() => requeue(item)}
                disabled={busyId === item.id}
                className="rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyId === item.id ? "Requeuing…" : "Requeue"}
              </button>
            </div>
          </WorkCard>
        ))}
      </div>
    </section>
  );
}

function WorkCard({ item, compact = false, children }: { item: WorkItem; compact?: boolean; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-[#0d0d14] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className={`font-medium text-white ${compact ? "text-xs" : "text-sm"}`}>{item.title}</div>
        <StatusPill status={item.status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
        <span>{agentFor(item)}</span>
        <span>·</span>
        <span>{pretty(item.priority)}</span>
        <span>·</span>
        <span>{pretty(item.source_type)}</span>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-gray-600">
        {item.scheduled_for && <div>Scheduled: <span className="text-gray-400">{formatDate(item.scheduled_for)}</span></div>}
        {item.completed_at && <div>Completed: <span className="text-gray-400">{formatDate(item.completed_at)}</span></div>}
        {payloadString(item.payload, "dispatch_state") && <div>Dispatch: <span className="text-gray-400">{payloadString(item.payload, "dispatch_state")}</span></div>}
        {typeof item.payload?.wake_failure_count === "number" && <div>Wake failures: <span className="text-gray-400">{item.payload.wake_failure_count}</span></div>}
        {typeof item.payload?.stale_claim_requeue_count === "number" && <div>Retries: <span className="text-gray-400">{item.payload.stale_claim_requeue_count}</span></div>}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLES[status] || "border-gray-500/20 bg-gray-500/20 text-gray-300"}`}>{pretty(status)}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 text-gray-300">{value}</div>
    </div>
  );
}
