import type { SupabaseClient } from "@supabase/supabase-js";
import type { Language } from "@huzaifa/contracts";
import { isMissingSchema, type ConversationState } from "../catalog/repository";
import type { OrderLine } from "./cart";
import { CART_FOLLOW_UP_WINDOW_MS, CONFIRM_REMINDER_AFTER_MS, CONFIRM_REMINDER_WINDOW_MS, type CartCandidate, type PlacedCandidate } from "./followups";

// Database side of the follow-ups (service role). Every follow-up is claimed with a conditional update
// before it is sent, so overlapping rounds or two server instances can never send one twice.

type ItemRow = { product_id: string | null; product_name: string; size_label: string; normalized_size: string; quantity: number; line_number: number };
type ContactRow = { whatsapp_chat_id: string; display_name: string | null; customer_name: string | null; preferred_language: string | null; phone_number?: string | null };

type CartRow = {
  id: string;
  conversation_id: string;
  customer_name: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  customer_note: string | null;
  summary_fingerprint: string | null;
  summary_sent_at: string;
  reminder_sent_at: string | null;
  cart_alerted_at: string | null;
  items_total_pkr: number;
  delivery_fee_pkr: number | null;
  order_items: ItemRow[];
  conversations: { state: ConversationState } | null;
  contacts: ContactRow | null;
};

type PlacedRow = {
  id: string;
  order_number: number;
  customer_name: string | null;
  items_total_pkr: number;
  delivery_fee_pkr: number | null;
  placed_at: string;
  order_items: Pick<ItemRow, "product_name" | "size_label" | "quantity" | "line_number">[];
  contacts: ContactRow | null;
};

export function itemsLabel(items: readonly Pick<ItemRow, "product_name" | "size_label" | "quantity" | "line_number">[]): string {
  const sorted = [...items].sort((a, b) => a.line_number - b.line_number);
  const first = sorted.slice(0, 2).map((item) => `${item.product_name} (${item.size_label})${item.quantity > 1 ? ` ×${item.quantity}` : ""}`);
  return sorted.length > 2 ? `${first.join(", ")} +${sorted.length - 2} more` : first.join(", ") || "no items";
}

function language(value: string | null | undefined): Language {
  return value === "en" || value === "ur" ? value : "roman_ur";
}

function whatsappPhone(contact: ContactRow | null): string | null {
  const chatId = contact?.whatsapp_chat_id ?? "";
  return contact?.phone_number || (chatId.endsWith("@c.us") ? chatId.slice(0, -5) : null);
}

export class FollowUpStore {
  constructor(private readonly client: SupabaseClient) {}

