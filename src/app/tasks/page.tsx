import { createClient } from "@/lib/supabase/server";
import { TasksClient } from "@/components/tasks/TasksClient";

export interface Task {
  id: string;
  title: string;
  agent: string;
  status: string;
  priority: string | null;
  instruction: string | null;
  result: string | null;
  tags: string[] | null;
  depends_on: string | null;
  due_date: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  assignee: string | null;
  task_type: string;
  scheduled_for: string | null;
  error: string | null;
  created_by: string | null;
}

export default async function TasksPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("agent_tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[TasksPage] Failed to fetch tasks:", error);
  }

  const tasks: Task[] = data ?? [];

  return <TasksClient initialTasks={tasks} />;
}
