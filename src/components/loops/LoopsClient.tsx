"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CreateLoopModal } from "./CreateLoopModal";
import { LoopCard } from "./LoopCard";
import { LoopDetail } from "./LoopDetail";
import { WorkflowLegendDemo } from "./WorkflowLegendDemo";
import { QueueSchedulerStatus } from "./QueueSchedulerStatus";
import type { LoopDetailPayload, LoopGalleryCard } from "@/lib/loops/read-model";

export function LoopsClient({
  loops,
  selectedLoopId,
  selectedLoopDetail,
  detailError,
}: {
  loops: LoopGalleryCard[];
  selectedLoopId: string | null;
  selectedLoopDetail: LoopDetailPayload | null;
  detailError: string | null;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const openLoop = (loopId: string) => router.push(`/loops?loop=${encodeURIComponent(loopId)}`, { scroll: false });
  const closeLoop = () => router.push("/loops", { scroll: false });

  const completedCount = loops.filter((p) => p.status === "completed").length;
  const priorityOrder = { high: 0, medium: 1, low: 2 };

  const humanQueue = [...loops]
    .filter((p) => ["needs_clarification", "needs_approval", "in_review"].includes(p.status))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 3);

  const executionQueue = [...loops]
    .filter((p) => ["queued", "in_progress", "active"].includes(p.status) || (p.status === "planning" && p.readyToRun))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    })
    .slice(0, 3);

  const queueIds = new Set([...humanQueue, ...executionQueue].map((p) => p.id));

  const sorted = [...loops]
    .filter((p) => showCompleted || p.status !== "completed")
    .filter((p) => !queueIds.has(p.id))
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
          <span>{loops.length} loop{loops.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{loops.filter((p) => p.status !== "completed").length} active</span>
          {completedCount > 0 && (
            <>
              <span>·</span>
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                className="text-gray-500 transition hover:text-gray-300"
              >
                {showCompleted ? "Hide" : "Show"} {completedCount} completed
              </button>
            </>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          + New Loop
        </button>
      </div>

      {humanQueue.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Human Queue</h2>
              <p className="text-xs text-gray-500">Clarify, approve, or review items that currently need you.</p>
            </div>
            <div className="text-xs text-gray-500">{humanQueue.length} waiting on you</div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {humanQueue.map((loop) => (
              <button
                key={loop.id}
                onClick={() => openLoop(loop.id)}
                className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-3 text-left transition hover:border-gray-700"
              >
                <div className="truncate text-sm font-medium text-white">{loop.title}</div>
                <div className="mt-1 text-xs text-amber-300">{loop.status.replaceAll("_", " ")}</div>
                <div className="mt-1 text-xs text-gray-500">priority {loop.priority}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {executionQueue.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-800 bg-[#111118] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Execution Queue</h2>
              <p className="text-xs text-gray-500">Loops being planned or executed by the system.</p>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">{executionQueue.length} in system flow</div>
              <QueueSchedulerStatus />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {executionQueue.map((loop, index) => (
              <button
                key={loop.id}
                onClick={() => openLoop(loop.id)}
                className="rounded-lg border border-gray-800 bg-[#0d0d14] px-3 py-3 text-left transition hover:border-gray-700"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">#{index + 1}</span>
                  <div className="truncate text-sm font-medium text-white">{loop.title}</div>
                </div>
                <div className="mt-1 text-xs text-blue-300">{loop.dispatchState === "waking_agent" ? "Waking agent" : loop.dispatchState === "retrying_notify" ? "Retrying dispatch" : loop.dispatchState === "notified_agent" ? "Agent notified" : loop.status === "in_progress" || loop.status === "active" ? "Processing now" : loop.status === "planning" ? "Planning" : "Waiting for scheduler"}</div>
                <div className="mt-1 text-xs text-gray-500">{loop.status.replaceAll("_", " ")} · priority {loop.priority}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-12 text-center">
          <p className="text-lg text-gray-500">No loops yet</p>
          <p className="mt-1 text-sm text-gray-600">Create a loop to start planning work</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sorted.map((loop) => (
              <LoopCard key={loop.id} loop={loop} onOpen={() => openLoop(loop.id)} />
            ))}
          </div>
          <WorkflowLegendDemo />
        </div>
      )}

      {selectedLoopId && selectedLoopDetail && (
        <LoopDetail loop={selectedLoopDetail} onClose={closeLoop} />
      )}

      {selectedLoopId && !selectedLoopDetail && detailError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-red-900/60 bg-[#0d0d14] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Loop detail unavailable</h2>
                <p className="mt-2 text-sm text-gray-400">{detailError}</p>
              </div>
              <button onClick={closeLoop} className="rounded p-1 text-gray-500 transition hover:text-white">✕</button>
            </div>
          </div>
        </div>
      )}

      {showCreate && <CreateLoopModal onClose={() => setShowCreate(false)} />}
    </>
  );
}
