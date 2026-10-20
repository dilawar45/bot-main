import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export type ConversationState = "bot_active" | "handoff_requested" | "human_active";
export type LeadStatus = "new" | "contacted" | "closed";

type ContactRow = {
  whatsapp_chat_id: string;
  display_name: string | null;
  customer_name: string | null;
  location: string | null;
  preferred_language: string | null;
  // Added by migration 202609290002; absent on older databases.
  phone_number?: string | null;
};
type HandoffRow = { id: string; reason: string; requested_at: string; resolved_at: string | null; notification_error: string | null };
type LeadRow = { id: string; status: LeadStatus; interested_product_ids: string[]; customer_name: string | null; location: string | null; handoff_reason: string | null };
type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  source: "customer" | "agent" | "human" | "system";
  content_type: "text" | "image";
  text_content: string | null;
  media_path: string | null;
  delivery_state: "pending" | "sent" | "failed" | null;
  occurred_at: string;
};

export type ConversationSummary = {
  id: string;
  state: ConversationState;
  lastMessageAt: string;
  contactLabel: string;
  phone: string | null;
  openHandoff: { reason: string; requestedAt: string; alertFailed: boolean } | null;
  leadStatus: LeadStatus | null;
  preview: string | null;
};

export function contactPhone(contact: ContactRow): string | null {
  return contact.phone_number || phoneFromChatId(contact.whatsapp_chat_id);
}

export function phoneFromChatId(chatId: string): string | null {
  return chatId.endsWith("@c.us") ? chatId.slice(0, -5) : null;
}

function contactLabel(contact: ContactRow): string {
  return contact.customer_name || contact.display_name || (contactPhone(contact) ? `+${contactPhone(contact)}` : "Unknown customer");
}

function openHandoff(handoffs: HandoffRow[]) {
  const open = handoffs.filter((handoff) => !handoff.resolved_at).sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
  return open ? { reason: open.reason, requestedAt: open.requested_at, alertFailed: Boolean(open.notification_error) } : null;
}

export async function listConversations(filter: "needs_human" | "all"): Promise<ConversationSummary[]> {
  const supabase = await createSupabaseServerClient();
  const needsHuman = filter === "needs_human";
  let request = supabase
    .from("conversations")
    .select(
      `id, state, last_message_at, contacts(*), handoffs(id, reason, requested_at, resolved_at, notification_error), leads(id, status, interested_product_ids, customer_name, location, handoff_reason), messages(text_content, content_type, occurred_at)${needsHuman ? ", inbound:messages!inner(id)" : ""}`,
    )
    .order("last_message_at", { ascending: false })
    .order("occurred_at", { referencedTable: "messages", ascending: false })
    .limit(1, { referencedTable: "messages" })
    .limit(100);
  // Chats the owner started from the shop's phone (family, suppliers) are paused but aren't customers
  // waiting: only chats where a customer has written count.
  if (needsHuman) request = request.in("state", ["human_active", "handoff_requested"]).eq("inbound.direction", "inbound").limit(1, { referencedTable: "inbound" });

  const { data, error } = await request.returns<
    {
      id: string;
      state: ConversationState;
      last_message_at: string;
      contacts: ContactRow;
      handoffs: HandoffRow[];
      leads: LeadRow[] | LeadRow | null;
      messages: Pick<MessageRow, "text_content" | "content_type" | "occurred_at">[];
    }[]
  >();
  if (error) throw new Error(`Could not load conversations: ${error.message}`);

  return data.map((row) => {
    const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
    const last = row.messages[0];
    return {
      id: row.id,
      state: row.state,
      lastMessageAt: row.last_message_at,
      contactLabel: contactLabel(row.contacts),
      phone: contactPhone(row.contacts),
      openHandoff: openHandoff(row.handoffs),
      leadStatus: lead?.status ?? null,
      preview: last ? (last.content_type === "image" ? `📷 ${last.text_content ?? "Photo"}` : last.text_content) : null,
    };
  });
}

export type ConversationMessage = {
  id: string;
  direction: MessageRow["direction"];
  source: MessageRow["source"];
  text: string | null;
  imageUrl: string | null;
  deliveryState: MessageRow["delivery_state"];
  occurredAt: string;
};

