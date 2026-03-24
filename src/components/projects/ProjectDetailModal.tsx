"use client";

import { useEffect, useState } from "react";
import type { Task } from "@/app/tasks/page";
import { createClient } from "@/lib/supabase/client";
import { AIActionButton } from "./AIActionButton";

const AGENT_EMOJI: Record<string, string> = {
  strategist: "🧠", youtube: "🎬", content: "✍️", marketing: "📣",
  dev: "💻", community: "🌐", editor: "📝", legal: "⚖️", gonza: "👤",
};

const AGENTS = [
  { id: "dev", name: "💻 Dev" },
  { id: "strategist", name: "🧠 Strategist" },
  { id: "youtube", name: "🎬 YouTube" },
  { id: "content", name: "✍️ Content" },
  { id: "marketing", name: "📣 Marketing" },
  { id: "community", name: "🌐 Community" },
  { id: "gonza", name: "👤 Gonza" },
];

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-500", new: "bg-blue-500", in_progress: "bg-green-500",
  done: "bg-gray-600", blocked: "bg-yellow-500", failed: "bg-red-500",
  pending_approval: "bg-yellow-500",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", new: "Ready", in_progress: "In Progress",
  done: "Done", blocked: "Queued", failed: "Failed",
  pending_approval: "Needs Approval",
};

