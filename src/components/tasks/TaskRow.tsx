"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { timeAgo } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  done: "bg-green-500",
  in_progress: "bg-yellow-500",
  new: "bg-blue-500",
  blocked: "bg-red-500",
};

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-500/20 text-red-400",
  medium: "bg-yellow-500/20 text-yellow-400",
  low: "bg-green-500/20 text-green-400",
};

function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskRow({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-gray-800 bg-[#111118]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLORS[task.status] ?? "bg-gray-500"}`}
        />
        <span className="flex-1 truncate text-sm text-white">{task.title}</span>
        <span className="text-xs text-gray-500">{task.agent}</span>
        {task.priority && (
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[task.priority] ?? "bg-gray-500/20 text-gray-400"}`}
          >
            {task.priority}
          </span>
        )}
        <span className="text-xs text-gray-600">{timeAgo(task.created_at)}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-gray-500 transition ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            {task.instruction && (
              <div className="sm:col-span-2">
                <span className="text-gray-500">Instruction</span>
                <p className="mt-1 whitespace-pre-wrap text-gray-300">
                  {task.instruction}
                </p>
              </div>
            )}
            {task.result && (
              <div className="sm:col-span-2">
                <span className="text-gray-500">Result</span>
                <p className="mt-1 whitespace-pre-wrap text-gray-300">
                  {task.result}
                </p>
              </div>
            )}
            {task.tags && task.tags.length > 0 && (
              <div>
                <span className="text-gray-500">Tags</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {task.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {task.depends_on?.length ? (
              <div>
                <span className="text-gray-500">Depends on</span>
                <p className="mt-1 text-gray-300">{task.depends_on.join(", ")}</p>
              </div>
            ) : null}
            <div>
              <span className="text-gray-500">Created</span>
              <p className="mt-1 text-gray-300">{formatDate(task.created_at)}</p>
            </div>
            {task.started_at && (
              <div>
                <span className="text-gray-500">Started</span>
                <p className="mt-1 text-gray-300">{formatDate(task.started_at)}</p>
              </div>
            )}
            {task.completed_at && (
              <div>
                <span className="text-gray-500">Completed</span>
                <p className="mt-1 text-gray-300">{formatDate(task.completed_at)}</p>
              </div>
            )}
            {task.due_date && (
              <div>
                <span className="text-gray-500">Due</span>
                <p className="mt-1 text-gray-300">{formatDate(task.due_date)}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
