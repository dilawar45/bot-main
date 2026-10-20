import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getStorageEnvironment } from "@/config/env";

// Service-role client. Bypasses RLS, so callers must authorize first (requireAdmin or HMAC).
export function createSupabaseServiceClient() {
  const environment = getStorageEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function productImagePublicUrl(storagePath: string): string {
  const base = getStorageEnvironment().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/product-images/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
}
