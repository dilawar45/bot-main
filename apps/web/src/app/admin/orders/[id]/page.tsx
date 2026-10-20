import { ExternalLink, MessageSquare, Package } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "../../_components/auto-refresh";
import { NoteForm } from "../../conversations/note-form";
import { cancelOrder, confirmOrder, markDelivered, markShipped, saveOrderNote } from "../actions";
import { OrderActionForm } from "../order-action-form";
import { formatPrice } from "@/agent/compose";
import { requireAdmin } from "@/auth/admin";
import { formatPhone } from "@/orders/cart";
import { ORDER_STATUS_LABELS, getOrder } from "@/orders/admin-queries";

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-PK", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) notFound();

  const fee = order.deliveryFeePkr;
  const total = order.itemsTotalPkr + (fee ?? 0);
  const cancellable = order.status !== "delivered" && order.status !== "cancelled";
  const stockTaken = order.status === "confirmed" || order.status === "shipped";

  return (
    <main className="admin-main">
      <AutoRefresh />
      <p className="breadcrumb">
        <Link href="/admin/orders">Orders</Link> / #{order.number}
      </p>
      <div className="page-head">
        <h1>
          Order #{order.number} <span className={`status-badge order-${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span>
        </h1>
        <div className="button-row">
          <Link className="button-link secondary-link" href={`/admin/conversations/${order.conversationId}`}>
            <MessageSquare size={16} /> Chat
          </Link>
          {order.whatsappPhone ? (
            <a className="button-link" href={`https://wa.me/${order.whatsappPhone}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} /> Open in WhatsApp
            </a>
          ) : null}
        </div>
      </div>

      <section className="panel" aria-labelledby="items-heading">
        <h2 id="items-heading">
          <Package size={16} /> Items
        </h2>
        <table className="order-items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Size</th>
              <th scope="col">Qty</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.productId ? <Link href={`/admin/products/${item.productId}`}>{item.name}</Link> : item.name}
                  <span className="muted small"> · {item.sku}</span>
                </td>
                <td>{item.size}</td>
                <td>{item.quantity}</td>
                <td>{formatPrice(item.unitPricePkr * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Items</td>
              <td>{formatPrice(order.itemsTotalPkr)}</td>
            </tr>
            <tr>
              <td colSpan={3}>Delivery</td>
              <td>{fee === null ? "to confirm" : fee === 0 ? "free" : formatPrice(fee)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3}>
                Total{fee === null ? " (without delivery)" : ""}
              </th>
              <td>
                <strong>{formatPrice(total)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="muted small">Prices as they were when the customer ordered.</p>
      </section>

      <div className="two-col">
        <section className="panel" aria-labelledby="deliver-heading">
          <h2 id="deliver-heading">Deliver to</h2>
          <dl className="fact-list">
            <dt>Name</dt>
            <dd>{order.customerName ?? "—"}</dd>
            <dt>Phone</dt>
            <dd>{order.phone ? <a href={`tel:+${order.phone}`}>{formatPhone(order.phone)}</a> : "—"}</dd>
            <dt>Address</dt>
            <dd>{order.address ?? "—"}</dd>
            <dt>City</dt>
            <dd>{order.city ?? "—"}</dd>
            <dt>Customer note</dt>
            <dd>{order.note ?? "—"}</dd>
            {order.cancelReason ? (
              <>
                <dt>Cancelled because</dt>
                <dd>{order.cancelReason}</dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="panel" aria-labelledby="timeline-heading">
          <h2 id="timeline-heading">Timeline</h2>
          <dl className="fact-list">
            <dt>Cart started</dt>
            <dd>{formatTime(order.times.created)}</dd>
            <dt>Placed</dt>
            <dd>{formatTime(order.times.placed)}</dd>
            <dt>Confirmed</dt>
            <dd>{formatTime(order.times.confirmed)}</dd>
            <dt>Shipped</dt>
            <dd>{formatTime(order.times.shipped)}</dd>
            <dt>Delivered</dt>
            <dd>{formatTime(order.times.delivered)}</dd>
            {order.times.cancelled ? (
              <>
                <dt>Cancelled</dt>
                <dd>{formatTime(order.times.cancelled)}</dd>
              </>
            ) : null}
          </dl>
        </section>
      </div>

      <section className="panel status-panel" aria-labelledby="next-heading">
        <h2 id="next-heading">Next step</h2>
        {order.status === "draft" ? <p>The customer is still filling this cart in with the bot; it isn&apos;t an order yet.</p> : null}
        {order.status === "placed" ? (
          <>
            <p>The customer confirmed this order. Check it, then confirm: that takes the items out of stock.</p>
            <OrderActionForm action={confirmOrder.bind(null, order.id)} label="Confirm order" pendingLabel="Confirming…" />
          </>
        ) : null}
        {order.status === "confirmed" ? (
          <OrderActionForm action={markShipped.bind(null, order.id)} label="Mark as shipped" pendingLabel="Saving…" extraLabel="Tracking number (optional)" extraPlaceholder="e.g. TCS 1234567890" />
        ) : null}
        {order.status === "shipped" ? <OrderActionForm action={markDelivered.bind(null, order.id)} label="Mark as delivered" pendingLabel="Saving…" notifyByDefault={false} /> : null}
        {order.status === "delivered" ? <p>Delivered. Nothing left to do.</p> : null}
        {order.status === "cancelled" ? <p>Cancelled{order.cancelReason ? `: ${order.cancelReason}` : "."}</p> : null}
        {cancellable ? (
          <details className="cancel-order">
            <summary>Cancel this order</summary>
            <OrderActionForm
              action={cancelOrder.bind(null, order.id)}
              label="Cancel order"
              pendingLabel="Cancelling…"
              variant="danger"
              extraLabel="Reason (optional, the customer sees it)"
              confirmText={`Cancel order #${order.number}?${stockTaken ? " Its items go back into stock." : ""}`}
              notifyByDefault={order.status !== "draft"}
            />
          </details>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="note-heading">
        <h2 id="note-heading">Internal note</h2>
        <NoteForm key={order.internalNote ?? ""} action={saveOrderNote.bind(null, order.id)} note={order.internalNote} />
      </section>
    </main>
  );
}
