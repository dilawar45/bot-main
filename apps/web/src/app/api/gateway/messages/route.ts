import { after } from "next/server";
import { InboundMessageSchema } from "@huzaifa/contracts";
import { processInboundMessage } from "@/agent/orchestrator";
import { createProductPhotoLoader } from "@/catalog/image-embeddings";
import { createInboundImageLoader } from "@/catalog/inbound-media";
import { createSupabaseBrainRepository } from "@/catalog/repository";
import { getAppBaseUrl, getServerEnvironment, getVisionEnvironment } from "@/config/env";
import { createSupabaseServiceClient, productImagePublicUrl } from "@/lib/supabase/service";
import { verifyGatewaySignature } from "@/security/gateway-signature";
import { readLimitedBody } from "@/security/request-body";
import { sendGatewayMessage } from "@/gateway/admin-client";
import { DEFAULT_SHOP_SETTINGS } from "@/shop/settings";
import { loadShopSettings } from "@/shop/settings-store";

export const runtime = "nodejs";
// The agent may make a few model calls; the gateway waits up to 45s.
export const maxDuration = 60;

// Replies still "sending" after this long were never picked up by the gateway.
const STALE_DELIVERY_MS = 15 * 60_000;
let lastStaleSweep = 0;

export async function POST(request: Request): Promise<Response> {
  const read = await readLimitedBody(request);
  if (!read.ok) return read.response;
  const body = read.body;
  let environment;
  try {
    environment = getServerEnvironment();
  } catch {
    return Response.json({ error: "Server configuration is invalid" }, { status: 503 });
  }

  const authenticated = verifyGatewaySignature({
    body,
    timestamp: request.headers.get("x-huzaifa-timestamp"),
    signature: request.headers.get("x-huzaifa-signature"),
    secret: environment.GATEWAY_HMAC_SECRET,
  });
  if (!authenticated) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedMessage = InboundMessageSchema.safeParse(payload);
  if (!parsedMessage.success) {
    return Response.json(
      { error: "Invalid message", details: parsedMessage.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const repository = createSupabaseBrainRepository(
      environment.NEXT_PUBLIC_SUPABASE_URL,
      environment.SUPABASE_SERVICE_ROLE_KEY,
    );
    const vision = getVisionEnvironment();
    const service = createSupabaseServiceClient();
    // Settings unreadable (and nothing cached): answer with defaults, but never take orders the owner may have
    // switched off.
    const shop = await loadShopSettings(service).catch(() => ({ ...DEFAULT_SHOP_SETTINGS, ordersEnabled: false }));
    const result = await processInboundMessage(parsedMessage.data, {
      repository,
      supportChatId: environment.SUPPORT_WA_ID,
      shop,
      publicUrl: productImagePublicUrl,
      loadImage: createInboundImageLoader(service),
      // Without a Gemini key the bot answers with rules (greetings, search, closest items, handoff).
      agent: vision.geminiKeys.length
        ? {
            apiKey: vision.geminiKeys,
            // The stronger model writes replies. When it is overloaded (503s are common at peak), the other full
            // models take over before the lite one, which writes plainer replies.
            models: [...new Set([vision.proModel, ...vision.fallbackModels, vision.fastModel])],
            summaryModels: [...new Set([vision.fastModel, ...vision.fallbackModels, vision.proModel])],
            budgetMs: 30_000,
          }
        : undefined,
      // Finds products for words the keyword search doesn't know; idle until the embeddings migration is applied.
      embeddings: vision.geminiKeys.length ? { apiKey: vision.geminiKeys, model: vision.embeddingModel } : undefined,
      // Finds the products a customer's photo shows; idle until the photo search migration is applied and the
      // product photos are indexed (that happens on its own as photos are added).
      photoSearch: vision.geminiKeys.length ? { apiKey: vision.geminiKeys, model: vision.imageEmbeddingModel } : undefined,
      loadProductImage: createProductPhotoLoader(productImagePublicUrl),
      adminBaseUrl: getAppBaseUrl(),
      defer: (task) => after(() => task().catch((error: unknown) => console.error("Deferred memory update failed", error))),
    });
    // Housekeeping after the reply, at most every 10 minutes per server instance (the daily cron is the backstop):
    // replies nobody picked up are marked failed, and owner alerts among them are sent again directly.
    if (Date.now() - lastStaleSweep > 10 * 60_000) {
      lastStaleSweep = Date.now();
      after(async () => {
        try {
          const { ownerAlerts } = await repository.markStaleDeliveriesFailed(STALE_DELIVERY_MS);
          for (const alert of ownerAlerts.slice(0, 5)) await sendGatewayMessage(environment.SUPPORT_WA_ID, `(sent again) ${alert}`);
        } catch (error) {
          console.error("Stale delivery sweep failed", error);
        }
      });
    }
    return Response.json(result);
  } catch (error) {
    console.error("Gateway message processing failed", { eventId: parsedMessage.data.eventId, error });
    return Response.json({ error: "Message processing failed" }, { status: 500 });
  }
}
