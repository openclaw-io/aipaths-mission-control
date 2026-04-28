"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { isPublicationWorkItem } from "@/lib/publication/scheduling";

type Tab = "live" | "calendar" | "recurring";

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

export interface RecurringWorkRule {
  id: string;
  title: string;
  instruction: string;
  owner_agent: string;
  target_agent_id: string | null;
  requested_by: string | null;
  priority: string | null;
  cadence_unit: "days" | "weeks";
  cadence_interval: number;
  time_of_day: string;
  timezone: string;
  start_date: string;
  end_date: string | null;
  horizon_days: number;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  last_materialized_at: string | null;
  created_at: string;
  updated_at: string | null;
  recurring_work_occurrences?: Array<{ id: string; scheduled_for: string; work_item_id: string | null; status: string }>;
}


const AGENT_ACCENTS: Record<string, { border: string; bg: string; text: string; mutedBorder: string; mutedBg: string; mutedText: string; hoverBorder: string }> = {
  content: { border: "border-l-cyan-300/70", bg: "bg-cyan-300/8", text: "text-cyan-100", mutedBorder: "border-l-cyan-200/25", mutedBg: "bg-cyan-200/[0.035]", mutedText: "text-cyan-100/45", hoverBorder: "hover:border-cyan-200/30" },
  dev: { border: "border-l-emerald-300/70", bg: "bg-emerald-300/8", text: "text-emerald-100", mutedBorder: "border-l-emerald-200/25", mutedBg: "bg-emerald-200/[0.035]", mutedText: "text-emerald-100/45", hoverBorder: "hover:border-emerald-200/30" },
  community: { border: "border-l-violet-300/70", bg: "bg-violet-300/8", text: "text-violet-100", mutedBorder: "border-l-violet-200/25", mutedBg: "bg-violet-200/[0.035]", mutedText: "text-violet-100/45", hoverBorder: "hover:border-violet-200/30" },
  marketing: { border: "border-l-yellow-300/70", bg: "bg-yellow-300/8", text: "text-yellow-100", mutedBorder: "border-l-yellow-200/25", mutedBg: "bg-yellow-200/[0.035]", mutedText: "text-yellow-100/45", hoverBorder: "hover:border-yellow-200/30" },
  strategist: { border: "border-l-orange-300/70", bg: "bg-orange-300/8", text: "text-orange-100", mutedBorder: "border-l-orange-200/25", mutedBg: "bg-orange-200/[0.035]", mutedText: "text-orange-100/45", hoverBorder: "hover:border-orange-200/30" },
  systems: { border: "border-l-sky-300/70", bg: "bg-sky-300/8", text: "text-sky-100", mutedBorder: "border-l-sky-200/25", mutedBg: "bg-sky-200/[0.035]", mutedText: "text-sky-100/45", hoverBorder: "hover:border-sky-200/30" },
  youtube: { border: "border-l-rose-300/70", bg: "bg-rose-300/8", text: "text-rose-100", mutedBorder: "border-l-rose-200/25", mutedBg: "bg-rose-200/[0.035]", mutedText: "text-rose-100/45", hoverBorder: "hover:border-rose-200/30" },
};

const DEFAULT_ACCENT = { border: "border-l-slate-300/60", bg: "bg-slate-300/8", text: "text-slate-100", mutedBorder: "border-l-slate-200/25", mutedBg: "bg-slate-200/[0.035]", mutedText: "text-slate-100/45", hoverBorder: "hover:border-slate-200/30" };

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


function agentAccent(agent: string) {
  return AGENT_ACCENTS[agent] || DEFAULT_ACCENT;
}

function isCompletedForCalendar(item: WorkItem) {
  return item.status === "done" || item.status === "canceled";
}

function isScheduledInPast(item: WorkItem, now: number) {
  return !!item.scheduled_for && new Date(item.scheduled_for).getTime() < now;
}

