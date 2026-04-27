"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface SuggestionItem {
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
  scheduled_for: string | null;
  payload: Record<string, unknown> | null;
}

function pretty(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "—";
}

function agentFor(item: SuggestionItem) {
  return item.target_agent_id || item.owner_agent || "unassigned";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function payloadString(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function isPendingSuggestion(item: SuggestionItem) {
  return item.payload?.requires_human_approval === true && ["blocked", "draft"].includes(item.status);
}

export function SuggestionsClient({ initialItems }: { initialItems: SuggestionItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [agentFilter, setAgentFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const { data, error: refreshError } = await supabase
        .from("work_items")
        .select("id,title,status,priority,owner_agent,target_agent_id,requested_by,source_type,source_id,kind,created_at,updated_at,scheduled_for,payload")
        .in("status", ["blocked", "draft"])
        .eq("payload->>requires_human_approval", "true")
        .order("created_at", { ascending: false })
        .limit(200);
      if (!alive || refreshError) return;
      setItems((data || []) as SuggestionItem[]);
    }
    const channel = supabase.channel("suggestions-work-items").on("postgres_changes", { event: "*", schema: "public", table: "work_items" }, refresh).subscribe();
    const timer = window.setInterval(refresh, 10_000);
    return () => { alive = false; supabase.removeChannel(channel); window.clearInterval(timer); };
  }, [supabase]);

  const agents = useMemo(() => Array.from(new Set(items.map(agentFor))).sort(), [items]);
  const risks = useMemo(() => Array.from(new Set(items.map((item) => payloadString(item.payload, "risk") || "unknown"))).sort(), [items]);
  const filtered = useMemo(() => items.filter((item) => isPendingSuggestion(item) && (agentFilter === "all" || agentFor(item) === agentFilter) && (riskFilter === "all" || (payloadString(item.payload, "risk") || "unknown") === riskFilter)), [items, agentFilter, riskFilter]);

  async function resolveSuggestion(item: SuggestionItem, action: "approve" | "dismiss") {
    setBusyId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/work-items/${item.id}/suggestion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: action === "approve" ? "approved_from_suggestions_page" : "dismissed_from_suggestions_page" }),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = (await res.json()) as SuggestionItem;
      setItems((current) => current.filter((candidate) => candidate.id !== updated.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suggestion action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white">Suggestions</h1>
          <p className="mt-1 text-sm text-gray-500">Human-in-the-loop recommendations. Approve to queue work; dismiss to close.</p>
        </div>
        <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-sm font-medium text-amber-100">{filtered.length} pending</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none">
          <option value="all">All agents</option>
          {agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
        </select>
        <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)} className="rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white focus:outline-none">
          <option value="all">All risks</option>
          {risks.map((risk) => <option key={risk} value={risk}>{pretty(risk)}</option>)}
        </select>
      </div>

      {error && <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
      {filtered.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-gray-800 bg-[#111118] px-4 py-16 text-center">
          <div className="text-sm font-medium text-gray-300">No pending suggestions</div>
          <div className="mt-1 text-xs text-gray-600">Agents can park risky follow-up here for approval before execution.</div>
        </section>
      ) : (
        <section className="grid gap-4 xl:grid-cols-2">
          {filtered.map((item) => {
            const risk = payloadString(item.payload, "risk") || "unknown";
            const proposedAction = payloadString(item.payload, "proposed_action") || pretty(item.kind);
            const approvalPrompt = payloadString(item.payload, "approval_prompt") || payloadString(item.payload, "summary") || "Review this recommendation before queueing.";
            return (
              <article key={item.id} className="overflow-hidden rounded-2xl border border-amber-500/20 bg-[#111118] shadow-[0_0_40px_rgba(245,158,11,0.04)]">
                <div className="border-b border-amber-500/10 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-white">{item.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500"><span>{agentFor(item)}</span><span>·</span><span>{pretty(item.source_type)}</span><span>·</span><span>{formatDate(item.created_at)}</span></div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${risk === "high" ? "border-red-400/30 bg-red-500/10 text-red-100" : risk === "medium" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-green-400/30 bg-green-500/10 text-green-100"}`}>{risk} risk</span>
                  </div>
                </div>
                <div className="space-y-4 p-4">
                  <p className="rounded-xl border border-gray-800 bg-black/20 px-3 py-3 text-sm leading-relaxed text-gray-300">{approvalPrompt}</p>
                  <div className="grid gap-2 sm:grid-cols-2"><Metric label="Proposed action" value={proposedAction} /><Metric label="Status after approval" value="ready" /></div>
                  <div className="flex flex-wrap justify-end gap-2 border-t border-amber-500/10 pt-3">
                    <button type="button" onClick={() => resolveSuggestion(item, "dismiss")} disabled={busyId === item.id} className="rounded-lg border border-gray-600 bg-white/5 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-white/10 disabled:opacity-50">Dismiss</button>
                    <button type="button" onClick={() => resolveSuggestion(item, "approve")} disabled={busyId === item.id} className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-100 hover:bg-amber-500/20 disabled:opacity-50">{busyId === item.id ? "Saving…" : "Approve & queue"}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-gray-800 bg-black/20 px-3 py-2"><div className="text-[10px] font-medium uppercase tracking-wide text-gray-600">{label}</div><div className="mt-1 truncate text-xs text-gray-200">{value}</div></div>;
}
