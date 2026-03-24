"use client";

import { useState } from "react";
import type { Task } from "@/app/tasks/page";
import { CreateEpicModal } from "./CreateEpicModal";
import { EpicCard } from "./EpicCard";

export function ProjectsClient({
  epics,
  subTasksByParent,
  allTasks,
}: {
  epics: Task[];
  subTasksByParent: Record<string, Task[]>;
  allTasks: Task[];
}) {
  const [showCreate, setShowCreate] = useState(false);

  // Sort: active first, then by created_at desc
  const sorted = [...epics].sort((a, b) => {
    const aActive = a.status !== "done";
    const bActive = b.status !== "done";
    if (aActive !== bActive) return aActive ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-3 text-sm text-gray-400">
          <span>{epics.length} project{epics.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{epics.filter((e) => e.status !== "done").length} active</span>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition"
        >
          + New Project
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-[#111118] p-12 text-center">
          <p className="text-lg text-gray-500">No projects yet</p>
          <p className="mt-1 text-sm text-gray-600">
            Create an epic to organize related tasks into a project
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sorted.map((epic) => (
            <EpicCard
              key={epic.id}
              epic={epic}
              subTasks={subTasksByParent[epic.id] || []}
              allTasks={allTasks}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateEpicModal onClose={() => setShowCreate(false)} />
      )}
    </>
  );
}
