import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- preserve Supabase's legacy schema-less client inference for existing call sites.
type SupabaseServiceClient = ReturnType<typeof createClient<any, "public">>;

let cachedAdminClient: SupabaseServiceClient | null = null;

function requireEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getSupabaseAdmin() {
  cachedAdminClient ??= createServiceClient();
  return cachedAdminClient;
}

// Admin client bypasses RLS — use only in server-side code
export const supabaseAdmin = new Proxy({} as SupabaseServiceClient, {
  get(_target, property, receiver) {
    const client = getSupabaseAdmin();
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export function createServiceClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  );
}
