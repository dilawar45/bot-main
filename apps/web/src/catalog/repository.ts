import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InboundMessage, OutboundAction, OwnerMessage, OwnerMessageResult } from "@huzaifa/contracts";
import type { StoredMessage } from "../agent/memory";
import { NO_ORDERS, type OrderDraft, type OrderState, type OrderStatus } from "../orders/cart";
import type { CatalogItem } from "./search";
import type { PhotoHit, SemanticHit } from "./semantic";

export type ConversationState = "bot_active" | "handoff_requested" | "human_active";

export type ConversationContext = {
  id: string;
  state: ConversationState;
  activeProductId: string | null;
  summary: string | null;
};

export type ContactProfile = {
  displayName: string | null;
  customerName: string | null;
  location: string | null;
  preferredLanguage: "en" | "ur" | "roman_ur" | null;
  // Real number behind a privacy "@lid" chat, once WhatsApp revealed it (needs the contact_phone migration).
  phoneNumber?: string | null;
};

export type SavedOrderDraft = { id: string; number: number; itemsTotalPkr: number };

export type OrderErrorCode = "summary_outdated" | "out_of_stock" | "details_missing" | "no_items" | "order_not_draft" | "order_not_found" | "unknown";

// A refused place_order: the database re-checks everything the customer confirmed.
export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

// The database doesn't have this table, column or function yet (its migration isn't applied).
export function isMissingSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return ["42P01", "42703", "42883", "PGRST200", "PGRST202", "PGRST204", "PGRST205"].includes(error.code ?? "") || /does not exist|schema cache/i.test(error.message ?? "");
}

export type CustomerDetails = { name?: string; location?: string; language?: "en" | "ur" | "roman_ur" };

export type IngestResult = {
  duplicate: boolean;
  conversation: ConversationContext;
  contact?: ContactProfile;
  inboundMessageId?: string;
  // True when this is the first message we have ever stored for the chat.
  firstContact?: boolean;
  // Inbound messages from this chat in the last 60 seconds, including this one.
  recentInboundCount?: number;
  // All messages in the conversation, including this one.
  totalMessages?: number;
  // Customer messages only (one per turn); drives when the summary is refreshed.
  inboundTotal?: number;
};

export type OpenHandoff = { requestedAt: string; notificationError: string | null };

export type ReplayOptions = { customerChatId: string; supportChatId: string; publicUrl: (storagePath: string) => string };

export type AgentRunRecord = {
  conversationId: string;
  inboundMessageId?: string;
  promptVersion: string;
  model: string;
  candidateProductIds: string[];
  outcome: string;
  latencyMs: number;
  errorCode?: string;
  // Stored in agent_runs.candidate_scores (jsonb): tools used, model calls, fact-checker issues.
  diagnostics?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
};

export interface BrainRepository {
  ingestInbound(message: InboundMessage): Promise<IngestResult>;
  loadRecentMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  loadCatalog(): Promise<CatalogItem[]>;
  // Support alerts (recipient other than the customer) are stored as "system" so they stay out of chat memory.
  saveActions(conversationId: string, actions: OutboundAction[], customerChatId: string): Promise<void>;
  beginHandoff(conversationId: string, reason: string, notificationActionId: string, interestedProductIds: string[]): Promise<void>;
  // Team notified, bot keeps helping until the owner actually replies in the chat.
  markHandoffPending(conversationId: string): Promise<void>;
  rememberProduct(conversationId: string, productId: string): Promise<void>;
  saveCustomerDetails(chatId: string, details: CustomerDetails): Promise<void>;
  saveSummary(conversationId: string, summary: string): Promise<void>;
  recordAgentRun(run: AgentRunRecord): Promise<void>;
  // True when the owner wrote in this chat at or after `sinceIso` (they took over mid-turn).
  ownerRepliedSince(conversationId: string, sinceIso: string): Promise<boolean>;
  openHandoff(conversationId: string): Promise<OpenHandoff | null>;
  // Actions a recent event produced that never reached the customer (the gateway lost the response).
  replayPendingActions(eventId: string, options: ReplayOptions): Promise<OutboundAction[]>;
  // Orders. `available: false` until the orders migration is applied.
  loadOrderState(conversationId: string): Promise<OrderState>;
  saveOrderDraft(conversationId: string, draft: OrderDraft, options: { deliveryFeePkr: number | null; summaryFingerprint: string | null }): Promise<SavedOrderDraft>;
  discardOrderDraft(conversationId: string): Promise<void>;
  // Returns the order number; throws OrderError when the database refuses.
  placeOrder(orderId: string, summaryFingerprint: string): Promise<number>;
  // Closest active products by meaning; [] until the embeddings migration is applied.
  matchProducts(embedding: readonly number[], count: number, minSimilarity: number): Promise<SemanticHit[]>;
  // Active products whose photos look most like a photo's embedding (best photo each); [] until the photo search
  // migration is applied.
  matchProductImages(embedding: readonly number[], count: number, minSimilarity: number): Promise<PhotoHit[]>;
  // False while match_product_images is known to be missing, so the customer's photo isn't embedded for nothing.
  photoSearchReady?(): boolean;
}

