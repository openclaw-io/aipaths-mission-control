import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function buildUniqueKey(supabase: ReturnType<typeof createServiceClient>, input: string) {
  const baseKey = slugify(input) || `project-${Date.now()}`;

  const { data: existing, error } = await supabase
    .from("projects")
    .select("key")
    .like("key", `${baseKey}%`);

  if (error) throw error;

  const existingKeys = new Set((existing || []).map((row) => row.key));
  if (!existingKeys.has(baseKey)) return baseKey;

  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseKey}-${i}`.slice(0, 100);
    if (!existingKeys.has(candidate)) return candidate;
  }

  return `${baseKey}-${Date.now()}`.slice(0, 100);
}

export async function POST(request: NextRequest) {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const input = typeof body?.input === "string" ? body.input.trim() : "";

  if (!input) {
    return NextResponse.json({ error: "Project input is required" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const key = await buildUniqueKey(supabase, input);

  const { data, error } = await supabase
    .from("projects")
    .insert({
      key,
      name: input,
      description: input,
      summary: input,
      type: "ops",
      status: "planning",
      priority: "medium",
      owner_agent: "systems",
      metadata: {
        created_from: "quick_project_box",
      },
      plan: [],
      clarification_questions: [],
      approval_scope: {
        approved: false,
        approved_by: null,
        approved_at: null,
        can_execute_unattended: true,
        allowed_actions: ["planning", "implementation"],
        forbidden_actions: ["publish_external_output"],
        notes: null,
      },
      created_by: user.email || user.id,
      updated_at: now,
    })
    .select("id, key, status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("project_events").insert({
    project_id: data.id,
    event_type: "project.created",
    from_status: null,
    to_status: "planning",
    actor: user.email || user.id,
    payload: { source: "quick_project_box", input },
    created_at: now,
  });

  return NextResponse.json({ ok: true, project: data });
}
