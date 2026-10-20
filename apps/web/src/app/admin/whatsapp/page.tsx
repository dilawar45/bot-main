import { requireAdmin } from "@/auth/admin";
import { getGatewaySession } from "@/gateway/admin-client";
import { SessionPanel } from "./session-panel";

export default async function WhatsAppPage() {
  await requireAdmin();
  const initial = await getGatewaySession();

  return (
    <main className="admin-main">
      <h1>WhatsApp</h1>
      <p className="muted">Link the bot&apos;s number and check that it&apos;s connected. Use a dedicated number, not your personal one.</p>
      <SessionPanel initial={initial} />
    </main>
  );
}