function calendarItemSort() {
  return (a: WorkItem, b: WorkItem) => {
    const at = a.scheduled_for ? new Date(a.scheduled_for).getTime() : 0;
    const bt = b.scheduled_for ? new Date(b.scheduled_for).getTime() : 0;
    if (at !== bt) return at - bt;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  };
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

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

export function WorkItemsClient({ initialItems, initialEvents, initialRules = [] }: { initialItems: WorkItem[]; initialEvents: WorkEvent[]; initialRules?: RecurringWorkRule[] }) {
  const [items, setItems] = useState(initialItems);
  const [events, setEvents] = useState(initialEvents);
  const [rules, setRules] = useState(initialRules);
  const [tab, setTab] = useState<Tab>("live");
  const [agentFilter, setAgentFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
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
      fetch("/api/work-items/recurring-rules").then((res) => res.ok ? res.json() : null).then((body) => {
        if (alive && body?.rules) setRules(body.rules as RecurringWorkRule[]);
      }).catch(() => {});
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
  const calendarItems = useMemo(() => filteredItems.filter((item) => {
    if (!item.scheduled_for || ["draft"].includes(item.status)) return false;
    const scheduleKind = payloadString(item.payload, "schedule_kind");
    if (scheduleKind === "dispatch_retry") return false;
    if (["publication", "calendar", "recurring"].includes(scheduleKind || "")) return true;
    if (isPublicationWorkItem(item)) return true;
    return payloadString(item.payload, "trigger") === "recurring_work_rule";
  }).sort(calendarItemSort()), [filteredItems]);
  const blocked = filteredItems.filter((item) => item.status === "blocked" && item.payload?.requires_human_approval !== true).sort(sortBySchedule);
  const inProgress = filteredItems.filter((item) => item.status === "in_progress").sort((a, b) => new Date(a.started_at || a.created_at).getTime() - new Date(b.started_at || b.created_at).getTime());
  const failed = filteredItems.filter((item) => item.status === "failed").sort((a, b) => new Date(b.completed_at || b.updated_at || b.created_at).getTime() - new Date(a.completed_at || a.updated_at || a.created_at).getTime());

  const scheduledByDay = useMemo(() => {
    const groups = new Map<string, WorkItem[]>();
    for (const item of calendarItems) {
      const key = localDateKey(new Date(item.scheduled_for!));
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, dayItems]) => [day, dayItems.sort(calendarItemSort())] as const);
  }, [calendarItems]);

  const selectedItem = selectedItemId ? items.find((item) => item.id === selectedItemId) || null : null;

  function updateItem(updated: WorkItem) {
    setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
  }

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "live", label: "Live Board", count: readyNow.length + blocked.length + inProgress.length + failed.length },
    { id: "calendar", label: "Calendar", count: scheduledLater.length },
    { id: "recurring", label: "Recurring Tasks", count: rules.length },
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

      {tab === "live" && <LiveBoardTab inProgress={inProgress} readyNow={readyNow} blocked={blocked} failed={failed} events={events} items={items} onOpen={setSelectedItemId} onRequeue={(item) => {
        setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "ready", started_at: null, completed_at: null, updated_at: new Date().toISOString() } : candidate));
      }} />}
      {tab === "calendar" && <CalendarTab grouped={scheduledByDay} onOpen={setSelectedItemId} now={now} />}
      {tab === "recurring" && <RecurringTasksTab rules={rules} onRulesChange={setRules} />}
      {selectedItem && <WorkItemDrawer item={selectedItem} events={events.filter((event) => event.entity_id === selectedItem.id)} onClose={() => setSelectedItemId(null)} onUpdated={updateItem} />}
    </div>
  );
}

function LiveBoardTab({
  inProgress,
  readyNow,
  blocked,
  failed,
  events,
  items,
  onOpen,
  onRequeue,
}: {
  inProgress: WorkItem[];
  readyNow: WorkItem[];
  blocked: WorkItem[];
  failed: WorkItem[];
  events: WorkEvent[];
  items: WorkItem[];
  onOpen: (id: string) => void;
  onRequeue: (item: WorkItem) => void;
}) {
  return (
    <div className="mt-6 space-y-4">
      <ProgressTab items={inProgress} events={events} onOpen={onOpen} />
      <div className="grid gap-4 xl:grid-cols-3">
        <QueueColumn title="Next up" subtitle="Ready now" items={readyNow} onOpen={onOpen} />
        <QueueColumn title="Blocked" subtitle="Waiting dependencies" items={blocked} onOpen={onOpen} />
        <FailedColumn items={failed} onOpen={onOpen} onRequeue={onRequeue} />
      </div>
      <RecentActivity events={events} items={items} onOpen={onOpen} />
    </div>
  );
}