function InlineAddForm({
  parentId,
  projectAgent,
  isEpic,
  onCreated,
}: {
  parentId: string;
  projectAgent: string;
  isEpic: boolean;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [agent, setAgent] = useState(projectAgent);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const supabase = createClient();
    await supabase.from("agent_tasks").insert({
      title: title.trim(),
      agent,
      parent_id: parentId,
      status: "draft",
      priority: "medium",
      tags: isEpic ? ["epic"] : [],
      depends_on: [],
    });
    setTitle("");
    setSaving(false);
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 mt-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={isEpic ? "New epic name..." : "New task name..."}
        className="flex-1 rounded-lg border border-gray-700 bg-[#1a1a24] px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        autoFocus
      />
      {!isEpic && (
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="rounded-lg border border-gray-700 bg-[#1a1a24] px-2 py-1.5 text-xs text-white focus:outline-none"
        >
          {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      <button
        type="submit"
        disabled={saving || !title.trim()}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {saving ? "..." : "Add"}
      </button>
    </form>
  );
}

export function ProjectDetailModal({
  project,
  epics,
  subTasksByParent,
  onClose,
}: {
  project: Task;
  epics: Task[];
  subTasksByParent: Record<string, Task[]>;
  onClose: () => void;
}) {
  const [addingEpic, setAddingEpic] = useState(false);
  const [addingTaskTo, setAddingTaskTo] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function activateEpic(epicId: string) {
    if (!confirm("Activate this epic? Its tasks will become available for the scheduler.")) return;
    await fetch(`/api/tasks/${epicId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "new" }),
    });
    window.location.reload();
  }

  // Count all tasks across epics
  const allTasks = epics.flatMap((e) => subTasksByParent[e.id] || []);
  const doneCount = allTasks.filter((t) => t.status === "done").length;
  const totalCount = allTasks.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-[#0d0d14] shadow-2xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0d0d14] border-b border-gray-800 px-6 py-4">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-white">{project.title}</h2>
              {project.description && (
                <p className="mt-1 text-sm text-gray-400 whitespace-pre-wrap">{project.description}</p>
              )}
              {totalCount > 0 && (
                <div className="flex items-center gap-3 mt-3">
                  <div className="flex-1 h-2 rounded-full bg-gray-800 overflow-hidden max-w-64">
                    <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-sm text-gray-400">{doneCount}/{totalCount} tasks · {pct}%</span>
                </div>
              )}
            </div>
            <button onClick={onClose} className="rounded p-1 text-gray-500 hover:text-white transition shrink-0 ml-4">✕</button>
          </div>
        </div>

        {/* Body: Epics */}
        <div className="px-6 py-4 space-y-4">
          {epics.length === 0 && !addingEpic && (
            <p className="text-sm text-gray-600 text-center py-6">
              No epics yet — break this project into phases
            </p>
          )}

          {epics.map((epic) => {
            const tasks = subTasksByParent[epic.id] || [];
            const epicDone = tasks.filter((t) => t.status === "done").length;
            const epicTotal = tasks.length;
            const epicPct = epicTotal > 0 ? (epicDone / epicTotal) * 100 : 0;
            const inProgress = tasks.filter((t) => t.status === "in_progress").length;
            const epicPctProgress = epicTotal > 0 ? (inProgress / epicTotal) * 100 : 0;

            return (
              <div key={epic.id} className="rounded-lg border border-gray-800 bg-[#111118]">
                {/* Epic header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLORS[epic.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-white text-sm">{epic.title}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        epic.status === "draft" ? "bg-gray-700/50 text-gray-400"
                        : epic.status === "done" ? "bg-gray-800 text-gray-500"
                        : epic.status === "new" ? "bg-blue-500/20 text-blue-400"
                        : epic.status === "in_progress" ? "bg-green-500/20 text-green-400"
                        : "bg-gray-700/50 text-gray-400"
                      }`}>
                        {STATUS_LABELS[epic.status] || epic.status}
                      </span>
                    </div>
                    {epicTotal > 0 && (
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden max-w-40">
                          <div className="h-full flex">
                            <div className="bg-green-500" style={{ width: `${epicPct}%` }} />
                            <div className="bg-blue-500" style={{ width: `${epicPctProgress}%` }} />
                          </div>
                        </div>
                        <span className="text-xs text-gray-600">{epicDone}/{epicTotal}</span>
                      </div>
                    )}
                  </div>
                  {epic.status === "draft" && (
                    <button
                      onClick={() => activateEpic(epic.id)}
                      className="rounded-lg border border-green-600/50 bg-green-600/10 px-3 py-1 text-xs font-medium text-green-400 hover:bg-green-600/20 transition shrink-0"
                    >
                      ▶️ Activate
                    </button>
                  )}
                </div>

                {/* Tasks list */}
                {tasks.length > 0 && (
                  <div className="border-t border-gray-800/50 px-4 py-2 space-y-0.5">
                    {tasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 py-1">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_COLORS[task.status]}`} />
                        <span className={`flex-1 text-xs ${task.status === "done" ? "text-gray-600 line-through" : "text-gray-300"}`}>
                          {task.title}
                        </span>
                        <span className="text-xs text-gray-600">{AGENT_EMOJI[task.agent] ?? "🤖"}</span>
                        <span className={`text-xs ${
                          task.status === "draft" ? "text-gray-600" : task.status === "done" ? "text-gray-700" : "text-gray-500"
                        }`}>
                          {STATUS_LABELS[task.status]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add task to this epic */}
                <div className="border-t border-gray-800/50 px-4 py-2">
                  {addingTaskTo === epic.id ? (
                    <InlineAddForm
                      parentId={epic.id}
                      projectAgent={epic.agent}
                      isEpic={false}
                      onCreated={() => { setAddingTaskTo(null); window.location.reload(); }}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setAddingTaskTo(epic.id)}
                        className="text-xs text-gray-600 hover:text-gray-400 transition"
                      >
                        + Add task
                      </button>
                      <AIActionButton
                        label="AI: Plan Tasks"
                        projectId={epic.id}
                        projectTitle={epic.title}
                        projectDescription={epic.instruction}
                        agent={project.agent}
                        instruction={buildTaskPlanInstruction(project, epic, tasks)}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Add epic */}
          <div className="pt-2 space-y-2">
            {addingEpic ? (
              <InlineAddForm
                parentId={project.id}
                projectAgent={project.agent}
                isEpic={true}
                onCreated={() => { setAddingEpic(false); window.location.reload(); }}
              />
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => setAddingEpic(true)}
                  className="flex-1 rounded-lg border border-dashed border-gray-700 py-3 text-sm text-gray-500 hover:text-gray-300 hover:border-gray-500 transition"
                >
                  + Add Epic
                </button>
                <AIActionButton
                  label="AI: Plan Epics"
                  projectId={project.id}
                  projectTitle={project.title}
                  projectDescription={project.description}
                  agent={project.agent}
                  instruction={buildEpicPlanInstruction(project, epics)}
                  className="py-3 px-5"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildEpicPlanInstruction(project: Task, existingEpics: Task[]): string {
  const existing = existingEpics.length > 0
    ? `\n\nExisting epics (don't duplicate):\n${existingEpics.map((e) => `- ${e.title}`).join("\n")}`
    : "";

  return `## Task: Plan epics for project "${project.title}"

### Project Description
${project.description || "(no description yet — ask Gonza for clarification)"}
${existing}

### What to do
1. First, **improve the project description** if it's rough — rewrite it clearly and update it via the Mission Control API (PATCH the project task with a better description field).
2. Then **create 3-6 epics** that break this project into logical phases. Each epic should be:
   - A coherent unit of work that can be activated independently
   - Named clearly (e.g., "Backend: Database + API", "Frontend: UI Components", "Integration + Testing")
   - Created as a task with parent_id="${project.id}", tags=["epic"], status="draft"

### How to create epics
Use the Mission Control API:
\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $MISSION_CONTROL_API_KEY" -H "Content-Type: application/json" "http://localhost:3001/api/agent/tasks" -d '{"title": "Epic name", "agent": "${project.agent}", "parent_id": "${project.id}", "tags": ["epic"], "status": "draft", "created_by": "${project.agent}"}'
\`\`\`

After creating all epics, mark this task as done with a summary of what you created.`;
}

function buildTaskPlanInstruction(project: Task, epic: Task, existingTasks: Task[]): string {
  const existing = existingTasks.length > 0
    ? `\n\nExisting tasks (don't duplicate):\n${existingTasks.map((t) => `- ${t.title} (${t.agent})`).join("\n")}`
    : "";

  return `## Task: Plan tasks for epic "${epic.title}" in project "${project.title}"

### Project Context
${project.description || "(no project description)"}

### Epic
${epic.title}
${epic.instruction || ""}
${existing}

### What to do
Create **concrete, actionable tasks** for this epic. Each task should:
- Be completable by a single agent in one session
- Have clear acceptance criteria
- Specify the right agent (dev for code, content for writing, etc.)
- Include dependencies if task B needs task A done first (use depends_on array)

### How to create tasks
\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $MISSION_CONTROL_API_KEY" -H "Content-Type: application/json" "http://localhost:3001/api/agent/tasks" -d '{"title": "Task name", "instruction": "Detailed instructions...", "agent": "dev", "parent_id": "${epic.id}", "status": "draft", "created_by": "${project.agent}", "depends_on": []}'
\`\`\`

For dependencies, use the task IDs returned from previous creates:
\`\`\`bash
... "depends_on": ["<task-id-of-prerequisite>"]
\`\`\`

After creating all tasks, mark this planning task as done with a summary.`;
}
