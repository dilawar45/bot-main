import "server-only";
import { isMissingSchema } from "@/catalog/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OrderStatus } from "./cart";

// Orders as the owner sees them in the admin. Reads go through RLS (admin only).

export const ORDER_TABS = {
  new: { label: "New", statuses: ["placed"] },
  confirmed: { label: "Confirmed", statuses: ["confirmed"] },
  shipped: { label: "Shipped", statuses: ["shipped"] },
  done: { label: "Delivered", statuses: ["delivered"] },
  cancelled: { label: "Cancelled", statuses: ["cancelled"] },
  carts: { label: "Open carts", statuses: ["draft"] },
} as const satisfies Record<string, { label: string; statuses: readonly OrderStatus[] }>;
export type OrderTab = keyof typeof ORDER_TABS;

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Cart",
  placed: "New",
  confirmed: "Confirmed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

type ContactRow = { whatsapp_chat_id: string; display_name: string | null; customer_name: string | null; preferred_language: string | null; phone_number?: string | null };
type ItemRow = { id: string; product_id: string | null; product_name: string; sku: string; size_label: string; quantity: number; unit_price_pkr: number; line_number: number };

export type OrderSummary = {
  id: string;
  number: number;
  status: OrderStatus;
  customer: string;
  city: string | null;
  itemsLabel: string;
  itemsTotalPkr: number;
  deliveryFeePkr: number | null;
  placedAt: string | null;
  updatedAt: string;
  // Carts only, once the follow-ups migration is applied: what the customer saw and who was nudged.
  followUp?: { summarySentAt: string | null; remindedAt: string | null; ownerAlertedAt: string | null };
};

export type OrderDetail = OrderSummary & {
  conversationId: string;
  chatId: string;
  language: "en" | "ur" | "roman_ur";
  whatsappPhone: string | null;
  customerName: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  internalNote: string | null;
  cancelReason: string | null;
  items: { id: string; productId: string | null; name: string; sku: string; size: string; quantity: number; unitPricePkr: number }[];
  times: { created: string; placed: string | null; confirmed: string | null; shipped: string | null; delivered: string | null; cancelled: string | null };
};

export type OrdersResult<T> = { available: true; data: T } | { available: false };

function itemsLabel(items: Pick<ItemRow, "product_name" | "size_label" | "quantity" | "line_number">[]): string {
  const sorted = [...items].sort((a, b) => a.line_number - b.line_number);
  const first = sorted.slice(0, 2).map((item) => `${item.product_name} (${item.size_label})${item.quantity > 1 ? ` ×${item.quantity}` : ""}`);
  return sorted.length > 2 ? `${first.join(", ")} +${sorted.length - 2} more` : first.join(", ") || "No items";
}

function customerLabel(name: string | null, contact: ContactRow | null): string {
  return name || contact?.customer_name || contact?.display_name || "Customer";
}

type ListRow = {
  id: string;
  order_number: number;
  status: OrderStatus;
  customer_name: string | null;
  city: string | null;
  items_total_pkr: number;
  delivery_fee_pkr: number | null;
  placed_at: string | null;
  updated_at: string;
  contacts: ContactRow | null;
  order_items: Pick<ItemRow, "product_name" | "size_label" | "quantity" | "line_number">[];
  // Only selected for carts, and only once the follow-ups migration is applied.
  summary_sent_at?: string | null;
  reminder_sent_at?: string | null;
  cart_alerted_at?: string | null;
};

const LIST_COLUMNS = "id, order_number, status, customer_name, city, items_total_pkr, delivery_fee_pkr, placed_at, updated_at, contacts(*), order_items(product_name, size_label, quantity, line_number)";
const FOLLOW_UP_COLUMNS = ", summary_sent_at, reminder_sent_at, cart_alerted_at";

