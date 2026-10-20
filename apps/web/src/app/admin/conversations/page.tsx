import { AlertTriangle } from "lucide-react";
import { AutoRefresh } from "../_components/auto-refresh";
import { NavLink } from "../_components/nav-link";
import { requireAdmin } from "@/auth/admin";
import { getRecentProblems, listConversations } from "@/conversations/admin-queries";

const stateLabels = { bot_active: "Bot", handoff_requested: "Waiting", human_active: "Human" } as const;

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-PK", { day: "numeric", month: "short" });
}

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = await searchParams;
  const filter = params.view === "all" ? "all" : "needs_human";
  const [conversations, problems] = await Promise.all([listConversations(filter), getRecentProblems()]);
  const problemParts = [
    problems.failedDeliveries ? `${problems.failedDeliveries} reply(s) failed to send` : null,
    problems.aiErrors ? `${problems.aiErrors} AI error(s), answered with keyword rules` : null,
    problems.throttled ? `${problems.throttled} message(s) skipped for flooding` : null,
  ].filter(Boolean);

  return (
    <main className="admin-main">
      <AutoRefresh />
      <div className="page-head">
        <h1>Conversations</h1>
        <span className="muted small">Updates every 15 seconds</span>
      </div>
      {params.deleted === "1" ? <p className="form-status ok" role="status">Customer data deleted.</p> : null}
      {problemParts.length ? (
        <p className="form-status error problem-strip" role="status">
          <AlertTriangle size={14} /> Last 24 hours: {problemParts.join(" · ")}. Check the WhatsApp page and your Gemini key.
        </p>
      ) : null}
      <nav className="tab-row" aria-label="Filter conversations">
        <NavLink href="/admin/conversations" aria-current={filter === "needs_human" ? "page" : undefined}>Needs a human</NavLink>
        <NavLink href="/admin/conversations?view=all" aria-current={filter === "all" ? "page" : undefined}>All</NavLink>
      </nav>

      {conversations.length === 0 ? (
        <div className="empty-state">
          {filter === "needs_human" ? (
            <p>No one is waiting for a person right now. <NavLink href="/admin/conversations?view=all">See all conversations</NavLink></p>
          ) : (
            <>
              <p>No customer has messaged the bot yet.</p>
              <p className="muted">
                Chats appear here as soon as someone sends a WhatsApp message to the bot&apos;s number. To test, send &quot;hi&quot; to it
                from another phone. Messages sent from the bot&apos;s own phone are ignored.
              </p>
            </>
          )}
        </div>
      ) : (
        <ul className="product-list">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <NavLink href={`/admin/conversations/${conversation.id}`} className="conversation-row">
                <span className="product-row-main">
                  <strong>{conversation.contactLabel}</strong>
                  <span className="muted conversation-preview">{conversation.preview ?? "No messages"}</span>
                  {conversation.openHandoff ? (
                    <span className="handoff-line">
                      {conversation.openHandoff.alertFailed ? <AlertTriangle size={14} aria-label="Support alert failed" /> : null}
                      Asked for a person {timeAgo(conversation.openHandoff.requestedAt)}
                    </span>
                  ) : null}
                </span>
                <span className="product-row-meta">
                  <span className="muted">{timeAgo(conversation.lastMessageAt)}</span>
                  {conversation.leadStatus ? <span className="muted">Lead: {conversation.leadStatus}</span> : null}
                </span>
                <span className={`status-badge state-${conversation.state}`}>{stateLabels[conversation.state]}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
