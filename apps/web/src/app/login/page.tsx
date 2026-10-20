import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { checkAdmin } from "@/auth/admin";
import { safeAdminRedirect } from "@/auth/admin-email";
import { signIn } from "./actions";

export const metadata: Metadata = { title: "Sign in · Huzaifa Commerce Desk" };

const errorMessages: Record<string, string> = {
  invalid: "Email or password is incorrect.",
  forbidden: "This account is not allowed to use the admin console.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeAdminRedirect(params.next);
  const errorKey = typeof params.error === "string" ? params.error : undefined;

  const admin = await checkAdmin();
  if (admin.ok) redirect(next);

  return (
    <main className="login-shell">
      <form className="login-card" action={signIn}>
        <div className="brand-mark" aria-hidden="true"><span>H</span></div>
        <h1>Admin sign in</h1>
        <p className="login-hint">Catalog, conversations and handoffs.</p>
        {errorKey && errorMessages[errorKey] ? <p className="login-error" role="alert">{errorMessages[errorKey]}</p> : null}
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