export type ConversationDetail = {
  id: string;
  state: ConversationState;
  internalNote: string | null;
  contact: ContactRow & { label: string; phone: string | null };
  lead: (LeadRow & { interestedProducts: { id: string; name: string; sku: string }[] }) | null;
  activeProduct: { id: string; name: string; sku: string } | null;
  handoffs: HandoffRow[];
  messages: ConversationMessage[];
  failedDeliveries: number;
};

export async function getConversation(conversationId: string): Promise<ConversationDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("conversations")
    .select(
      "id, state, internal_note, active_product_id, contacts(*), handoffs(id, reason, requested_at, resolved_at, notification_error), leads(id, status, interested_product_ids, customer_name, location, handoff_reason)",
    )
    .eq("id", conversationId)
    .maybeSingle<{
      id: string;
      state: ConversationState;
      internal_note: string | null;
      active_product_id: string | null;
      contacts: ContactRow;
      handoffs: HandoffRow[];
      leads: LeadRow[] | LeadRow | null;
    }>();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load conversation: ${error.message}`);
  }
  if (!data) return null;

  // Newest 100, shown oldest-first.
  const { data: messageRows, error: messagesError } = await supabase
    .from("messages")
    .select("id, direction, source, content_type, text_content, media_path, delivery_state, occurred_at")
    .eq("conversation_id", conversationId)
    .order("occurred_at", { ascending: false })
    .limit(100)
    .returns<MessageRow[]>();
  if (messagesError) throw new Error(`Could not load messages: ${messagesError.message}`);
  const messages = [...messageRows].reverse();

  // Customer photos live in the private bucket; hand out short-lived links only to the signed-in admin.
  const inboundPaths = messages.filter((message) => message.direction === "inbound" && message.media_path).map((message) => message.media_path!);
  const signed = new Map<string, string>();
  if (inboundPaths.length) {
    const { data: urls } = await createSupabaseServiceClient().storage.from("inbound-media").createSignedUrls(inboundPaths, 600);
    for (const entry of urls ?? []) if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
  }

  const lead = Array.isArray(data.leads) ? (data.leads[0] ?? null) : data.leads;
  const productIds = [...new Set([...(lead?.interested_product_ids ?? []), ...(data.active_product_id ? [data.active_product_id] : [])])];
  const products = new Map<string, { id: string; name: string; sku: string }>();
  if (productIds.length) {
    const { data: rows } = await supabase.from("products").select("id, name, sku").in("id", productIds);
    for (const row of rows ?? []) products.set(row.id, row);
  }

  return {
    id: data.id,
    state: data.state,
    internalNote: data.internal_note,
    contact: { ...data.contacts, label: contactLabel(data.contacts), phone: contactPhone(data.contacts) },
    lead: lead ? { ...lead, interestedProducts: lead.interested_product_ids.map((id) => products.get(id)).filter((product) => product !== undefined) } : null,
    activeProduct: data.active_product_id ? (products.get(data.active_product_id) ?? null) : null,
    handoffs: [...data.handoffs].sort((a, b) => b.requested_at.localeCompare(a.requested_at)),
    messages: messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      source: message.source,
      text: message.text_content,
      imageUrl: message.media_path && message.direction === "inbound" ? (signed.get(message.media_path) ?? null) : null,
      deliveryState: message.delivery_state,
      occurredAt: message.occurred_at,
    })),
    failedDeliveries: messages.filter((message) => message.delivery_state === "failed").length,
  };
}

export async function countNeedingHuman(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  // Same rule as the "Needs a human" list: only chats where a customer has written.
  const { count } = await supabase
    .from("conversations")
    .select("id, inbound:messages!inner(id)", { count: "exact", head: true })
    .in("state", ["human_active", "handoff_requested"])
    .eq("inbound.direction", "inbound");
  return count ?? 0;
}

export type RecentProblems = { failedDeliveries: number; aiErrors: number; throttled: number };

// Last 24h of things the owner should know about: replies that didn't send and AI calls that failed.
export async function getRecentProblems(): Promise<RecentProblems> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const [failed, aiErrors, throttled] = await Promise.all([
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("delivery_state", "failed").gte("created_at", since),
    supabase.from("agent_runs").select("id", { count: "exact", head: true }).not("error_code", "is", null).gte("created_at", since),
    supabase.from("agent_runs").select("id", { count: "exact", head: true }).eq("outcome", "throttled").gte("created_at", since),
  ]);
  return { failedDeliveries: failed.count ?? 0, aiErrors: aiErrors.count ?? 0, throttled: throttled.count ?? 0 };
}
