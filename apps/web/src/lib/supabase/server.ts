import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getAuthEnvironment } from "@/config/env";

export async function createSupabaseServerClient() {
  const { supabaseUrl, supabasePublicKey } = getAuthEnvironment();
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublicKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
