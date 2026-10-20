import "server-only";
import { redirect } from "next/navigation";
import { getAuthEnvironment } from "@/config/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAllowedAdminEmail } from "./admin-email";

export type AdminSession = { userId: string; email: string };

type AdminCheck = { ok: true; session: AdminSession } | { ok: false; reason: "signed_out" | "forbidden" };

export async function checkAdmin(): Promise<AdminCheck> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return { ok: false, reason: "signed_out" };

  if (!isAllowedAdminEmail(claims.email, getAuthEnvironment().adminEmail)) return { ok: false, reason: "forbidden" };

  // RLS only exposes the caller's own membership row, so this also proves the DB agrees.
  const { data: membership, error: membershipError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", claims.sub)
    .maybeSingle();
  if (membershipError || !membership) return { ok: false, reason: "forbidden" };

  return { ok: true, session: { userId: claims.sub, email: String(claims.email) } };
}

export async function requireAdmin(): Promise<AdminSession> {
  const result = await checkAdmin();
  if (!result.ok) redirect(result.reason === "forbidden" ? "/login?error=forbidden" : "/login");
  return result.session;
}
