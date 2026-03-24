import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ProjectsClient } from "@/components/projects/ProjectsClient";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const supabase = await createClient();

  // Epics = tasks with no parent_id that have children
  // Also include tasks that have parent_id (sub-tasks) for grouping
  const { data: allTasks, error: queryError } = await supabaseAdmin
    .from("agent_tasks")
    .select("*")
    .order("created_at", { ascending: true });

  const tasks = allTasks ?? [];

  // Identify epics/projects: tasks tagged "epic" or "project", OR referenced as parent_id
  const parentIds = new Set(tasks.filter((t) => t.parent_id).map((t) => t.parent_id));
  const epics = tasks.filter((t) => {
    const tags = t.tags ?? [];
    const isTagged = Array.isArray(tags) && (tags.includes("epic") || tags.includes("project"));
    const isParent = parentIds.has(t.id);
    return isTagged || isParent;
  });
  const subTasksByParent: Record<string, typeof tasks> = {};

  for (const task of tasks) {
    if (task.parent_id) {
      if (!subTasksByParent[task.parent_id]) subTasksByParent[task.parent_id] = [];
      subTasksByParent[task.parent_id].push(task);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📐 Projects</h1>
      <p className="mt-1 text-sm text-gray-500">
        Epics and feature plans — click to expand and see sub-tasks
      </p>
      <div className="mt-6">
        <ProjectsClient epics={epics} subTasksByParent={subTasksByParent} allTasks={tasks} />
      </div>
    </div>
  );
}
