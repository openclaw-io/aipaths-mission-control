import { createClient } from "@supabase/supabase-js";

// Admin client bypasses RLS — use only in server-side code
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
