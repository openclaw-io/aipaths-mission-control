"use client";

import { useRealtimeActivity, type ActivityEvent } from "@/hooks/useRealtimeActivity";
import { timeAgo } from "@/lib/utils";

const EVENT_EMOJI: Record<string, string> = {
  task_claimed: "🏃",
  task_completed: "✅",
  task_failed: "❌",
  task_created: "📋",
  agent_woke: "👀",
  cron_ran: "⏰",
  task_dispatched: "🚀",
};

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

const EVENT_VERB: Record<string, string> = {
  task_claimed: "claimed",
  task_completed: "completed",
  task_failed: "failed on",
  task_created: "created",
  agent_woke: "woke up for",
  cron_ran: "ran cron",
  task_dispatched: "dispatched",
};

export function ActivityFeed({ initialEvents }: { initialEvents: ActivityEvent[] }) {
  const events = useRealtimeActivity(initialEvents);

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-[#111118] p-8 text-center">
        <p className="text-gray-500">No activity yet</p>
        <p className="mt-1 text-xs text-gray-600">Events will appear here as agents work</p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {events.slice(0, 20).map((event, i) => (
        <div
          key={event.id}
          className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 transition ${
            i % 2 === 0 ? "bg-white/[0.02]" : ""
          } hover:bg-white/5`}
        >
          <span className="text-sm shrink-0 mt-0.5">
            {EVENT_EMOJI[event.event_type] || "📌"}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-300">
              <span className="text-gray-500">{AGENT_EMOJI[event.agent] || "🤖"}</span>
              {" "}
              <span className="font-medium text-white">{event.agent}</span>
              {" "}
              <span className="text-gray-500">{EVENT_VERB[event.event_type] || event.event_type}</span>
              {" "}
              <span className="text-gray-300">{event.title}</span>
            </p>
            {event.detail && (
              <p className="text-xs text-gray-600 line-clamp-1 mt-0.5">{event.detail}</p>
            )}
          </div>
          <span className="text-xs text-gray-600 shrink-0 mt-0.5">
            {timeAgo(event.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}
