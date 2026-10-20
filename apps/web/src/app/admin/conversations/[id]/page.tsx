import { AlertTriangle, Bot, ExternalLink } from "lucide-react";
import Link from "next/link";
import { AutoRefresh } from "../../_components/auto-refresh";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/auth/admin";
import { getConversation } from "@/conversations/admin-queries";
import { ORDER_STATUS_LABELS, listConversationOrders } from "@/orders/admin-queries";
import { ActionButton } from "../../products/_components/action-button";
import { deleteCustomerData, resumeBot, saveInternalNote, setLeadStatus } from "../actions";
import { NoteForm } from "../note-form";

const stateText = {
  bot_active: "The bot is answering this customer.",
  handoff_requested: "Waiting for a person.",
  human_active: "Paused. You are handling this chat in WhatsApp.",
} as const;

const sourceLabel = { customer: "Customer", agent: "Bot", human: "You", system: "System" } as const;
const languageLabel: Record<string, string> = { en: "English", ur: "Urdu", roman_ur: "Roman Urdu" };

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-PK", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const [conversation, orders] = await Promise.all([getConversation(id), listConversationOrders(id)]);
  if (!conversation) notFound();

  const { contact, lead } = conversation;
  const openHandoff = conversation.handoffs.find((handoff) => !handoff.resolved_at);
  const paused = conversation.state !== "bot_active";

  return (
    <main className="admin-main">
      <AutoRefresh />
      <p className="breadcrumb"><Link href="/admin/conversations">Conversations</Link> / {contact.label}</p>
      <div className="page-head">
        <h1>{contact.label}</h1>
        {contact.phone ? (
          <a className="button-link" href={`https://wa.me/${contact.phone}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} /> Open in WhatsApp
          </a>
        ) : null}
      </div>

      <section className={`panel status-panel ${paused ? "paused" : ""}`} aria-labelledby="bot-heading">
        <h2 id="bot-heading"><Bot size={16} /> Bot status</h2>
        <p>{stateText[conversation.state]}</p>
        {openHandoff ? (
          <p className="muted">
            Asked for a person on {formatTime(openHandoff.requested_at)}. Reason: {openHandoff.reason}
          </p>
        ) : null}
        {openHandoff?.notification_error ? (
          <p className="form-status error" role="alert">
            <AlertTriangle size={14} /> The alert to your support number did not send ({openHandoff.notification_error}). Check the WhatsApp connection.
          </p>
        ) : null}
        {paused ? (
          <ActionButton action={resumeBot.bind(null, conversation.id)} label="Resume bot" pendingLabel="Resuming…" confirmText="Hand this chat back to the bot?" />
        ) : null}
      </section>

      <div className="two-col">
        <section className="panel" aria-labelledby="customer-heading">
          <h2 id="customer-heading">Customer</h2>
          <dl className="fact-list">
            <dt>WhatsApp name</dt>
            <dd>{contact.display_name ?? "—"}</dd>
            <dt>Name they gave</dt>
            <dd>{contact.customer_name ?? lead?.customer_name ?? "—"}</dd>
            <dt>Location</dt>
            <dd>{contact.location ?? lead?.location ?? "—"}</dd>
            <dt>Number</dt>
            <dd>{contact.phone ? `+${contact.phone}` : contact.whatsapp_chat_id}</dd>
            <dt>Language</dt>
            <dd>{contact.preferred_language ? languageLabel[contact.preferred_language] : "—"}</dd>
            <dt>Last product shown</dt>
            <dd>{conversation.activeProduct ? <Link href={`/admin/products/${conversation.activeProduct.id}`}>{conversation.activeProduct.name}</Link> : "—"}</dd>
          </dl>
        </section>

        <section className="panel" aria-labelledby="lead-heading">
          <h2 id="lead-heading">Lead</h2>
          {lead ? (
            <>
              <p>
                Status: <span className={`status-badge lead-${lead.status}`}>{lead.status}</span>
              </p>
              {lead.interestedProducts.length ? (
                <p className="muted">
                  Interested in:{" "}
                  {lead.interestedProducts.map((product, index) => (
                    <span key={product.id}>
                      {index ? ", " : ""}
                      <Link href={`/admin/products/${product.id}`}>{product.name}</Link>
                    </span>
                  ))}
                </p>
              ) : null}
              <div className="button-row">
                {(["new", "contacted", "closed"] as const)
                  .filter((status) => status !== lead.status)
                  .map((status) => (
                    <ActionButton key={status} action={setLeadStatus.bind(null, conversation.id, lead.id, status)} label={`Mark ${status}`} variant="secondary" />
                  ))}
              </div>
            </>
          ) : (
            <p className="muted">A lead is created when the customer asks for a person.</p>
          )}
          {orders.length ? (
            <p className="muted">
              Orders:{" "}
              {orders.map((order, index) => (
                <span key={order.id}>
                  {index ? ", " : ""}
                  <Link href={`/admin/orders/${order.id}`}>#{order.number}</Link> ({ORDER_STATUS_LABELS[order.status].toLowerCase()})
                </span>
              ))}
            </p>
          ) : null}
        </section>
      </div>

      <section className="panel" aria-labelledby="note-heading">
        <h2 id="note-heading">Internal note</h2>
        <NoteForm key={conversation.internalNote ?? ""} action={saveInternalNote.bind(null, conversation.id)} note={conversation.internalNote} />
      </section>

      <section className="panel" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Privacy</h2>
        <p className="muted">
          Customer photos are deleted automatically after 30 days. If this customer asks you to delete their data, this removes their
          contact details, messages, photos and lead permanently.
        </p>
        <ActionButton
          action={deleteCustomerData.bind(null, conversation.id)}
          label="Delete customer data"
          pendingLabel="Deleting…"
          variant="danger"
          confirmText={`Permanently delete everything stored about ${contact.label}? This cannot be undone.`}
        />
      </section>

      <section className="panel" aria-labelledby="messages-heading">
        <h2 id="messages-heading">Messages</h2>
        {conversation.failedDeliveries ? (
          <p className="form-status error">{conversation.failedDeliveries} bot message(s) failed to send.</p>
        ) : null}
        <p className="muted small">Messages you type in this chat on WhatsApp show up here as &quot;You&quot;.</p>
        <ol className="thread">
          {conversation.messages.map((message) => (
            <li key={message.id} className={`bubble ${message.direction}`}>
              <span className="bubble-meta">
                {sourceLabel[message.source]} · {formatTime(message.occurredAt)}
                {message.deliveryState === "failed" ? <strong className="delivery-failed"> · not delivered</strong> : null}
                {message.deliveryState === "pending" ? <span> · sending</span> : null}
              </span>
              {message.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL for a private customer photo
                <img src={message.imageUrl} alt="Photo sent by the customer" loading="lazy" />
              ) : null}
              {message.text ? <span className="bubble-text">{message.text}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