export async function listOrders(tab: OrderTab): Promise<OrdersResult<OrderSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const select = (columns: string) =>
    supabase
      .from("orders")
      .select(columns)
      .in("status", [...ORDER_TABS[tab].statuses])
      .order(tab === "carts" ? "updated_at" : "placed_at", { ascending: false })
      .limit(100)
      .returns<ListRow[]>();
  let { data, error } = await select(tab === "carts" ? LIST_COLUMNS + FOLLOW_UP_COLUMNS : LIST_COLUMNS);
  // Before the follow-ups migration the extra columns don't exist; the list still works without them.
  if (error && tab === "carts" && isMissingSchema(error)) ({ data, error } = await select(LIST_COLUMNS));
  if (error || !data) {
    if (error && isMissingSchema(error)) return { available: false };
    throw new Error(`Could not load orders: ${error?.message ?? "no data"}`);
  }
  return {
    available: true,
    data: data.map((row) => ({
      id: row.id,
      number: row.order_number,
      status: row.status,
      customer: customerLabel(row.customer_name, row.contacts),
      city: row.city,
      itemsLabel: itemsLabel(row.order_items),
      itemsTotalPkr: row.items_total_pkr,
      deliveryFeePkr: row.delivery_fee_pkr,
      placedAt: row.placed_at,
      updatedAt: row.updated_at,
      ...(row.summary_sent_at !== undefined
        ? { followUp: { summarySentAt: row.summary_sent_at ?? null, remindedAt: row.reminder_sent_at ?? null, ownerAlertedAt: row.cart_alerted_at ?? null } }
        : {}),
    })),
  };
}

export async function getOrder(orderId: string): Promise<OrderDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data: row, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, conversation_id, customer_name, phone, address, city, customer_note, internal_note, cancel_reason, items_total_pkr, delivery_fee_pkr, created_at, placed_at, confirmed_at, shipped_at, delivered_at, cancelled_at, updated_at, contacts(*), order_items(id, product_id, product_name, sku, size_label, quantity, unit_price_pkr, line_number)",
    )
    .eq("id", orderId)
    .maybeSingle<{
      id: string;
      order_number: number;
      status: OrderStatus;
      conversation_id: string;
      customer_name: string | null;
      phone: string | null;
      address: string | null;
      city: string | null;
      customer_note: string | null;
      internal_note: string | null;
      cancel_reason: string | null;
      items_total_pkr: number;
      delivery_fee_pkr: number | null;
      created_at: string;
      placed_at: string | null;
      confirmed_at: string | null;
      shipped_at: string | null;
      delivered_at: string | null;
      cancelled_at: string | null;
      updated_at: string;
      contacts: ContactRow | null;
      order_items: ItemRow[];
    }>();
  if (error) {
    if (error.code === "22P02" || isMissingSchema(error)) return null;
    throw new Error(`Could not load the order: ${error.message}`);
  }
  if (!row) return null;
  const chatId = row.contacts?.whatsapp_chat_id ?? "";
  const language = row.contacts?.preferred_language;
  return {
    id: row.id,
    number: row.order_number,
    status: row.status,
    customer: customerLabel(row.customer_name, row.contacts),
    city: row.city,
    itemsLabel: itemsLabel(row.order_items),
    itemsTotalPkr: row.items_total_pkr,
    deliveryFeePkr: row.delivery_fee_pkr,
    placedAt: row.placed_at,
    updatedAt: row.updated_at,
    conversationId: row.conversation_id,
    chatId,
    language: language === "en" || language === "ur" ? language : "roman_ur",
    whatsappPhone: row.contacts?.phone_number || (chatId.endsWith("@c.us") ? chatId.slice(0, -5) : null),
    customerName: row.customer_name,
    phone: row.phone,
    address: row.address,
    note: row.customer_note,
    internalNote: row.internal_note,
    cancelReason: row.cancel_reason,
    items: [...row.order_items]
      .sort((a, b) => a.line_number - b.line_number)
      .map((item) => ({ id: item.id, productId: item.product_id, name: item.product_name, sku: item.sku, size: item.size_label, quantity: item.quantity, unitPricePkr: item.unit_price_pkr })),
    times: { created: row.created_at, placed: row.placed_at, confirmed: row.confirmed_at, shipped: row.shipped_at, delivered: row.delivered_at, cancelled: row.cancelled_at },
  };
}

// Placed orders waiting for the owner (nav badge). 0 until the orders migration is applied.
export async function countNewOrders(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "placed");
  return error ? 0 : (count ?? 0);
}

// Orders from one chat, for the conversation page.
export async function listConversationOrders(conversationId: string): Promise<{ id: string; number: number; status: OrderStatus; placedAt: string | null }[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, placed_at")
    .eq("conversation_id", conversationId)
    .neq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(10)
    .returns<{ id: string; order_number: number; status: OrderStatus; placed_at: string | null }[]>();
  if (error) return [];
  return data.map((row) => ({ id: row.id, number: row.order_number, status: row.status, placedAt: row.placed_at }));
}
