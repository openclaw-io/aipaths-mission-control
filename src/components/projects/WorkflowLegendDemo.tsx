"use client";

import { useState } from "react";

const STEPS = ["Clarify", "Plan", "Approve", "Execute", "Review", "Done"];

export function WorkflowLegendDemo() {
  const [hoverStep, setHoverStep] = useState<number>(2);

  return (
    <section className="rounded-2xl border border-gray-800 bg-[#111118] p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">Workflow Demo</h3>
        <p className="mt-1 text-sm text-gray-500">
          Hover the bar to explore the project workflow stages. This is just a visual guide.
        </p>
      </div>

      <div>
        <div className="flex items-center gap-2">
          {STEPS.map((step, index) => (
            <div
              key={step}
              className="flex min-w-0 flex-1 items-center gap-2"
              onMouseEnter={() => setHoverStep(index)}
            >
              <div className={`h-2 flex-1 rounded-full ${index <= hoverStep ? "bg-blue-400" : "bg-gray-800"}`} />
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide">
          {STEPS.map((step, index) => (
            <span
              key={step}
              className={`min-w-0 flex-1 truncate text-center ${index <= hoverStep ? "text-gray-200" : "text-gray-600"}`}
            >
              {step}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