  // Carts whose summary went out within the follow-up window and still owe what's switched on: a reminder, an
  // alert, or either. Chats the owner is handling never get either. null until the follow-ups migration is applied.
  async loadCarts(now: Date, wanted: { reminders: boolean; ownerAlerts: boolean }): Promise<CartCandidate[] | null> {
    if (!wanted.reminders && !wanted.ownerAlerts) return [];
    let query = this.client
      .from("orders")
      .select(
        "id, conversation_id, customer_name, phone, address, city, customer_note, summary_fingerprint, summary_sent_at, reminder_sent_at, cart_alerted_at, items_total_pkr, delivery_fee_pkr, order_items(product_id, product_name, size_label, normalized_size, quantity, line_number), conversations!inner(state), contacts(*)",
      )
      .eq("status", "draft")
      .neq("conversations.state", "human_active")
      .not("summary_sent_at", "is", null)
      .gte("summary_sent_at", new Date(now.getTime() - CART_FOLLOW_UP_WINDOW_MS).toISOString());
    // Only what can still happen: carts with nothing left owed would otherwise take the places of newer ones.
    if (wanted.reminders && wanted.ownerAlerts) query = query.or("reminder_sent_at.is.null,cart_alerted_at.is.null");
    else query = query.is(wanted.reminders ? "reminder_sent_at" : "cart_alerted_at", null);
    const { data, error } = await query.order("summary_sent_at", { ascending: true }).limit(100).returns<CartRow[]>();
    if (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
    const rows = data ?? [];
    const lastInbound = await this.lastInboundAt(rows.map((row) => row.conversation_id), now);
    return rows.map((row) => {
      const lines: OrderLine[] = [...row.order_items]
        .sort((a, b) => a.line_number - b.line_number)
        .filter((item): item is ItemRow & { product_id: string } => item.product_id !== null)
        .map((item) => ({ productId: item.product_id, size: item.size_label, normalizedSize: item.normalized_size, quantity: item.quantity }));
      return {
        orderId: row.id,
        conversationId: row.conversation_id,
        conversationState: row.conversations?.state ?? "bot_active",
        chatId: row.contacts?.whatsapp_chat_id ?? "",
        language: language(row.contacts?.preferred_language),
        customerName: row.customer_name || row.contacts?.customer_name || row.contacts?.display_name || null,
        whatsappPhone: whatsappPhone(row.contacts),
        draft: {
          id: row.id,
          number: null,
          // An item whose product was deleted can't be confirmed as shown; such a cart fails the summary check.
          lines: lines.length === row.order_items.length ? lines : [],
          details: { name: row.customer_name, phone: row.phone, address: row.address, city: row.city, note: row.customer_note },
          summaryFingerprint: row.summary_fingerprint,
        },
        itemsLabel: itemsLabel(row.order_items),
        totalPkr: row.items_total_pkr + (row.delivery_fee_pkr ?? 0),
        summarySentAt: row.summary_sent_at,
        reminderSentAt: row.reminder_sent_at,
        cartAlertedAt: row.cart_alerted_at,
        lastInboundAt: lastInbound.get(row.conversation_id) ?? null,
      };
    }).filter((cart) => cart.chatId !== "");
  }

  // Latest customer message per chat, newest first so the first row seen per chat is its latest.
  private async lastInboundAt(conversationIds: readonly string[], now: Date): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    if (!conversationIds.length) return latest;
    const { data, error } = await this.client
      .from("messages")
      .select("conversation_id, created_at")
      .in("conversation_id", [...new Set(conversationIds)])
      .eq("direction", "inbound")
      .gte("created_at", new Date(now.getTime() - 2 * CART_FOLLOW_UP_WINDOW_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(500)
      .returns<{ conversation_id: string; created_at: string }[]>();
    if (error) throw error;
    for (const row of data ?? []) if (!latest.has(row.conversation_id)) latest.set(row.conversation_id, row.created_at);
    return latest;
  }

  // Placed orders the owner hasn't confirmed and hasn't been reminded about.
  async loadPlacedWaiting(now: Date): Promise<PlacedCandidate[] | null> {
    const { data, error } = await this.client
      .from("orders")
      .select("id, order_number, customer_name, items_total_pkr, delivery_fee_pkr, placed_at, order_items(product_name, size_label, quantity, line_number), contacts(*)")
      .eq("status", "placed")
      .is("confirm_reminded_at", null)
      .lte("placed_at", new Date(now.getTime() - CONFIRM_REMINDER_AFTER_MS).toISOString())
      .gte("placed_at", new Date(now.getTime() - CONFIRM_REMINDER_WINDOW_MS).toISOString())
      .order("placed_at", { ascending: true })
      .limit(10)
      .returns<PlacedRow[]>();
    if (error) {
      if (isMissingSchema(error)) return null;
      throw error;
    }
    return (data ?? []).map((row) => ({
      orderId: row.id,
      orderNumber: row.order_number,
      customer: row.customer_name || row.contacts?.customer_name || row.contacts?.display_name || "Customer",
      itemsLabel: itemsLabel(row.order_items),
      totalPkr: row.items_total_pkr + (row.delivery_fee_pkr ?? 0),
      placedAt: row.placed_at,
    }));
  }

  // Only while it is still the same unconfirmed summary, and only once.
  async claimReminder(orderId: string, summaryFingerprint: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("orders")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("status", "draft")
      .eq("summary_fingerprint", summaryFingerprint)
      .is("reminder_sent_at", null)
      .select("id");
    if (error) throw error;
    return data.length === 1;
  }

  async claimCartAlert(orderId: string): Promise<boolean> {
    const { data, error } = await this.client.from("orders").update({ cart_alerted_at: new Date().toISOString() }).eq("id", orderId).eq("status", "draft").is("cart_alerted_at", null).select("id");
    if (error) throw error;
    return data.length === 1;
  }

  async claimConfirmReminder(orderId: string): Promise<boolean> {
    const { data, error } = await this.client.from("orders").update({ confirm_reminded_at: new Date().toISOString() }).eq("id", orderId).eq("status", "placed").is("confirm_reminded_at", null).select("id");
    if (error) throw error;
    return data.length === 1;
  }
}
