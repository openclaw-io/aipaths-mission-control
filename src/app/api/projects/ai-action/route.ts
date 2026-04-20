import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";
import { isRoutedAgent } from "@/lib/agent-routing";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const projectTitle = typeof body.projectTitle === "string" ? body.projectTitle.trim() : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const agent = typeof body.agent === "string" ? body.agent.trim() : "";

  if (!label || !projectId || !projectTitle || !instruction || !agent) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!isRoutedAgent(agent)) {
    return NextResponse.json({ error: `Unknown agent: ${agent}` }, { status: 400 });
  }

  const title = `${label}: ${projectTitle}`;
  const createdBy = user.email || user.id;
  const adminDb = createServiceClient();

  const { data: task, error } = await adminDb
    .from("agent_tasks")
    .insert({
      title,
      instruction,
      agent,
      created_by: createdBy,
      parent_id: projectId,
      status: "new",
      priority: "medium",
      depends_on: [],
      tags: [],
      task_type: "auto",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  logActivity(task.agent, "task_created", task.title, `Created by ${createdBy}`, task.id);

  let woke = false;
  const internalApiKey = process.env.AGENT_API_KEY;

  if (internalApiKey) {
    try {
      const notifyRes = await fetch("http://127.0.0.1:3001/api/tasks/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${internalApiKey}`,
        },
        body: JSON.stringify({
          taskId: task.id,
          agent,
          title: task.title,
          action: "created",
        }),
      });

      if (notifyRes.ok) {
        const json = (await notifyRes.json()) as { woke?: boolean };
        woke = Boolean(json.woke);
      }
    } catch (notifyError) {
      console.error("[ai-action] Failed to notify agent:", notifyError);
    }
  }

  return NextResponse.json({ ok: true, id: task.id, title: task.title, woke });
}
