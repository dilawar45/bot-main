import { randomUUID } from "node:crypto";
import { FollowUpRequestSchema, type FollowUpResponse, type OutboundAction } from "@huzaifa/contracts";
import { SupabaseBrainRepository } from "@/catalog/repository";
import { getAppBaseUrl, getServerEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { FollowUpStore } from "@/orders/followup-store";
import { fitText, planFollowUps, renderCartReminder, renderOwnerDigest, type CartCandidate, type PlacedCandidate } from "@/orders/followups";
import { verifyGatewaySignature } from "@/security/gateway-signature";
import { readLimitedBody } from "@/security/request-body";
import { loadShopSettings } from "@/shop/settings-store";

export const runtime = "nodejs";
export const maxDuration = 30;

// Replies still "sending" after this long were never picked up by the gateway.
const STALE_DELIVERY_MS = 15 * 60_000;

// The gateway calls this every few minutes while WhatsApp is connected and sends whatever comes back.
// Every follow-up is claimed in the database before it is returned, so it goes out at most once.
export async function POST(request: Request): Promise<Response> {
  const read = await readLimitedBody(request);
  if (!read.ok) return read.response;
  let environment;
  try {
    environment = getServerEnvironment();
  } catch {
    return Response.json({ error: "Server configuration is invalid" }, { status: 503 });
  }

  const authenticated = verifyGatewaySignature({
    body: read.body,
    timestamp: request.headers.get("x-huzaifa-timestamp"),
    signature: request.headers.get("x-huzaifa-signature"),
    secret: environment.GATEWAY_HMAC_SECRET,
  });
  if (!authenticated) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(read.body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!FollowUpRequestSchema.safeParse(payload).success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const client = createSupabaseServiceClient();
  const repository = new SupabaseBrainRepository(client);
  const store = new FollowUpStore(client);
  const supportChatId = environment.SUPPORT_WA_ID;
  const actions: OutboundAction[] = [];
  const text = (recipientChatId: string, body: string): OutboundAction => ({ actionId: randomUUID(), recipientChatId, type: "text", text: fitText(body) });

  // Owner alerts that never went out (the gateway was down or lost the brain's answer).
  try {
    const { ownerAlerts } = await repository.markStaleDeliveriesFailed(STALE_DELIVERY_MS);
    for (const alert of ownerAlerts.slice(0, 4)) actions.push(text(supportChatId, `(sent again) ${alert}`));
  } catch (error) {
    console.error("Stale delivery sweep failed", error);
  }

  try {
    const shop = await loadShopSettings(client);
    const now = new Date();
    const wantsCarts = shop.ordersEnabled && (shop.cartReminderMinutes !== null || shop.ownerFollowUps);
    // null: the follow-ups migration isn't applied yet, so there is nothing to track them with.
    const [carts, placed] = await Promise.all([wantsCarts ? store.loadCarts(now, { reminders: shop.cartReminderMinutes !== null, ownerAlerts: shop.ownerFollowUps }) : Promise.resolve([]), shop.ownerFollowUps ? store.loadPlacedWaiting(now) : Promise.resolve([])]);
    if (carts?.length || placed?.length) {
      const catalog = carts?.length ? await repository.loadCatalog() : [];
      const plan = planFollowUps({ now, shop, carts: carts ?? [], placed: placed ?? [], products: new Map(catalog.map((product) => [product.id, product])) });

      for (const cart of plan.reminders) {
        if (!cart.draft.summaryFingerprint || !(await store.claimReminder(cart.orderId, cart.draft.summaryFingerprint))) continue;
        const reminder = text(cart.chatId, renderCartReminder(cart));
        // Stored like any reply: it shows in the chat history (the bot sees it next turn) and gets a delivery state.
        await repository.saveActions(cart.conversationId, [reminder], cart.chatId);
        actions.push(reminder);
      }

      const cartAlerts: CartCandidate[] = [];
      for (const cart of plan.cartAlerts) if (await store.claimCartAlert(cart.orderId)) cartAlerts.push(cart);
      const confirmReminders: PlacedCandidate[] = [];
      for (const order of plan.confirmReminders) if (await store.claimConfirmReminder(order.orderId)) confirmReminders.push(order);
      const digest = renderOwnerDigest({ carts: cartAlerts, placed: confirmReminders, now, adminBaseUrl: getAppBaseUrl() });
      if (digest) actions.push(text(supportChatId, digest));
    }
  } catch (error) {
    console.error("Order follow-ups failed", error);
  }

  return Response.json({ actions } satisfies FollowUpResponse);
}
