"use client";

import { useState } from "react";
import { PixelOffice } from "@/components/office/pixel-office";
import { OfficeEditor } from "@/components/editor/office-editor";
import { useOfficeState } from "@/hooks/use-office-state";
import { useOfficeAgents } from "@/hooks/use-office-agents";

interface TaskRow {
  id: string;
  title: string;
  agent: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface MemoryRow {
  agent: string;
  date: string;
  content: string;
}

interface OfficeClientProps {
  initialTasks: TaskRow[];
  initialMemory: MemoryRow[];
  cronOk: number;
  cronTotal: number;
}

export function OfficeClient({
  initialTasks,
  initialMemory,
  cronOk,
  cronTotal,
}: OfficeClientProps) {
  const [tab, setTab] = useState<"view" | "edit">("view");
  const officeState = useOfficeState();
  const agents = useOfficeAgents(initialTasks, initialMemory);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 0px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-3 shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white">
            🏢 Pixel Office
          </h1>
          <p className="text-xs text-gray-500">
            Real-time agent visualization
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Cron health badge */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mr-2">
            <span
              className={`w-2 h-2 rounded-full ${
                cronOk === cronTotal ? "bg-green-500" : "bg-yellow-500"
              }`}
            />
            <span>
              Crons: {cronOk}/{cronTotal} OK
            </span>
          </div>
          {/* Tab toggle */}
          <div className="flex rounded-lg bg-white/5 p-0.5">
            <button
              onClick={() => setTab("view")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                tab === "view"
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              View
            </button>
            <button
              onClick={() => setTab("edit")}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                tab === "edit"
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              Edit
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === "view" ? (
          <PixelOffice layout={officeState.layout} agents={agents} />
        ) : (
          <OfficeEditor
            layout={officeState.layout}
            selectedId={officeState.selectedId}
            onSelect={officeState.setSelectedId}
            onAddFurniture={officeState.addFurniture}
            onMoveFurniture={officeState.moveFurniture}
            onRemoveFurniture={officeState.removeFurniture}
            onUpdateLabel={officeState.updateFurnitureLabel}
            onSetTile={officeState.setTile}
            onReset={officeState.resetLayout}
            onExport={officeState.exportLayout}
            onImport={officeState.importLayout}
          />
        )}
      </div>
    </div>
  );
}
