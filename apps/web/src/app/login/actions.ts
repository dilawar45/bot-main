"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { checkAdmin } from "@/auth/admin";
import { safeAdminRedirect } from "@/auth/admin-email";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const CredentialsSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
});

export async function signIn(formData: FormData) {
  const next = safeAdminRedirect(formData.get("next"));
  const parsed = CredentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect("/login?error=invalid");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) redirect("/login?error=invalid");

  const admin = await checkAdmin();
  if (!admin.ok) {
    await supabase.auth.signOut();
    redirect("/login?error=forbidden");
  }

  redirect(next);
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