function ProgressTab({ items, events, onOpen }: { items: WorkItem[]; events: WorkEvent[]; onOpen: (id: string) => void }) {
  return (
    <section className="rounded-2xl border border-purple-500/20 bg-gradient-to-br from-purple-500/10 via-[#111118] to-[#111118] p-4 shadow-[0_0_40px_rgba(168,85,247,0.06)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Running now</h2>
          <p className="text-xs text-purple-200/50">Active work currently owned by agents</p>
        </div>
        <span className="rounded-full border border-purple-400/20 bg-purple-500/10 px-2.5 py-1 text-xs font-medium text-purple-100">{items.length} active</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-purple-500/20 bg-black/10 px-4 py-4 text-center text-sm text-purple-100/40">No work items in progress.</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const lastEvent = events.find((event) => event.entity_id === item.id);
            const mins = minutesSince(item.started_at);
            return (
              <button key={item.id} type="button" onClick={() => onOpen(item.id)} className="w-full rounded-xl border border-purple-400/30 bg-[#15111f] p-4 text-left shadow-lg shadow-purple-950/10 transition hover:border-purple-300/50 hover:bg-[#1a1328]">
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
                  <div className="mt-3 rounded-lg border border-purple-500/10 bg-black/20 px-3 py-2 text-xs text-gray-400">
                    Last event: <span className="text-gray-200">{pretty(lastEvent.event_type)}</span> · {formatDate(lastEvent.created_at)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CalendarTab({ grouped, onOpen, now }: { grouped: Array<readonly [string, WorkItem[]]>; onOpen: (id: string) => void; now: number }) {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const rangeEnd = new Date(weekStart);
  rangeEnd.setDate(weekStart.getDate() + 34);

  const todayKey = localDateKey(today);
  const [selectedDay, setSelectedDay] = useState(todayKey);
  const itemsByDay = new Map(grouped);
  const selectedItems = (itemsByDay.get(selectedDay) || []).sort(calendarItemSort());
  const days = Array.from({ length: 35 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + index);
    return day;
  });

  return (
    <section className="mt-6 rounded-2xl border border-gray-800/80 bg-[#101017] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">
          {new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit" }).format(weekStart)} – {new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", year: "numeric" }).format(rangeEnd)}
        </h2>
        <span className="text-xs text-gray-600">current week + 4 weeks</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-gray-800/80">
        <div className="grid grid-cols-7 bg-[#0b0b11] text-[10px] font-medium uppercase tracking-[0.18em] text-gray-600">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div key={label} className="border-r border-gray-800/70 px-2 py-2 last:border-r-0">{label}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 border-t border-gray-800/70">
          {days.map((day) => {
            const key = localDateKey(day);
            const dayItems = itemsByDay.get(key) || [];
            const isToday = key === todayKey;
            const isSelected = key === selectedDay;
            const isPastDay = day.getTime() < new Date(todayKey + "T00:00:00").getTime();
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDay(key)}
                className={`group flex min-h-32 flex-col items-start justify-start border-b border-r border-gray-800/70 bg-[#0d0d14] p-2 text-left align-top transition last:border-r-0 hover:bg-[#12121b] ${isSelected ? "bg-[#13131d] shadow-[inset_0_0_0_1px_rgba(148,163,184,0.18)]" : ""}`}
              >
                <div className="mb-2 flex w-full items-start justify-start">
                  <div className={`flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-[11px] transition ${isToday ? "bg-red-500/15 text-red-200 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.22)]" : isSelected ? "bg-white/[0.06] text-gray-200" : isPastDay ? "text-gray-700" : "text-gray-500"}`}>{day.getDate()}</div>
                </div>
                <div className="w-full space-y-1.5">
                  {dayItems.slice(0, 4).map((item) => (
                    <CalendarMiniItem key={item.id} item={item} now={now} />
                  ))}
                  {dayItems.length > 4 && <div className="text-[11px] text-gray-600">+{dayItems.length - 4} more</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-gray-800/80 bg-[#0d0d14] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-white">
              {new Intl.DateTimeFormat("en-GB", { weekday: "long", month: "long", day: "2-digit" }).format(new Date(`${selectedDay}T12:00:00`))}
            </h3>
            <p className="text-xs text-gray-600">Scheduled work ordered by time</p>
          </div>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-400">{selectedItems.length}</span>
        </div>
        {selectedItems.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-700">No work scheduled for this day.</p>
        ) : (
          <div className="space-y-2">
            {selectedItems.map((item) => (
              <CalendarDayItem key={item.id} item={item} now={now} onOpen={() => onOpen(item.id)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CalendarMiniItem({ item, now }: { item: WorkItem; now: number }) {
  const agent = agentFor(item);
  const accent = agentAccent(agent);
  const completed = isCompletedForCalendar(item);
  const past = isScheduledInPast(item, now);
  const muted = completed;
  return (
    <div
      title={`${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.scheduled_for!))} · ${agent} · ${pretty(item.status)} · ${pretty(item.source_type)}`}
      className={`rounded-md border border-transparent border-l-2 px-2 py-1 text-[11px] transition ${muted ? `${accent.mutedBorder} ${accent.mutedBg} ${accent.mutedText}` : `${accent.border} ${accent.bg} ${accent.text} ${accent.hoverBorder}`} ${past && !completed ? "opacity-85" : ""}`}
    >
      <div className="truncate font-medium">{item.title}</div>
      <div className={`mt-0.5 ${muted ? "text-gray-500/70" : "text-gray-400/75"}`}>{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.scheduled_for!))}</div>
    </div>
  );
}

function CalendarDayItem({ item, now, onOpen }: { item: WorkItem; now: number; onOpen: () => void }) {
  const agent = agentFor(item);
  const accent = agentAccent(agent);
  const completed = isCompletedForCalendar(item);
  const past = isScheduledInPast(item, now);
  const muted = completed;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${agent} · ${pretty(item.status)} · ${item.id.slice(0, 8)}`}
      className={`group grid w-full gap-3 rounded-xl border border-gray-800/80 border-l-2 px-3 py-3 text-left text-sm transition hover:border-gray-700 hover:bg-white/[0.025] md:grid-cols-[80px_1fr_120px] ${muted ? `${accent.mutedBorder} ${accent.mutedBg}` : `${accent.border} ${accent.bg}`} ${past && !completed ? "opacity-90" : ""}`}
    >
      <div className={`text-xs tabular-nums ${muted ? "text-gray-600" : "text-gray-400"}`}>{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.scheduled_for!))}</div>
      <div className="min-w-0">
        <div className={`truncate font-medium ${muted ? accent.mutedText : "text-white"}`}>{item.title}</div>
        <div className="mt-1 hidden text-xs text-gray-500 group-hover:block">{agent} · {pretty(item.source_type)} · {pretty(item.kind)}</div>
      </div>
      <div className="flex items-center justify-end">
        <StatusPill status={item.status} />
      </div>
    </button>
  );
}


function RecurringTasksTab({ rules, onRulesChange }: { rules: RecurringWorkRule[]; onRulesChange: (rules: RecurringWorkRule[]) => void }) {
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  async function toggleRule(rule: RecurringWorkRule, nextEnabled: boolean) {
    setBusyRuleId(rule.id);
    try {
      const res = await fetch("/api/work-items/recurring-rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, enabled: nextEnabled }),
      });
      if (!res.ok) throw new Error(await res.text());

      const refreshed = await fetch("/api/work-items/recurring-rules").then((response) => response.ok ? response.json() : null);
      if (refreshed?.rules) onRulesChange(refreshed.rules as RecurringWorkRule[]);
    } finally {
      setBusyRuleId(null);
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Recurring Tasks</h2>
          <p className="mt-1 text-xs text-gray-500">Pause, resume, and inspect rules that keep future work visible in Calendar.</p>
        </div>
        <span className="rounded-full border border-gray-700 bg-white/5 px-2.5 py-1 text-xs text-gray-300">{rules.length} rules</span>
      </div>

      {rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-black/10 px-4 py-10 text-center">
          <div className="text-sm font-medium text-gray-300">No recurring tasks yet</div>
          <div className="mt-1 text-xs text-gray-600">Create them through Systems and they will show up here.</div>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {rules.map((rule) => {
            const expanded = expandedRuleId === rule.id;
            const busy = busyRuleId === rule.id;
            const occurrences = [...(rule.recurring_work_occurrences || [])].sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());
            const nextOccurrence = occurrences.find((occurrence) => new Date(occurrence.scheduled_for).getTime() >= Date.now()) || occurrences[0];
            const cadenceLabel = rule.cadence_interval === 1
              ? `Every ${rule.cadence_unit.slice(0, -1)}`
              : `Every ${rule.cadence_interval} ${rule.cadence_unit}`;

            return (
              <article key={rule.id} className={`overflow-hidden rounded-2xl border border-gray-800 bg-[#0d0d14] transition hover:border-gray-700 hover:bg-[#10101a] ${rule.enabled ? "" : "opacity-70"}`}>
                <div className="p-4">
                  <button type="button" onClick={() => setExpandedRuleId(expanded ? null : rule.id)} className="flex w-full items-start justify-between gap-3 text-left">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-white">{rule.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-blue-200">{agentFor({ owner_agent: rule.owner_agent, target_agent_id: rule.target_agent_id } as WorkItem)}</span>
                        <span>{cadenceLabel}</span>
                        <span>·</span>
                        <span>{rule.time_of_day} {rule.timezone}</span>
                        <span>·</span>
                        <span>{nextOccurrence ? `next ${formatDate(nextOccurrence.scheduled_for)}` : "no future runs"}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <AppleSwitch
                        enabled={rule.enabled}
                        busy={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleRule(rule, !rule.enabled);
                        }}
                      />
                      <span className={`text-xs text-gray-500 transition ${expanded ? "rotate-180" : ""}`}>⌄</span>
                    </div>
                  </button>
                </div>

                {expanded && (
                  <div className="space-y-4 border-t border-gray-800/80 p-4">
                    <p className="rounded-xl border border-gray-800 bg-black/20 px-3 py-3 text-sm leading-relaxed text-gray-300">{rule.instruction}</p>

                    <div className="grid gap-2 sm:grid-cols-3">
                      <MiniMetric label="Next run" value={nextOccurrence ? formatDate(nextOccurrence.scheduled_for) : "—"} />
                      <MiniMetric label="Horizon" value={`${rule.horizon_days} days`} />
                      <MiniMetric label="Scheduled" value={`${occurrences.length} items`} />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                      <span>source: recurring rule</span>
                      {rule.last_materialized_at && <><span>·</span><span>last materialized {formatDate(rule.last_materialized_at)}</span></>}
                      {!rule.enabled && <><span>·</span><span>paused</span></>}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AppleSwitch({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={enabled}
      aria-label={enabled ? "Pause recurring task" : "Resume recurring task"}
      className={`relative h-6 w-11 rounded-full transition disabled:cursor-wait disabled:opacity-60 ${enabled ? "bg-green-400/80" : "bg-gray-700"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${enabled ? "left-5" : "left-0.5"}`} />
    </button>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-black/20 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-600">{label}</div>
      <div className="mt-1 truncate text-xs text-gray-200">{value}</div>
    </div>
  );
}

function RecentActivity({ events, items, onOpen }: { events: WorkEvent[]; items: WorkItem[]; onOpen: (id: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(10);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const usefulEvents = events.filter((event) => event.event_type !== "recurring_work.materialized");
  const visibleEvents = usefulEvents.slice(0, visibleCount);
  const hasMore = visibleCount < usefulEvents.length;

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">Work activity</h2>
          <p className="text-xs text-gray-500">Useful Work Queue events only</p>
        </div>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-400">{usefulEvents.length}</span>
      </div>
      {usefulEvents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-black/10 px-3 py-4 text-center text-xs text-gray-600">No recent activity.</div>
      ) : (
        <>
          <div className="divide-y divide-gray-900/80 overflow-hidden rounded-xl border border-gray-800/80 bg-[#0d0d14]">
            {visibleEvents.map((event) => {
              const item = event.entity_id ? itemById.get(event.entity_id) : undefined;
              const canOpen = !!event.entity_id && !!item;
              const content = (
                <>
                  <div className="text-xs tabular-nums text-gray-500">{formatDate(event.created_at)}</div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-200">{pretty(event.event_type)}</div>
                    <div className="mt-0.5 truncate text-xs text-gray-500">{item?.title || payloadString(event.payload, "title") || event.entity_id || "—"}</div>
                  </div>
                  <div className="text-xs text-gray-500 md:text-right">{event.actor || payloadString(event.payload, "agent") || "system"}</div>
                </>
              );

              return canOpen ? (
                <button key={event.id} type="button" onClick={() => onOpen(event.entity_id!)} className="grid w-full gap-3 px-3 py-2.5 text-left transition hover:bg-white/[0.025] md:grid-cols-[150px_1fr_120px]">
                  {content}
                </button>
              ) : (
                <div key={event.id} className="grid gap-3 px-3 py-2.5 md:grid-cols-[150px_1fr_120px]">
                  {content}
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <button type="button" onClick={() => setVisibleCount((current) => Math.min(current + 10, usefulEvents.length))} className="rounded-lg border border-gray-700 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:border-gray-600 hover:bg-white/[0.06] hover:text-white">
                View more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function QueueColumn({ title, subtitle, items, onOpen }: { title: string; subtitle: string; items: WorkItem[]; onOpen: (id: string) => void }) {
  return (
    <section className="rounded-2xl border border-gray-800 bg-[#111118] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          <p className="text-xs text-gray-500">{subtitle}</p>
        </div>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-gray-400">{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? <div className="rounded-xl border border-dashed border-gray-800 bg-black/10 px-3 py-4 text-center text-xs text-gray-600">Empty</div> : items.slice(0, 20).map((item) => <WorkCard key={item.id} item={item} onOpen={() => onOpen(item.id)} />)}
      </div>
    </section>
  );
}

function FailedColumn({ items, onOpen, onRequeue }: { items: WorkItem[]; onOpen: (id: string) => void; onRequeue: (item: WorkItem) => void }) {
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
    <section className={`rounded-2xl border p-4 ${items.length > 0 ? "border-red-500/30 bg-red-500/10" : "border-gray-800 bg-[#111118]"}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white">Failed</h2>
          <p className={items.length > 0 ? "text-xs text-red-200/60" : "text-xs text-gray-500"}>needs manual review · requeue when safe</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ${items.length > 0 ? "bg-red-500/10 text-red-200" : "bg-white/5 text-gray-400"}`}>{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? <div className="rounded-xl border border-dashed border-gray-800 bg-black/10 px-3 py-4 text-center text-xs text-gray-600">No failed work items.</div> : items.slice(0, 20).map((item) => (
          <WorkCard key={item.id} item={item} onOpen={() => onOpen(item.id)}>
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


function toDateTimeLocal(value: string | null | undefined) {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60 * 1000);
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function PayloadPreview({ payload }: { payload: Record<string, unknown> | null }) {
  if (!payload) return <p className="text-xs text-gray-600">No payload.</p>;
  return (
    <pre className="max-h-56 overflow-auto rounded-lg border border-gray-800 bg-black/30 p-3 text-[11px] leading-relaxed text-gray-400">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

function WorkItemDrawer({
  item,
  events,
  onClose,
  onUpdated,
}: {
  item: WorkItem;
  events: WorkEvent[];
  onClose: () => void;
  onUpdated: (item: WorkItem) => void;
}) {
  const [scheduledFor, setScheduledFor] = useState(() => toDateTimeLocal(item.scheduled_for));
  const [busy, setBusy] = useState<"run-now" | "reschedule" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canReschedule = ["ready", "draft", "blocked"].includes(item.status);
  const canRunNow = item.status === "ready";
  const currentUrl = payloadString(item.payload, "current_url") || payloadString(item.payload, "url");

  useEffect(() => {
    setScheduledFor(toDateTimeLocal(item.scheduled_for));
  }, [item.id, item.scheduled_for]);

  async function reschedule(value: string, mode: "run-now" | "reschedule") {
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch(`/api/work-items/${item.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduled_for: value,
          reason: mode === "run-now" ? "manual_run_now_from_work_item_drawer" : "manual_reschedule_from_work_item_drawer",
          mode,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onUpdated((await res.json()) as WorkItem);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-gray-800 bg-[#0b0b12] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 border-b border-gray-800 bg-[#0b0b12]/95 p-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusPill status={item.status} />
                <span className="text-xs text-gray-500">{item.id.slice(0, 8)}</span>
              </div>
              <h2 className="text-lg font-semibold text-white">{item.title}</h2>
              <p className="mt-1 text-xs text-gray-500">{agentFor(item)} · {pretty(item.source_type)} · {pretty(item.kind)}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5">Close</button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          <section className="rounded-xl border border-gray-800 bg-[#111118] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-white">Actions</h3>
              {!canReschedule && <span className="text-xs text-gray-600">Actions available for ready/draft/blocked only</span>}
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(event) => setScheduledFor(event.target.value)}
                disabled={!canReschedule || busy !== null}
                className="rounded-lg border border-gray-700 bg-[#0d0d14] px-3 py-2 text-sm text-white focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => reschedule(new Date(scheduledFor).toISOString(), "reschedule")}
                disabled={!canReschedule || busy !== null || !scheduledFor}
                className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-sm font-medium text-blue-100 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "reschedule" ? "Saving…" : "Reschedule"}
              </button>
              <button
                type="button"
                onClick={() => reschedule("now", "run-now")}
                disabled={!canRunNow || busy !== null}
                className="rounded-lg border border-green-400/30 bg-green-500/10 px-3 py-2 text-sm font-medium text-green-100 hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "run-now" ? "Running…" : "Run now"}
              </button>
            </div>
            {error && <p className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
          </section>

          <section className="grid gap-3 md:grid-cols-2">
            <Metric label="Scheduled" value={formatDate(item.scheduled_for)} />
            <Metric label="Started" value={formatDate(item.started_at)} />
            <Metric label="Completed" value={formatDate(item.completed_at)} />
            <Metric label="Updated" value={formatDate(item.updated_at)} />
            <Metric label="Requested by" value={item.requested_by || "—"} />
            <Metric label="Source" value={item.source_id ? `${pretty(item.source_type)} · ${item.source_id.slice(0, 8)}` : pretty(item.source_type)} />
          </section>

          {currentUrl && (
            <section className="rounded-xl border border-gray-800 bg-[#111118] p-4">
              <h3 className="mb-2 font-semibold text-white">Current URL</h3>
              <a href={currentUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-blue-300 hover:text-blue-200">{currentUrl}</a>
            </section>
          )}

          <section className="rounded-xl border border-gray-800 bg-[#111118] p-4">
            <h3 className="mb-3 font-semibold text-white">Event timeline</h3>
            {events.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-600">No events in current log window.</p>
            ) : (
              <div className="space-y-3">
                {events.map((event) => (
                  <div key={event.id} className="rounded-lg border border-gray-800 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{pretty(event.event_type)}</div>
                      <div className="text-xs text-gray-500">{formatDate(event.created_at)}</div>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">{event.actor || "system"}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-800 bg-[#111118] p-4">
            <h3 className="mb-3 font-semibold text-white">Payload</h3>
            <PayloadPreview payload={item.payload} />
          </section>
        </div>
      </aside>
    </div>
  );
}

function WorkCard({ item, compact = false, children, onOpen }: { item: WorkItem; compact?: boolean; children?: ReactNode; onOpen?: () => void }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#0d0d14] p-3 transition hover:border-gray-700 hover:bg-[#11111b]">
      <button type="button" onClick={onOpen} className="flex w-full items-start justify-between gap-2 text-left">
        <div className={`font-medium text-white ${compact ? "text-xs" : "text-sm"}`}>{item.title}</div>
        <StatusPill status={item.status} />
      </button>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
        <span>{agentFor(item)}</span>
        <span>·</span>
        <span>{pretty(item.priority)}</span>
        <span>·</span>
        <span>{pretty(item.source_type)}</span>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-gray-500">
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
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-gray-200">{value}</div>
    </div>
  );
}
