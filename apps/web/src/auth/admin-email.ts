export function isAllowedAdminEmail(email: unknown, allowedEmail: string): boolean {
  if (typeof email !== "string") return false;
  return email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
}

export function safeAdminRedirect(target: unknown): string {
  if (typeof target !== "string" || !target.startsWith("/admin")) return "/admin";
  if (target.startsWith("//") || target.includes("\\")) return "/admin";
  return target;
}
