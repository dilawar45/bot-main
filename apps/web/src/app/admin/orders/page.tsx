import { AutoRefresh } from "../_components/auto-refresh";
import { NavLink } from "../_components/nav-link";
import { formatPrice } from "@/agent/compose";
import { requireAdmin } from "@/auth/admin";
import { ORDER_STATUS_LABELS, ORDER_TABS, listOrders, type OrderSummary, type OrderTab } from "@/orders/admin-queries";

const EMPTY_TEXT: Record<OrderTab, string> = {
  new: "No new orders. When a customer confirms an order in WhatsApp it shows up here, and you get a WhatsApp alert.",
  confirmed: "No confirmed orders waiting to ship.",
  shipped: "Nothing on its way right now.",
  done: "No delivered orders yet.",
  cancelled: "No cancelled orders.",
  carts: "No open carts. Carts are orders customers are still filling in with the bot, or haven't confirmed yet.",
};

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en-PK", { day: "numeric", month: "short" });
}

// Where an open cart stands: still being filled in, or waiting for the customer's confirm (and who was nudged).
function followUpLabel(followUp: NonNullable<OrderSummary["followUp"]>): string {
  if (!followUp.summarySentAt) return "Still filling in details";
  const parts = [`Summary sent ${timeAgo(followUp.summarySentAt)}, not confirmed`];
  if (followUp.remindedAt) parts.push(`reminded ${timeAgo(followUp.remindedAt)}`);
  if (followUp.ownerAlertedAt) parts.push("you were alerted");
  return parts.join(" · ");
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = await searchParams;
  const tab: OrderTab = typeof params.tab === "string" && params.tab in ORDER_TABS ? (params.tab as OrderTab) : "new";
  const result = await listOrders(tab);

  return (
    <main className="admin-main">
      <AutoRefresh />
      <div className="page-head">
        <h1>Orders</h1>
        <span className="muted small">Updates every 15 seconds</span>
      </div>

      {!result.available ? (
        <div className="empty-state">
          <p>Orders are off until the database migration 202609290003_orders.sql is applied in Supabase.</p>
          <p className="muted">Until then the bot passes customers who want to buy to you on WhatsApp.</p>
        </div>
      ) : (
        <>
          <nav className="tab-row" aria-label="Filter orders">
            {(Object.keys(ORDER_TABS) as OrderTab[]).map((key) => (
              <NavLink key={key} href={key === "new" ? "/admin/orders" : `/admin/orders?tab=${key}`} aria-current={tab === key ? "page" : undefined}>
                {ORDER_TABS[key].label}
              </NavLink>
            ))}
          </nav>
          {result.data.length === 0 ? (
            <div className="empty-state">
              <p>{EMPTY_TEXT[tab]}</p>
            </div>
          ) : (
            <ul className="product-list">
              {result.data.map((order) => (
                <li key={order.id}>
                  <NavLink href={`/admin/orders/${order.id}`} className="conversation-row">
                    <span className="product-row-main">
                      <strong>
                        #{order.number} · {order.customer}
                      </strong>
                      <span className="muted conversation-preview">{order.itemsLabel}</span>
                      {order.followUp ? <span className="muted small">{followUpLabel(order.followUp)}</span> : null}
                    </span>
                    <span className="product-row-meta">
                      <span>{formatPrice(order.itemsTotalPkr + (order.deliveryFeePkr ?? 0))}</span>
                      <span className="muted">
                        {timeAgo(order.placedAt ?? order.updatedAt)}
                        {order.city ? ` · ${order.city}` : ""}
                      </span>
                    </span>
                    <span className={`status-badge order-${order.status}`}>{ORDER_STATUS_LABELS[order.status]}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