type OrderRow = {
  id: string;
  order_number: number;
  status: OrderStatus;
  customer_name: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  customer_note: string | null;
  summary_fingerprint: string | null;
  placed_at: string | null;
  created_at: string;
  order_items: { product_id: string | null; size_label: string; normalized_size: string; quantity: number; line_number: number }[];
};

// Earlier orders older than this aren't mentioned to the model.
const RECENT_ORDER_DAYS = 60;
// After match_products turns out to be missing, don't ask again for a while.
let semanticUnavailableUntil = 0;
// Same for match_product_images.
let photoSearchUnavailableUntil = 0;

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  style_tags: string[];
  aliases: string[];
  price_pkr: number;
  created_at: string;
  product_variants: { size_label: string; normalized_size: string; stock_qty: number }[];
  product_images: { storage_path: string; sort_order: number; ai_description: string | null }[];
};

type ContactRow = {
  id: string;
  display_name: string | null;
  customer_name: string | null;
  location: string | null;
  preferred_language: ContactProfile["preferredLanguage"];
  // Only present once the contact_phone migration is applied.
  phone_number?: string | null;
};

export class SupabaseBrainRepository implements BrainRepository {
  constructor(private readonly client: SupabaseClient) {}

  async ingestInbound(message: InboundMessage): Promise<IngestResult> {
    const { data: contact, error: contactError } = await this.client
      .from("contacts")
      .upsert({ whatsapp_chat_id: message.chatId, display_name: message.displayName ?? null }, { onConflict: "whatsapp_chat_id" })
      // "*" rather than a column list: phone_number only exists once its optional migration is applied.
      .select("*")
      .single<ContactRow>();
    if (contactError) throw contactError;

    // Best effort: the phone_number column only exists once its optional migration is applied.
    if (message.phoneNumber) {
      await this.client.from("contacts").update({ phone_number: message.phoneNumber }).eq("id", contact.id).then(
        () => undefined,
        () => undefined,
      );
    }

    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .upsert({ contact_id: contact.id, last_message_at: message.occurredAt }, { onConflict: "contact_id" })
      .select("id, state, active_product_id, summary")
      .single();
    if (conversationError) throw conversationError;

    const { data: inserted, error: messageError } = await this.client
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        provider_message_id: message.messageId,
        event_id: message.eventId,
        direction: "inbound",
        source: "customer",
        content_type: message.type,
        text_content: message.text ?? null,
        media_path: message.media?.objectPath ?? null,
        occurred_at: message.occurredAt,
      })
      .select("id")
      .single<{ id: string }>();

    const profile: ContactProfile = {
      displayName: contact.display_name,
      customerName: contact.customer_name,
      location: contact.location,
      preferredLanguage: contact.preferred_language,
      phoneNumber: message.phoneNumber ?? contact.phone_number ?? null,
    };
    if (messageError?.code === "23505") return { duplicate: true, conversation: mapConversation(conversation), contact: profile };
    if (messageError) throw messageError;

    const since = new Date(Date.now() - 60_000).toISOString();
    const [{ count: total }, { count: recent }, { count: inboundTotal }] = await Promise.all([
      this.client.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversation.id),
      this.client.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversation.id).eq("direction", "inbound").gte("created_at", since),
      this.client.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversation.id).eq("direction", "inbound"),
    ]);

    return {
      duplicate: false,
      conversation: mapConversation(conversation),
      contact: profile,
      inboundMessageId: inserted.id,
      firstContact: total === 1,
      recentInboundCount: recent ?? 1,
      totalMessages: total ?? 1,
      inboundTotal: inboundTotal ?? 1,
    };
  }

  async ownerRepliedSince(conversationId: string, sinceIso: string): Promise<boolean> {
    const { count, error } = await this.client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("source", "human")
      .gte("created_at", sinceIso);
    if (error) throw error;
    return (count ?? 0) > 0;
  }

  async openHandoff(conversationId: string): Promise<OpenHandoff | null> {
    const { data, error } = await this.client
      .from("handoffs")
      .select("requested_at, notification_error")
      .eq("conversation_id", conversationId)
      .is("resolved_at", null)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ requested_at: string; notification_error: string | null }>();
    if (error) throw error;
    return data ? { requestedAt: data.requested_at, notificationError: data.notification_error } : null;
  }

  async replayPendingActions(eventId: string, options: ReplayOptions): Promise<OutboundAction[]> {
    const { data: inbound } = await this.client
      .from("messages")
      .select("id, conversation_id, created_at")
      .eq("event_id", eventId)
      .maybeSingle<{ id: string; conversation_id: string; created_at: string }>();
    // Only a recent event can be a lost response; an old duplicate is WhatsApp re-delivering a message.
    if (!inbound || Date.now() - new Date(inbound.created_at).getTime() > 5 * 60_000) return [];
    // Everything the bot prepared for this chat since that message and never delivered. Found by chat and
    // time, so it doesn't depend on the run record (a best-effort insert) having been saved.
    const { data: rows } = await this.client
      .from("messages")
      .select("reply_action_id, source, content_type, text_content, media_path")
      .eq("conversation_id", inbound.conversation_id)
      .eq("direction", "outbound")
      .eq("delivery_state", "pending")
      .not("reply_action_id", "is", null)
      .gte("created_at", inbound.created_at)
      .order("occurred_at", { ascending: true })
      .limit(10)
      .returns<{ reply_action_id: string; source: string; content_type: "text" | "image"; text_content: string | null; media_path: string | null }[]>();
    return (rows ?? []).flatMap((row): OutboundAction[] => {
      const recipientChatId = row.source === "system" ? options.supportChatId : options.customerChatId;
      if (row.content_type === "image" && row.media_path) {
        return [{ actionId: row.reply_action_id, recipientChatId, type: "image", objectPath: row.media_path, url: options.publicUrl(row.media_path), caption: row.text_content ?? undefined }];
      }
      return row.text_content ? [{ actionId: row.reply_action_id, recipientChatId, type: "text", text: row.text_content }] : [];
    });
  }

  async loadOrderState(conversationId: string): Promise<OrderState> {
    const { data, error } = await this.client
      .from("orders")
      .select(
        "id, order_number, status, customer_name, phone, address, city, customer_note, summary_fingerprint, placed_at, created_at, order_items(product_id, size_label, normalized_size, quantity, line_number)",
      )
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<OrderRow[]>();
    if (error) {
      if (isMissingSchema(error)) return NO_ORDERS;
      throw error;
    }
    const rows = data ?? [];
    const draft = rows.find((row) => row.status === "draft");
    const recent = rows.find((row) => row.status !== "draft" && Date.now() - new Date(row.placed_at ?? row.created_at).getTime() < RECENT_ORDER_DAYS * 86_400_000);
    return {
      available: true,
      draft: draft
        ? {
            id: draft.id,
            number: draft.order_number,
            lines: [...draft.order_items]
              .sort((a, b) => a.line_number - b.line_number)
              .filter((item): item is typeof item & { product_id: string } => item.product_id !== null)
              .map((item) => ({ productId: item.product_id, size: item.size_label, normalizedSize: item.normalized_size, quantity: item.quantity })),
            details: { name: draft.customer_name, phone: draft.phone, address: draft.address, city: draft.city, note: draft.customer_note },
            summaryFingerprint: draft.summary_fingerprint,
          }
        : null,
      recent: recent ? { id: recent.id, number: recent.order_number, status: recent.status as Exclude<OrderStatus, "draft">, placedAt: recent.placed_at } : null,
    };
  }

  async saveOrderDraft(
    conversationId: string,
    draft: OrderDraft,
    options: { deliveryFeePkr: number | null; summaryFingerprint: string | null },
  ): Promise<SavedOrderDraft> {
    // One transaction in the database; it copies names, SKUs and prices from the catalog itself.
    const { data, error } = await this.client
      .rpc("save_order_draft", {
        p_conversation_id: conversationId,
        p_items: draft.lines.map((line) => ({ product_id: line.productId, size: line.normalizedSize, quantity: line.quantity })),
        p_customer_name: draft.details.name,
        p_phone: draft.details.phone,
        p_address: draft.details.address,
        p_city: draft.details.city,
        p_customer_note: draft.details.note,
        p_delivery_fee_pkr: options.deliveryFeePkr,
        p_summary_fingerprint: options.summaryFingerprint,
      })
      .single<{ order_id: string; order_number: number; items_total_pkr: number }>();
    if (error) throw error;
    return { id: data.order_id, number: data.order_number, itemsTotalPkr: data.items_total_pkr };
  }

  async discardOrderDraft(conversationId: string): Promise<void> {
    const { error } = await this.client.from("orders").delete().eq("conversation_id", conversationId).eq("status", "draft");
    if (error && !isMissingSchema(error)) throw error;
  }

  async placeOrder(orderId: string, summaryFingerprint: string): Promise<number> {
    const { data, error } = await this.client.rpc("place_order", { p_order_id: orderId, p_summary_fingerprint: summaryFingerprint });
    if (error) {
      const code = (["summary_outdated", "out_of_stock", "details_missing", "no_items", "order_not_draft", "order_not_found"] as const).find((known) => error.message?.startsWith(known));
      throw new OrderError(code ?? "unknown", error.message ?? "place_order failed");
    }
    return Number(data);
  }

  async matchProducts(embedding: readonly number[], count: number, minSimilarity: number): Promise<SemanticHit[]> {
    if (Date.now() < semanticUnavailableUntil) return [];
    const { data, error } = await this.client.rpc("match_products", {
      // pgvector reads its text form "[0.1,0.2,…]".
      query_embedding: JSON.stringify(embedding),
      match_count: count,
      min_similarity: minSimilarity,
    });
    if (error) {
      if (isMissingSchema(error)) {
        semanticUnavailableUntil = Date.now() + 10 * 60_000;
        return [];
      }
      throw error;
    }
    return ((data ?? []) as { id: string; similarity: number | string }[]).map((row) => ({ id: row.id, similarity: Number(row.similarity) }));
  }

  photoSearchReady(): boolean {
    return Date.now() >= photoSearchUnavailableUntil;
  }

  async matchProductImages(embedding: readonly number[], count: number, minSimilarity: number): Promise<PhotoHit[]> {
    if (Date.now() < photoSearchUnavailableUntil) return [];
    const { data, error } = await this.client.rpc("match_product_images", {
      // pgvector reads its text form "[0.1,0.2,…]".
      query_embedding: JSON.stringify(embedding),
      match_count: count,
      min_similarity: minSimilarity,
    });
    if (error) {
      if (isMissingSchema(error)) {
        photoSearchUnavailableUntil = Date.now() + 10 * 60_000;
        return [];
      }
      throw error;
    }
    return ((data ?? []) as { product_id: string; storage_path: string | null; similarity: number | string }[]).map((row) => ({
      id: row.product_id,
      imagePath: row.storage_path ?? null,
      similarity: Number(row.similarity),
    }));
  }

  async loadRecentMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.client
      .from("messages")
      .select("id, direction, source, content_type, text_content, media_path, occurred_at")
      .eq("conversation_id", conversationId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).reverse().map((row) => ({
      id: row.id,
      direction: row.direction,
      source: row.source,
      contentType: row.content_type,
      text: row.text_content,
      mediaPath: row.media_path,
      occurredAt: row.occurred_at,
    }));
  }

  async loadCatalog(): Promise<CatalogItem[]> {
    const { data, error } = await this.client
      .from("products")
      .select(
        "id, sku, name, description, category, color, material, style_tags, aliases, price_pkr, created_at, product_variants(size_label, normalized_size, stock_qty), product_images(storage_path, sort_order, ai_description)",
      )
      .eq("status", "active")
      .limit(2_000)
      .returns<ProductRow[]>();
    if (error) throw error;
    return (data ?? []).map((row) => {
      const images = [...row.product_images].sort((a, b) => a.sort_order - b.sort_order);
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        description: row.description,
        category: row.category,
        color: row.color,
        material: row.material,
        styleTags: row.style_tags ?? [],
        aliases: row.aliases ?? [],
        pricePkr: row.price_pkr,
        createdAt: row.created_at,
        variants: row.product_variants.map((variant) => ({ size: variant.size_label, normalizedSize: variant.normalized_size, stockQty: variant.stock_qty })),
        imagePaths: images.map((image) => image.storage_path),
        aiText: images.map((image) => image.ai_description ?? "").join(" ").trim(),
      };
    });
  }

  async recordAgentRun(run: AgentRunRecord): Promise<void> {
    const { error } = await this.client.from("agent_runs").insert({
      conversation_id: run.conversationId,
      inbound_message_id: run.inboundMessageId ?? null,
      prompt_version: run.promptVersion,
      model: run.model,
      candidate_product_ids: run.candidateProductIds,
      candidate_scores: run.diagnostics ?? {},
      outcome: run.outcome,
      latency_ms: Math.max(0, Math.round(run.latencyMs)),
      input_tokens: run.inputTokens ?? null,
      output_tokens: run.outputTokens ?? null,
      error_code: run.errorCode ?? null,
    });
    if (error) throw error;
  }

  async saveActions(conversationId: string, actions: OutboundAction[], customerChatId: string): Promise<void> {
    if (actions.length === 0) return;
    const now = Date.now();
    const rows = actions.map((action, index) => ({
      conversation_id: conversationId,
      direction: "outbound",
      source: action.recipientChatId === customerChatId ? "agent" : "system",
      content_type: action.type,
      text_content: action.type === "text" ? action.text : (action.caption ?? null),
      media_path: action.type === "image" ? action.objectPath : null,
      reply_action_id: action.actionId,
      delivery_state: "pending",
      // One millisecond apart so history keeps the texts and cards in the order they were sent.
      occurred_at: new Date(now + index).toISOString(),
    }));
    const { error } = await this.client.from("messages").insert(rows);
    if (error) throw error;
  }

  async beginHandoff(conversationId: string, reason: string, notificationActionId: string, interestedProductIds: string[]): Promise<void> {
    // One transaction: pause the bot, open the handoff, create/update the lead.
    const { error } = await this.client.rpc("begin_handoff", {
      p_conversation_id: conversationId,
      p_reason: reason,
      p_notification_action_id: notificationActionId,
      p_interested_product_ids: interestedProductIds,
    });
    if (error) throw error;
  }

  async markHandoffPending(conversationId: string): Promise<void> {
    const { error } = await this.client.from("conversations").update({ state: "handoff_requested" }).eq("id", conversationId).eq("state", "human_active");
    if (error) throw error;
  }

  async rememberProduct(conversationId: string, productId: string): Promise<void> {
    const { error } = await this.client.from("conversations").update({ active_product_id: productId }).eq("id", conversationId);
    if (error) throw error;
  }

  async saveCustomerDetails(chatId: string, details: CustomerDetails): Promise<void> {
    const update = {
      ...(details.name ? { customer_name: details.name.slice(0, 120) } : {}),
      ...(details.location ? { location: details.location.slice(0, 160) } : {}),
      ...(details.language ? { preferred_language: details.language } : {}),
    };
    if (Object.keys(update).length === 0) return;
    const { error } = await this.client.from("contacts").update(update).eq("whatsapp_chat_id", chatId);
    if (error) throw error;
  }

  async saveSummary(conversationId: string, summary: string): Promise<void> {
    const { error } = await this.client.from("conversations").update({ summary: summary.slice(0, 1_000) }).eq("id", conversationId);
    if (error) throw error;
  }

  // Replies the gateway never picked up (it gave up waiting before the turn finished) would stay "sending"
  // forever. Marks them failed, flags a handoff alert among them (the owner is paged again when the customer
  // writes), and returns the owner alerts that never went out so the caller can send them another way.
  async markStaleDeliveriesFailed(olderThanMs: number): Promise<{ failed: number; ownerAlerts: string[] }> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const { data, error } = await this.client
      .from("messages")
      .update({ delivery_state: "failed" })
      .eq("direction", "outbound")
      .eq("delivery_state", "pending")
      .not("reply_action_id", "is", null)
      .lt("created_at", cutoff)
      .select("reply_action_id, source, text_content")
      .returns<{ reply_action_id: string; source: string; text_content: string | null }[]>();
    if (error) throw error;
    const alerts = data.filter((row) => row.source === "system");
    if (alerts.length) {
      await this.client
        .from("handoffs")
        .update({ notification_error: "never_delivered" })
        .in("notification_action_id", alerts.map((row) => row.reply_action_id))
        .is("notification_error", null);
    }
    return { failed: data.length, ownerAlerts: alerts.map((row) => row.text_content ?? "").filter(Boolean) };
  }

  // The owner typed in a chat from the bot's WhatsApp: keep it in history and step the bot back.
  async recordOwnerMessage(message: OwnerMessage): Promise<OwnerMessageResult> {
    const chatIds = [...new Set([message.chatId, ...message.alternateChatIds])];
    const { data: contacts, error: contactError } = await this.client.from("contacts").select("id, whatsapp_chat_id").in("whatsapp_chat_id", chatIds);
    if (contactError) throw contactError;
    let contactRows = (contacts ?? []) as { id: string; whatsapp_chat_id: string }[];
    // A chat the owner starts from the bot's phone is a customer they are handling: create it already
    // paused, so the bot doesn't greet over them when the customer replies.
    if (contactRows.length === 0) {
      const { data: created, error: createError } = await this.client
        .from("contacts")
        .upsert({ whatsapp_chat_id: message.chatId }, { onConflict: "whatsapp_chat_id" })
        .select("id, whatsapp_chat_id")
        .single<{ id: string; whatsapp_chat_id: string }>();
      if (createError) throw createError;
      contactRows = [created];
    }

    const contactIds = contactRows.map((row) => row.id);
    const { data: existing, error: conversationError } = await this.client
      .from("conversations")
      .select("id, state, contact_id")
      .in("contact_id", contactIds)
      .returns<{ id: string; state: ConversationState; contact_id: string }[]>();
    if (conversationError) throw conversationError;
    const conversations = [...(existing ?? [])];
    for (const contactId of contactIds.filter((id) => !conversations.some((conversation) => conversation.contact_id === id))) {
      const { data: created, error } = await this.client
        .from("conversations")
        .insert({ contact_id: contactId, state: "human_active", last_message_at: message.occurredAt })
        .select("id, state, contact_id")
        .single<{ id: string; state: ConversationState; contact_id: string }>();
      if (error) throw error;
      conversations.push(created);
    }
    // History goes to the chat the message was sent in; every copy of this customer gets paused
    // (WhatsApp can list the same person under a phone id and a privacy "@lid" id).
    const exactContact = contactRows.find((row) => row.whatsapp_chat_id === message.chatId) ?? contactRows[0]!;
    const primary = conversations.find((conversation) => conversation.contact_id === exactContact.id) ?? conversations[0]!;

    const { error: insertError } = await this.client.from("messages").insert({
      conversation_id: primary.id,
      provider_message_id: message.messageId,
      direction: "outbound",
      source: "human",
      content_type: message.type,
      text_content: message.text?.trim() || (message.type === "image" ? "[photo]" : "[message]"),
      delivery_state: "sent",
      occurred_at: message.occurredAt,
    });
    // Already recorded (gateway retry): nothing more to do.
    if (insertError?.code === "23505") return { recorded: true, paused: conversations.every((conversation) => conversation.state === "human_active") };
    if (insertError) throw insertError;

    const toPause = conversations.filter((conversation) => conversation.state !== "human_active").map((conversation) => conversation.id);
    if (toPause.length) {
      const { error } = await this.client.from("conversations").update({ state: "human_active", last_message_at: message.occurredAt }).in("id", toPause);
      if (error) throw error;
    }
    await this.client
      .from("handoffs")
      .update({ accepted_at: message.occurredAt })
      .in("conversation_id", conversations.map((conversation) => conversation.id))
      .is("resolved_at", null)
      .is("accepted_at", null);
    return { recorded: true, paused: true };
  }
}

export function createSupabaseBrainRepository(url: string, serviceRoleKey: string): SupabaseBrainRepository {
  return new SupabaseBrainRepository(createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } }));
}

function mapConversation(row: { id: string; state: string; active_product_id: string | null; summary?: string | null }): ConversationContext {
  return {
    id: row.id,
    state: row.state as ConversationState,
    activeProductId: row.active_product_id,
    summary: row.summary ?? null,
  };
}
