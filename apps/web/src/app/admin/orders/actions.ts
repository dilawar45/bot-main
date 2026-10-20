"use server";

import { revalidatePath } from "next/cache";
import type { PostgrestError } from "@supabase/supabase-js";
import { requireAdmin } from "@/auth/admin";
import { sendGatewayMessage } from "@/gateway/admin-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getOrder } from "@/orders/admin-queries";
import { customerUpdateText, type OrderUpdateKind } from "@/orders/notifications";
import type { ActionState } from "../products/actions";

function refresh(orderId: string) {
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin", "layout");
}

function describeRpcError(error: PostgrestError): string {
  const message = error.message ?? "";
  if (message.startsWith("insufficient_stock")) return `Not enough stock for ${message.replace(/^insufficient_stock:\s*/, "")}. Update the stock or cancel the order.`;
  if (message.startsWith("order_not_placed")) return "This order isn't waiting for confirmation any more.";
  if (message.startsWith("invalid_transition")) return "That step doesn't fit the order's current status.";
  if (message.startsWith("order_not_cancellable")) return "Delivered or already cancelled orders can't be cancelled.";
  if (message.startsWith("order_not_found")) return "Order not found.";
  if (error.code === "PGRST202") return "The database is missing the order functions. Apply migration 202609290003_orders.sql.";
  if (error.code === "42501") return "Not allowed.";
  console.error("Order update failed", { code: error.code, message });
  return "Could not update the order.";
}

// Tells the customer on WhatsApp and keeps the message in their chat history. Returns a note for the owner.
async function notifyCustomer(orderId: string, kind: OrderUpdateKind, extra?: string): Promise<{ sent: boolean; note: string }> {
  const order = await getOrder(orderId);
  if (!order?.chatId) return { sent: false, note: "The customer wasn't messaged: no WhatsApp chat found." };
  const text = customerUpdateText(kind, { number: order.number, name: order.customerName, language: order.language, extra });
  // Messages can only be written with the service role (after requireAdmin). Stored first, so history shows it.
  // Stored as the shop's automated side ("agent"), not "human": a "human" message means the owner took the chat
  // over, which would make the bot drop a reply it's preparing for this customer.
  const service = createSupabaseServiceClient();
  const { data: row } = await service
    .from("messages")
    .insert({ conversation_id: order.conversationId, direction: "outbound", source: "agent", content_type: "text", text_content: text, delivery_state: "pending", occurred_at: new Date().toISOString() })
    .select("id")
    .single<{ id: string }>();
  const result = await sendGatewayMessage(order.chatId, text);
  if (row) {
    const update = result.ok
      ? { delivery_state: "sent", provider_message_id: result.providerMessageId || null }
      : result.reason === "unsure"
        ? null
        : { delivery_state: "failed" };
    if (update) await service.from("messages").update(update).eq("id", row.id);
  }
  return result.ok ? { sent: true, note: "The customer was told on WhatsApp." } : { sent: false, note: `The customer wasn't messaged: ${result.error}` };
}

async function finish(orderId: string, done: string, notify: boolean, kind: OrderUpdateKind, extra?: string): Promise<ActionState> {
  refresh(orderId);
  if (!notify) return { message: done };
  const notified = await notifyCustomer(orderId, kind, extra);
  refresh(orderId);
  return notified.sent ? { message: `${done} ${notified.note}` } : { error: `${done} ${notified.note}` };
}

export async function confirmOrder(orderId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  // Atomic in the database: takes the stock for every line, or nothing.
  const { error } = await supabase.rpc("confirm_order", { p_order_id: orderId });
  if (error) return { error: describeRpcError(error) };
  return finish(orderId, "Order confirmed and stock taken.", formData.get("notify") === "on", "confirmed");
}

export async function markShipped(orderId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("advance_order", { p_order_id: orderId, p_status: "shipped" });
  if (error) return { error: describeRpcError(error) };
  const tracking = String(formData.get("extra") ?? "").trim();
  return finish(orderId, "Marked as shipped.", formData.get("notify") === "on", "shipped", tracking || undefined);
}

export async function markDelivered(orderId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("advance_order", { p_order_id: orderId, p_status: "delivered" });
  if (error) return { error: describeRpcError(error) };
  return finish(orderId, "Marked as delivered.", formData.get("notify") === "on", "delivered");
}

export async function cancelOrder(orderId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const reason = String(formData.get("extra") ?? "").trim().slice(0, 300);
  const supabase = await createSupabaseServerClient();
  // Gives back stock that was taken at confirmation.
  const { error } = await supabase.rpc("cancel_order", { p_order_id: orderId, p_reason: reason });
  if (error) return { error: describeRpcError(error) };
  return finish(orderId, "Order cancelled.", formData.get("notify") === "on", "cancelled", reason || undefined);
}

export async function saveOrderNote(orderId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("orders").update({ internal_note: note || null }).eq("id", orderId).select("id");
  if (error || !data?.length) return { error: "Could not save the note." };
  refresh(orderId);
  return { message: "Note saved." };
}
