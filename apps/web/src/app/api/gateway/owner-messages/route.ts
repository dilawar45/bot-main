import { OwnerMessageSchema } from "@huzaifa/contracts";
import { createSupabaseBrainRepository } from "@/catalog/repository";
import { getStorageEnvironment } from "@/config/env";
import { verifyGatewaySignature } from "@/security/gateway-signature";
import { readLimitedBody } from "@/security/request-body";

export const runtime = "nodejs";

// The owner typed in a customer chat on the bot's WhatsApp. Record it (the bot and the admin see the whole
// conversation) and pause the bot there: a person is now handling this customer.
export async function POST(request: Request): Promise<Response> {
  const read = await readLimitedBody(request);
  if (!read.ok) return read.response;
  let environment;
  try {
    environment = getStorageEnvironment();
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
  const parsed = OwnerMessageSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "Invalid owner message", details: parsed.error.flatten() }, { status: 400 });

  try {
    const repository = createSupabaseBrainRepository(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY);
    return Response.json(await repository.recordOwnerMessage(parsed.data));
  } catch (error) {
    console.error("Owner message recording failed", { messageId: parsed.data.messageId, error });
    return Response.json({ error: "Could not record owner message" }, { status: 500 });
  }
}
