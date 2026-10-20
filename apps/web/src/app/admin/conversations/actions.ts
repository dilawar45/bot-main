"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/auth/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import type { ActionState } from "../products/actions";

function refresh(conversationId: string) {
  revalidatePath("/admin/conversations");
  revalidatePath(`/admin/conversations/${conversationId}`);
  revalidatePath("/admin", "layout");
}

export async function resumeBot(conversationId: string): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  // Atomic in the database: resolves open handoffs and sets the chat back to bot_active.
  const { error } = await supabase.rpc("resume_bot", { p_conversation_id: conversationId });
  if (error) {
    console.error("Resume bot failed", { conversationId, code: error.code, message: error.message });
    return { error: error.code === "PGRST202" ? "Database is missing the resume_bot function. Apply the latest migration." : "Could not resume the bot." };
  }
  refresh(conversationId);
  return { message: "Bot resumed. It will answer this customer's next message." };
}

export async function saveInternalNote(conversationId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("conversations")
    .update({ internal_note: note || null })
    .eq("id", conversationId)
    .select("id");
  if (error || !data?.length) {
    return { error: error?.code === "42703" ? "Database is missing the note column. Apply the latest migration." : "Could not save the note." };
  }
  refresh(conversationId);
  return { message: "Note saved." };
}

export async function setLeadStatus(conversationId: string, leadId: string, status: "new" | "contacted" | "closed"): Promise<ActionState> {
  await requireAdmin();
  if (!["new", "contacted", "closed"].includes(status)) return { error: "Unknown status." };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("leads").update({ status }).eq("id", leadId).eq("conversation_id", conversationId).select("id");
  if (error || !data?.length) return { error: "Could not update the lead." };
  refresh(conversationId);
  return { message: `Lead marked ${status}.` };
}

// Privacy request: remove everything we hold about one customer. Deleting the contact cascades to
// conversations, messages, leads, handoffs and agent runs; their private photos are removed from storage first.
export async function deleteCustomerData(conversationId: string): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { data: conversation } = await supabase.from("conversations").select("contact_id").eq("id", conversationId).maybeSingle<{ contact_id: string }>();
  if (!conversation) return { error: "Conversation not found." };

  // Admin RLS allows reading but not deleting contacts, so the delete itself uses the service role after requireAdmin.
  const service = createSupabaseServiceClient();
  // Deleting the customer deletes their orders too: open ones would vanish with their stock still taken.
  const { data: openOrders, error: ordersError } = await service
    .from("orders")
    .select("order_number")
    .eq("contact_id", conversation.contact_id)
    .in("status", ["placed", "confirmed", "shipped"]);
  if (!ordersError && openOrders?.length) {
    return { error: `This customer has open orders (${openOrders.map((order) => `#${order.order_number}`).join(", ")}). Deliver or cancel them first.` };
  }
  const { data: conversations } = await service.from("conversations").select("id").eq("contact_id", conversation.contact_id);
  const conversationIds = (conversations ?? []).map((row) => row.id as string);
  const { data: media } = await service
    .from("messages")
    .select("media_path")
    .in("conversation_id", conversationIds)
    .eq("direction", "inbound")
    .not("media_path", "is", null);
  const paths = (media ?? []).map((row) => row.media_path as string);
  if (paths.length) {
    const { error: storageError } = await service.storage.from("inbound-media").remove(paths);
    if (storageError) return { error: "Could not delete the customer's photos. Nothing was removed." };
  }

  const { error } = await service.from("contacts").delete().eq("id", conversation.contact_id);
  if (error) return { error: "Photos were removed, but deleting the records failed. Try again." };

  revalidatePath("/admin/conversations");
  revalidatePath("/admin", "layout");
  redirect("/admin/conversations?deleted=1");
}
